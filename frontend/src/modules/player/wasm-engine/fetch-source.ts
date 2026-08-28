/**
 * wasm-engine 的媒体字节读取器。
 *
 * 能力：
 * - Range 起始位置（seek 续传）
 * - 直连失败时回退服务器代理（与 direct-engine 相同的策略链）
 * - 断流自动重试（网络抖动下从断点续传）
 *
 * 代理策略与 url-proxy.ts 对齐：本站/相对路径直接请求；跨域直连失败
 * （CORS / 防盗链）时改走 buildProxyUrl 的服务器中转重试。
 */
import {
  resolveProxyUrl,
  buildProxyUrl,
  isLocalUrl,
  isRelativeUrl,
} from '@/modules/player/services/url-proxy'

const MAX_RETRY_PER_STREAM = 8
const RETRY_DELAY_MS = 800
/** 假 EOS（响应体提前结束）最大续传次数；超出视为源不可用 */
const MAX_PREMATURE_EOS = 64
/**
 * 聚合输出的最小块大小（首块直通除外）。
 *
 * Firefox 的 fetch ReadableStream 以小 chunk（8-64KB）交付网络数据，
 * Chrome 通常 64KB-1MB+。demuxer.append 每次调用都要拷贝未消费 buffer
 * 并跑一遍 EBML 解析——小 chunk 逐块 append 在 GB 级文件上会产生数十
 * 万次小解析调用，未消费 buffer 又大，形成 O(n²) 拷贝爆炸，下载管线
 * 被 CPU 拖死（Chrome 无此问题的原因即 chunk 天然够大）。聚合到该
 * 水位再返回可把 append 次数降低一个数量级以上。
 */
const MIN_READ_BATCH_BYTES = 512 * 1024

