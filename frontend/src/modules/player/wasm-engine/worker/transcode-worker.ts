/**
 * 音频转码 Worker：ffmpeg.wasm（单线程 core）解码不支持的音轨 → PCM。
 *
 * 协议（postMessage）：
 *   入 { type:'load' }                          预加载 wasm 核心（幂等）
 *   入 { type:'decode', id, data }              data = 拼接好的 DTS/AC3 裸流
 *   出 { type:'loaded' }
 *   出 { type:'core-progress', part, loaded, total }
 *       核心文件下载进度：part 'wasm'|'js'，loaded/total 字节数
 *       （total 可能为 null——服务器未回 Content-Length）
 *   出 { type:'decoded', id, adts }             AAC ADTS 流（transfer 零拷贝）
 *   出 { type:'error', message, id? }
 *
 * 实现说明：
 * 不使用 @ffmpeg/ffmpeg 壳层——其内置 module worker 对 Blob URL 上的
 * UMD core 做 `import(...).default`，而 UMD 无 default 导出，必然抛
 * "failed to import ffmpeg-core.js"。这里自行加载 core 脚本：
 * 取回文本、追加 `export default` 包装成 ESM 经 Blob URL 导入（经典与
 * module worker 通用；module worker 禁用 importScripts，不能走脚本注入）。
 * wasm 二进制流式下载上报进度后经 wasmBinary 注入实例。
 */
const CORE_BASE_URL = '/ffmpeg'

interface CoreModule {
  (
    opts?: Record<string, unknown>
  ): Promise<FfmpegCoreInstance> | FfmpegCoreInstance
}

interface FfmpegCoreInstance {
  FS: {
    writeFile(name: string, data: Uint8Array): void
    readFile(name: string): Uint8Array
    unlink(name: string): void
  }
  exec(...args: string[]): number
  setLogger(cb: (data: { type: string; message: string }) => void): void
  setTimeout(ms: number): void
}

let corePromise: Promise<FfmpegCoreInstance> | null = null

