/**
 * 媒体流 IndexedDB 字节缓存（v2 重写）。
 *
 * 缓存已下载的媒体字节区间，避免同一视频在刷新页面后重复下载
 * init segment、sidx 等固定内容。
 *
 * 相比 v1 的改进：
 * - 覆盖式范围查询：缓存条目完全覆盖请求区间即命中（支持返回子切片），
 *   例如已缓存 0..512KB 的 head，后续请求 0..256KB 也能命中；
 * - LRU 淘汰：缓存总量超过 MAX_CACHE_BYTES 时按 lastAccess 升序淘汰；
 * - TTL：条目超过 TTL_MS 视为未命中并惰性删除；
 * - 单 store 字符串主键 + byUrl 索引，覆盖匹配无需全表扫描。
 *
 * 缓存 key 使用规范化 URL（去除 B站 等易变查询参数），使同一视频在不同会话中
 * 仍能命中缓存。缓存失败永不中断播放（所有异常就地吞掉并告警）。
 */

const DB_NAME = 'zcontrol-stream-cache'
const STORE_NAME = 'ranges'
/** v2：主键由复合键改为字符串 key + 索引，旧数据直接废弃重建 */
const DB_VERSION = 2

/** 缓存总容量上限（超出后按 LRU 淘汰） */
const MAX_CACHE_BYTES = 256 * 1024 * 1024
/** 条目存活期（过期不命中） */
const TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 单次淘汰批量（避免长事务阻塞播放） */
const EVICT_BATCH = 32

/** B站 CDN 等 URL 中易变、不影响资源标识的查询参数 */
const MUTABLE_PARAMS = [
  'e',
  'deadline',
  'trid',
  'upsig',
  'uparams',
  'nbs',
  'oi',
  'mid',
  'gen',
  'os',
  'buvid',
  'qn_dyeid',
  'agrr',
  'build',
  'dl',
  'orderid',
  'platform',
  'uipk',
  'bw',
  'lrs',
  'f',
  'nettype',
]

/**
 * 规范化媒体 URL：去除容易变化的查询参数（如 deadline, trid, upsig 等），
 * 仅保留能标识同一媒体资源的部分。
 */
export function normalizeMediaUrl(url: string): string {
  try {
    const u = new URL(url)
    MUTABLE_PARAMS.forEach((p) => u.searchParams.delete(p))
    return u.toString()
  } catch {
    return url
  }
}

/** 缓存条目（IndexedDB 存储结构）。 */
interface CacheEntry {
  /** 主键：`${normalizedUrl}|${startByte}|${endByte}` */
  key: string
  /** 规范化后的 URL（byUrl 索引） */
  url: string
  startByte: number
  endByte: number
  data: ArrayBuffer
  /** 文件总大小（来自 Content-Range），head 缓存需要用到 */
  totalSize: number | null
  /** 创建时间（TTL 判定） */
  createdAt: number
  /** 最近访问时间（LRU 判定） */
  lastAccess: number
}

/** 缓存读取结果。 */
export interface CachedRange {
  data: Uint8Array
  totalSize: number | null
}

function makeKey(normalizedUrl: string, startByte: number, endByte: number): string {
  return `${normalizedUrl}|${startByte}|${endByte}`
}

// ── IndexedDB 基础设施 ─────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      // v1 → v2：主键结构变化，旧 store 直接删除重建（缓存可丢弃）
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME)
      }
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      store.createIndex('byUrl', 'url', { unique: false })
      store.createIndex('byAccess', 'lastAccess', { unique: false })
    }
  })
  // 打开失败后允许下次重试
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
  })
}

/** 更新条目的 lastAccess（不影响主流程，失败静默）。 */
function touchEntry(store: IDBObjectStore, entry: CacheEntry): void {
  entry.lastAccess = Date.now()
  store.put(entry)
}