/** 拼接聚合块（单块时零拷贝直接返回） */
function concatParts(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

/** 可回退代理的 URL 判定（与 direct-engine canFallbackToProxy 相同语义） */
function canFallbackToProxy(url: string): boolean {
  if (!url) return false
  if (isLocalUrl(url) || isRelativeUrl(url)) return false
  if (url.includes('/api/stream/proxy')) return false
  return true
}

export interface ByteSourceOptions {
  /** 防盗链 headers（源要求时随 URL 一并交给代理） */
  headers?: Record<string, string>
  /** seek 后的续传起点（文件绝对偏移） */
  startOffset?: number
  /** 进度/错误日志前缀 */
  logTag?: string
}

export class StreamEndedError extends Error {}
export class StreamFatalError extends Error {}

interface ActiveStream {
  url: string
  offset: number // 当前读到的绝对偏移
  reader: ReadableStreamDefaultReader<Uint8Array>
  /** 响应声明的文件总长度（字节）；Range 响应取 Content-Range，全程取 Content-Length */
  contentLength: number | null
}

/**
 * 顺序字节源：从 startOffset 开始按序产出文件字节。
 * 网络中断时内部续传；上层 stop() 时中止。
 */
export class MediaByteSource {
  private sourceUrl: string
  private headers?: Record<string, string>
  private fallbackTried = false
  private active: ActiveStream | null = null
  private stopped = false
  /** 假 EOS 续传累计次数（防无限循环） */
  private prematureEosCount = 0
  /** 下次打开连接的起始偏移 */
  private pendingOffset: number
  /** 首块是否已直通返回（EBML 头/Tracks 需尽快解析，不凑批） */
  private firstChunkServed = false

  constructor(url: string, opts: ByteSourceOptions = {}) {
    this.sourceUrl = url
    this.headers = opts.headers
    this.pendingOffset = opts.startOffset ?? 0
  }

  /**
   * 打开初始连接。与后续读取共用直连→代理回退逻辑；
   * 直接构造后调用 read() 即可，无需显式 open。
   */
  private async openAt(offset: number): Promise<void> {
    const primary = resolveProxyUrl(this.sourceUrl, this.headers, 'mkv')
    try {
      await this.openWith(primary, offset)
      return
    } catch (err) {
      if (this.stopped) throw new StreamEndedError('stopped')
      if (!canFallbackToProxy(this.sourceUrl) || this.fallbackTried) {
        throw new StreamFatalError(
          `媒体流打开失败: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      this.fallbackTried = true
      console.warn('[wasm-engine] 直连失败，回退服务器代理:', err)
      await this.openWith(buildProxyUrl(this.sourceUrl), offset)
    }
  }

  private async openWith(url: string, offset: number): Promise<void> {
    const rangeHeader =
      offset > 0
        ? { ...(this.headers ?? {}), Range: `bytes=${offset}-` }
        : this.headers
    const res = await fetch(url, { headers: rangeHeader })
    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status}`)
    }
    const body = res.body
    if (!body) throw new Error('响应无 body')
    // 418/200 全量等场景不做特判——服务器不支持 Range 时会返回 200，
    // 偏移非 0 则数据错位，此时直接报错（很少见：中转端点均支持 Range）
    if (offset > 0 && res.status === 200 && !res.headers.get('content-range')) {
      throw new StreamFatalError('源不支持 Range 续传')
    }
    // 解析文件总长度：Range 响应从 Content-Range（bytes a-b/total）取，
    // 全程响应取 Content-Length。用于 EOS 校验（防提前断流被误判 EOF）
    let contentLength: number | null = null
    const contentRange = res.headers.get('content-range')
    if (contentRange) {
      const total = contentRange.split('/')[1]
      const n = total ? parseInt(total, 10) : NaN
      if (Number.isFinite(n)) contentLength = n
    }
    if (contentLength == null) {
      const len = res.headers.get('content-length')
      const n = len ? parseInt(len, 10) : NaN
      if (Number.isFinite(n)) contentLength = n
    }
    this.active = {
      url,
      offset,
      reader: body.getReader() as ReadableStreamDefaultReader<Uint8Array>,
      contentLength,
    }
  }

  /**
   * 产出下一块数据；流结束时抛 StreamEndedError。
   *
   * 聚合输出：底层小 chunk 累积到 MIN_READ_BATCH_BYTES 才返回（见常量
   * 注释——Firefox 小 chunk 直传会导致 demuxer O(n²) 拷贝爆炸）；首块
   * 直通，保证 EBML 头/Tracks 尽快解析出首帧。假 EOS / 网络中断重连
   * 期间已聚合的 parts 保留在闭包中续用，数据不丢、偏移不重不漏。
   */
  async read(): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    let partsBytes = 0
    for (let retry = 0; ; retry++) {
      if (this.stopped) throw new StreamEndedError('stopped')
      if (!this.active) await this.openAt(this.pendingOffset)

      const stream = this.active!
      try {
        const { done, value } = await stream.reader.read()
        if (done) {
          // 假 EOS 校验：响应体提前结束（代理超时、上游掐断等会造成
          // reader 正常 done 但数据没传完）。若此时读到的偏移远小于
          // 声明的总长度，绝不能误判为文件结束——那会让上层管线
          // 直接 finalize，之后永远不再加载数据，播放到缓冲尽头卡死。
          // 必须从断点重连续传。
          const cl = stream.contentLength
          if (cl != null && stream.offset < cl - 4096) {
            if (this.prematureEosCount >= MAX_PREMATURE_EOS) {
              throw new StreamFatalError(
                `响应体多次提前结束（读到 ${stream.offset}/${cl} 字节），放弃续传`
              )
            }
            this.prematureEosCount++
            console.warn(
              `[wasm-engine] 响应体提前结束（读到 ${stream.offset}/${cl} 字节），从断点续传`
            )
            void stream.reader.cancel().catch(() => undefined)
            this.active = null
            this.pendingOffset = stream.offset
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
            // 重连复用上次成功的 URL：openAt 会因 fallbackTried 不允许
            // 二次代理回退，直连失败场景下重连代理 URL 才是正确路径
            await this.openWith(stream.url, stream.offset)
            // 假 EOS 重连几乎总能成功推进，不算读取失败：重置重试计数
            retry = -1
            continue
          }
          // 真 EOS：先吐出已聚合的数据（若有），下次调用再抛结束
          if (partsBytes > 0) return concatParts(parts)
          throw new StreamEndedError('eos')
        }
        parts.push(value)
        partsBytes += value.byteLength
        stream.offset += value.byteLength
        if (
          !this.firstChunkServed ||
          partsBytes >= MIN_READ_BATCH_BYTES
        ) {
          this.firstChunkServed = true
          return concatParts(parts)
        }
      } catch (err) {
        if (err instanceof StreamEndedError || err instanceof StreamFatalError)
          throw err
        if (retry >= MAX_RETRY_PER_STREAM) {
          throw new StreamFatalError(`媒体流读取连续失败: ${String(err)}`)
        }
        console.warn(
          `[wasm-engine] 流读取中断，${RETRY_DELAY_MS}ms 后从 ${stream.offset} 续传`,
          err
        )
        void stream.reader.cancel().catch(() => undefined)
        this.active = null
        this.pendingOffset = stream.offset
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }
  }

  abort(): void {
    this.stopped = true
    if (this.active) {
      void this.active.reader.cancel().catch(() => undefined)
      this.active = null
    }
  }
}

/** 用 HEAD 请求获取总大小（失败返回 null） */
export async function probeContentLength(
  url: string,
  headers?: Record<string, string>
): Promise<number | null> {
  try {
    const target = resolveProxyUrl(url, headers, 'mkv')
    const res = await fetch(target, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    })
    const len = res.headers.get('Content-Length')
    return len ? parseInt(len, 10) : null
  } catch {
    return null
  }
}