/** 流式下载并聚合字节，按节流间隔上报进度 */
async function fetchWithProgress(
  url: string,
  part: 'wasm' | 'js',
  onProgress: (
    part: 'wasm' | 'js',
    loaded: number,
    total: number | null
  ) => void
): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载 ${url} 失败：HTTP ${res.status}`)
  const totalHeader = res.headers.get('Content-Length')
  const total = totalHeader ? parseInt(totalHeader, 10) : null
  if (!res.body) {
    return res.arrayBuffer()
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let lastReport = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    const now = Date.now()
    // 100ms 节流：避免 postMessage 风暴
    if (now - lastReport > 100) {
      lastReport = now
      onProgress(part, received, total)
    }
  }
  onProgress(part, received, total ?? received)
  const merged = new Uint8Array(received)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.byteLength
  }
  return merged.buffer
}

/** 加载并实例化 ffmpeg core（幂等），下载过程经 onCoreProgress 上报 */
function ensureCore(): Promise<FfmpegCoreInstance> {
  if (corePromise) return corePromise
  corePromise = (async () => {
    const report = (
      part: 'wasm' | 'js',
      loaded: number,
      total: number | null
    ) => self.postMessage({ type: 'core-progress', part, loaded, total })

    // wasm 二进制（约 31MB）流式下载 + 进度上报；js 垫片很小（约 110KB）
    const [wasmBytes, coreJsText] = await Promise.all([
      fetchWithProgress(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'wasm', report),
      fetchWithProgress(`${CORE_BASE_URL}/ffmpeg-core.js`, 'js', report),
    ])

    const factory = await importCoreFactory(
      new TextDecoder().decode(coreJsText)
    )

    const inst = (await factory({
      // 直接注入预取的 wasm 字节，避免 emscripten 内部再 fetch（相对路径易错）
      wasmBinary: wasmBytes,
      locateFile: (p: string) =>
        p.endsWith('.wasm')
          ? `${CORE_BASE_URL}/ffmpeg-core.wasm`
          : `${CORE_BASE_URL}/${p}`,
    })) as FfmpegCoreInstance

    inst.setLogger((d) => {
      if (
        d.type === 'stderr' &&
        d.message &&
        !d.message.startsWith('Aborted')
      ) {
        console.debug('[ffmpeg.wasm]', d.message)
      }
    })
    return inst
  })()
  return corePromise
}

/**
 * 将 UMD 格式的 core.js 包装为合法 ESM 后动态 import。
 *
 * 不能用 importScripts：module worker（Vite 构建产物）中该函数存在但调用
 * 必抛 "Module scripts don't support importScripts()"。而直接 import UMD
 * 文件又拿不到导出（无 export 语句）。做法：以模块语义重新解释 UMD——
 * UMD 尾部的 `typeof exports === 'object'` 与 `typeof define === 'function'`
 * 分支在模块作用域下均不成立，顶层 `var createFFmpegCore` 留在模块命名
 * 空间里；给文本追加一行 `export default createFFmpegCore` 再经 Blob URL
 * 导入，即可稳定取到工厂函数。适用于经典与 module 两类 worker。
 */
async function importCoreFactory(coreJsText: string): Promise<CoreModule> {
  const blobUrl = URL.createObjectURL(
    new Blob([coreJsText, '\nexport default createFFmpegCore;\n'], {
      type: 'text/javascript',
    })
  )
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as Record<
      string,
      unknown
    >
    const fn =
      (mod.default as CoreModule | undefined) ??
      (mod.createFFmpegCore as CoreModule | undefined)
    if (typeof fn !== 'function') {
      throw new Error('core.js 中未找到 createFFmpegCore 工厂函数')
    }
    return fn
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

async function load(): Promise<void> {
  await ensureCore()
}

/** 解码一批裸音频流并直接编码为 AAC（ADTS 流）。
 *
 * 不走「解码 PCM → 主线程 WebCodecs 编 AAC」两段式：部分 Chromium
 * 构建（内嵌浏览器/无专有编解码器的发行版）AudioEncoder('mp4a.40.2')
 * 抛 NotSupportedError。ffmpeg.wasm 内自带原生 AAC 编码器，一条命令
 * 同时完成解码与编码，兼容性最好。
 */
async function decode(id: number, data: ArrayBuffer): Promise<void> {
  const ff = await ensureCore()
  try {
    ff.FS.writeFile('in.audio', new Uint8Array(data))
  } catch {
    // 上一次 exec 异常退出可能留下半写入文件；清理后重试一次
    try {
      ff.FS.unlink('in.audio')
    } catch {
      /* ignore */
    }
    ff.FS.writeFile('in.audio', new Uint8Array(data))
  }
  let code: number
  try {
    code = ff.exec(
      '-i',
      'in.audio',
      '-map',
      '0:a:0?',
      '-ac',
      '2',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-f',
      'adts',
      'out.aac'
    )
  } catch (err) {
    // err 多为 emscripten abort（已含信息），直接续抛保留 cause 链
    throw err instanceof Error
      ? err
      : new Error(`ffmpeg exec 异常: ${String(err)}`)
  }
  let outData: Uint8Array
  try {
    outData = ff.FS.readFile('out.aac')
    ff.FS.unlink('out.aac')
  } catch {
    throw new Error(`ffmpeg 转码失败（退出码 ${code}），无输出`)
  } finally {
    try {
      ff.FS.unlink('in.audio')
    } catch {
      /* ignore */
    }
  }
  if (outData.byteLength === 0) {
    throw new Error('ffmpeg 转码无输出（该批次可能无有效音频帧）')
  }

  // 显式复制到新建 Uint8Array：FS.readFile 返回 wasm 堆视图，其原型属于
  // Emscripten 内部 realm；直接 transfer 底层 buffer 会把整个 wasm 堆
  // detach 掉（核心当场报废），必须复制后再转移副本。
  const outCopy = new Uint8Array(outData.byteLength)
  outCopy.set(outData)

  self.postMessage(
    { type: 'decoded', id, adts: outCopy },
    {
      transfer: [outCopy.buffer],
    }
  )
}

self.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as
    { type: 'load' } | { type: 'decode'; id: number; data: ArrayBuffer }
  if (msg.type === 'load') {
    load()
      .then(() => self.postMessage({ type: 'loaded' }))
      .catch((err: unknown) =>
        self.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      )
    return
  }
  if (msg.type === 'decode') {
    // 直接执行：decode 内部 await ensureCore()，核心未就绪时会自动等待
    // 而非丢弃请求。此前拒绝未加载期的 decode 导致影片开头几十秒音轨
    // 批次全部丢失（黑屏期的一环）。
    // 无需手动串行化：core.exec 同步阻塞 worker 线程，事件循环天然排队。
    decode(msg.id, msg.data).catch((err: unknown) =>
      self.postMessage({
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      })
    )
  }
})

export {}