/** 删除过期/超限条目：按 lastAccess 升序淘汰，直到总量低于上限。 */
async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  const now = Date.now()

  // 先删过期条目，同时统计存活条目的总大小
  let totalBytes = 0
  const survivors: { key: string; lastAccess: number; size: number }[] = []
  const expiredKeys: string[] = []

  await new Promise<void>((resolve, reject) => {
    const cursorReq = store.openCursor()
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) return resolve()
      const entry = cursor.value as CacheEntry
      const size = entry.endByte - entry.startByte + 1
      if (now - entry.createdAt > TTL_MS) {
        expiredKeys.push(entry.key)
      } else {
        survivors.push({ key: entry.key, lastAccess: entry.lastAccess, size })
        totalBytes += size
      }
      cursor.continue()
    }
    cursorReq.onerror = () => reject(cursorReq.error)
  })

  for (const key of expiredKeys) {
    store.delete(key)
  }

  // 超限 → LRU 淘汰
  if (totalBytes > MAX_CACHE_BYTES) {
    survivors.sort((a, b) => a.lastAccess - b.lastAccess)
    let deleted = 0
    for (const s of survivors) {
      if (totalBytes <= MAX_CACHE_BYTES || deleted >= EVICT_BATCH * 4) break
      store.delete(s.key)
      totalBytes -= s.size
      deleted += 1
    }
  }

  await txDone(tx)
}

// ── 公共 API ─────────────────────────────────────────

/**
 * 缓存指定字节范围的数据。
 *
 * @param totalSize 可选文件总大小，用于构造正确的 Content-Range
 */
export async function cacheRange(
  url: string,
  startByte: number,
  data: Uint8Array,
  totalSize?: number | null
): Promise<void> {
  if (data.byteLength === 0) return
  try {
    const db = await openDB()
    const normalized = normalizeMediaUrl(url)
    const endByte = startByte + data.byteLength - 1
    const now = Date.now()
    const entry: CacheEntry = {
      key: makeKey(normalized, startByte, endByte),
      url: normalized,
      startByte,
      endByte,
      data: data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer,
      totalSize: totalSize ?? null,
      createdAt: now,
      lastAccess: now,
    }
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(entry)
    await txDone(tx)
    // 淘汰检查放后台，不阻塞下载主流程
    void evictIfNeeded(db).catch(() => {})
  } catch (err) {
    // 缓存失败不应中断播放
    console.warn('[stream-cache] 缓存写入失败:', err)
  }
}

/**
 * 获取指定字节范围的缓存数据。
 *
 * 命中规则（按优先级）：
 * 1. 精确匹配：存在 [startByte, endByte] 完全一致的条目；
 * 2. 覆盖匹配：存在 start <= startByte 且 end >= endByte 的条目，返回对应子切片。
 *
 * @returns 命中返回 CachedRange，未命中返回 null
 */
export async function getCachedRange(
  url: string,
  startByte: number,
  endByte: number
): Promise<CachedRange | null> {
  try {
    const db = await openDB()
    const normalized = normalizeMediaUrl(url)
    const now = Date.now()

    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)

    // 1. 精确匹配
    const exact = (await requestToPromise(
      store.get(makeKey(normalized, startByte, endByte))
    )) as CacheEntry | undefined
    if (exact?.data && now - exact.createdAt <= TTL_MS) {
      touchEntry(store, exact)
      await txDone(tx)
      return { data: new Uint8Array(exact.data), totalSize: exact.totalSize }
    }

    // 2. 覆盖匹配（同 url 条目通常很少，逐个检查可接受）
    const entries = (await requestToPromise(
      store.index('byUrl').getAll(normalized)
    )) as CacheEntry[]
    const covering = entries.find(
      (e) =>
        e.startByte <= startByte &&
        e.endByte >= endByte &&
        now - e.createdAt <= TTL_MS
    )
    if (!covering) {
      await txDone(tx).catch(() => {})
      return null
    }

    const sliceStart = startByte - covering.startByte
    const sliceEnd = sliceStart + (endByte - startByte + 1)
    const data = new Uint8Array(covering.data.slice(sliceStart, sliceEnd))
    touchEntry(store, covering)
    await txDone(tx)
    return { data, totalSize: covering.totalSize }
  } catch (err) {
    console.warn('[stream-cache] 缓存读取失败:', err)
    return null
  }
}
