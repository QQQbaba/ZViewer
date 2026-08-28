/**
 * WasmPlayer：ffmpeg.wasm 音频转码播放控制器（v2 双轨分离架构）。
 *
 * 管线（每次从某个字节偏移开始的顺序下载构成一个「流水线世代」）：
 *
 *   MediaByteSource(Range 续传)
 *     → MatroskaDemuxer（渐进 EBML 解析）
 *         ├─ 视频帧 → GOP 缓冲 → video muxer(单轨) → SourceBuffer[video]
 *         ├─ AAC 音轨 ─────────────────────→ audio muxer(单轨) → SourceBuffer[audio]
 *         └─ 其余音轨(DTS/AC3…) → ≈6s 批 → Worker ffmpeg.wasm → AAC(ADTS)
 *               → 剥 ADTS 头 → audio muxer → SourceBuffer[audio]
 *
 * v2 架构原则（相对 v1 单 muxer 双轨混装的简化）：
 * 1. 音视频彻底分离：两个独立单轨 muxer + 两个 SourceBuffer，同步交给
 *    MSE 渲染器按时间戳自动对齐，管线内零同步代码。v1 的 mp4-muxer
 *    交错闸门要求视频 DTS 不超前音频写入前沿，为此引入的 GOP 前沿门控
 *    /尾批冲刷/EOF 排空互相纠缠，派生了「前沿倒退卡死」「尾批真空」
 *    「EOF 截断」等一整族 bug——双轨分离后这些问题在结构上不复存在。
 * 2. 全链路使用 MKV 绝对毫秒时间戳，每世代锚点（Cluster 时间码）通过
 *    SourceBuffer.timestampOffset 平移回「影片绝对秒」。
 * 3. audio muxer 延迟到首个 AAC 样本到达时创建——采样率/ASC 此刻才
 *    精确已知（源轨参数与实际输出可能错配）。
 * 4. seek：buffered 内直接设 currentTime；范围外保存 Cluster 索引，
 *    销毁 SB 后从最近 Cluster 偏移 Range 重连重建（世代令牌防交错）。
 *
 * 注：不使用 WebCodecs AudioEncoder——部分 Chromium 构建缺少专有
 * AAC 编码器会抛 NotSupportedError；ffmpeg.wasm 内置原生编码器无此问题。
 */
import {
  MatroskaDemuxer,
  type DemuxedTrack,
  type DemuxedFrame,
} from './demuxer/matroska-demuxer'
import { MediaByteSource, StreamEndedError } from './fetch-source'
import { Muxer, StreamTarget } from 'mp4-muxer'
import { notifyWasmCoreProgress } from './core-progress-store'

/** 批量送 wasm 解码的目标时长 / 字节上限 */
const BATCH_DURATION_MS = 6000
/** 首个音频批次的窗口：缩短以尽快出声，后续批次恢复 BATCH_DURATION_MS 摊薄转码调用开销 */
const FIRST_AUDIO_BATCH_MS = 1500
const BATCH_MAX_BYTES = 8 * 1024 * 1024
/** B 帧重排缓冲上限（按 60fps ≈ 1s 容量；超过则强制收窗防内存膨胀） */
const VIDEO_REORDER_MAX = 64
/** 启动缓冲到该水位即认为可播 */
const INITIAL_BUFFER_SEC = 6
/** lookahead：缓冲超出播放点该秒数即暂停拉流 */
const LOOKAHEAD_SEC = 60
/** MSE 缓冲尾部驱逐阈值（须与播放点保持足够余量，贴太近会掐断解码队列） */
const BACK_BUFFER_SEC = 45
/** 解码错误恢复时每次跳过的秒数（越过可疑 GOP） */
const RECOVERY_JUMP_SEC = 10

// ---------- 转码 worker 模块级单例 ----------
// 每次 attach 都会创建全新 WasmPlayer，若 worker 随实例销毁（terminate），
// 已下载并编译好的 32MB wasm 核心全部作废——切换/重载影片就要重新下载
// 与编译。worker 提升为模块级单例：实例销毁只注销消息路由，核心整个
// 页面会话内复用（跨刷新由 /ffmpeg 强缓存 immutable 头兜底）。

type WasmWorkerMessage =
  | { type: 'loaded' }
  | {
      type: 'core-progress'
      part: 'wasm' | 'js'
      loaded: number
      total: number | null
    }
  | { type: 'decoded'; id: number; adts: Uint8Array }
  | { type: 'error'; id?: number; message: string }

let sharedWorker: Worker | null = null
let sharedCoreLoaded = false
let activeWorkerHandler: ((msg: WasmWorkerMessage) => void) | null = null

/** 获取共享 worker；首次调用时创建并触发核心加载 */
function acquireSharedWorker(
  onMessage: (msg: WasmWorkerMessage) => void
): Worker {
  activeWorkerHandler = onMessage
  if (sharedWorker) {
    // 核心已就绪时补发 loaded：新实例立即清掉残留的进度 UI
    if (sharedCoreLoaded) onMessage({ type: 'loaded' })
    return sharedWorker
  }
  const w = new Worker(
    new URL('./worker/transcode-worker.ts', import.meta.url),
    { type: 'module' }
  )
  w.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as WasmWorkerMessage
    if (msg.type === 'loaded') sharedCoreLoaded = true
    activeWorkerHandler?.(msg)
  })
  w.postMessage({ type: 'load' })
  sharedWorker = w
  return w
}

/** 注销当前实例的消息路由（不 terminate，核心保留复用） */
function releaseSharedWorker(
  onMessage: (msg: WasmWorkerMessage) => void
): void {
  if (activeWorkerHandler === onMessage) activeWorkerHandler = null
}

/** 核心加载失败等致命场景：销毁共享 worker，下次 attach 重新加载 */
function destroySharedWorker(): void {
  sharedWorker?.terminate()
  sharedWorker = null
  sharedCoreLoaded = false
}

export interface WasmPlayerOptions {
  video: HTMLVideoElement
  sourceUrl: string
  headers?: Record<string, string>
  /** 总时长兜底（来自影片元数据，秒） */
  fallbackDurationSec?: number
  onFatal: (err: Error) => void
}

interface AudioBatch {
  id: number
  frames: Uint8Array[]
  startMs: number
}

/**
 * 单轨封装+写入通道（video / audio 各一条）。
 * muxer 的分片经 onData 进入本通道的串行 append 链写入 SourceBuffer。
 */
interface Channel {
  mime: string
  muxer: Muxer<StreamTarget> | null
  sb: SourceBuffer | null
  /** 本通道的串行 append 链（SourceBuffer 不允许并发 update） */
  chain: Promise<void>
  /** 在途 append 数；EOF 排空用 */
  busyDepth: number
  /** timestampOffset 是否已按本世代锚点设置 */
  offsetApplied: boolean
  finalized: boolean
  appendCount: number
  appendedBytes: number
}

function makeChannel(mime: string): Channel {
  return {
    mime,
    muxer: null,
    sb: null,
    chain: Promise.resolve(),
    busyDepth: 0,
    offsetApplied: false,
    finalized: false,
    appendCount: 0,
    appendedBytes: 0,
  }
}

export class WasmPlayer {
  private video: HTMLVideoElement
  private sourceUrl: string
  private headers?: Record<string, string>
  private fallbackDurationSec?: number
  private onFatal: (err: Error) => void

  private mse: MediaSource | null = null
  private objectUrl: string | null = null
  private videoCh = makeChannel('video/mp4; codecs="avc1.640029"')
  private audioCh = makeChannel('audio/mp4; codecs="mp4a.40.2"')

  private byteSource: MediaByteSource | null = null
  private demuxer: MatroskaDemuxer | null = null
  /** 流水线世代：start/rebuild 递增，被取代的旧世代静默退出 */
  private pipelineGen = 0
  /** 写入世代令牌：rebuild 递增后，旧世代残余的排队写入直接丢弃 */
  private appendGen = 0

  private tracks: DemuxedTrack[] = []
  private videoTrack: DemuxedTrack | null = null
  private audioTrack: DemuxedTrack | null = null
  private structureReady = false

  /** GOP 缓冲（块序 = 解码顺序） */
  private pendingVideo: DemuxedFrame[] = []
  private audioBatch: {
    frames: Uint8Array[]
    bytes: number
    startMs: number
  } | null = null
  private audioBatchSeq = 0
  private batchRegistry = new Map<number, AudioBatch>()

  private worker: Worker | null = null
  private ascDescription: Uint8Array | null = null
  /** ASC 构造时从 ADTS 头解出的实际 AAC 采样率 */
  private ascSampleRate: number | null = null

  private durationSec: number | null = null
  private eofReached = false
  parsingPaused = false

  private lastKnownClusterTsMs = 0
  /** 索引追赶目标（ms）：非空时不允许暂停拉流 */
  private waitForIndexTargetMs: number | null = null

  /** 本世代起点对应的影片时间（重建时从 Cluster 锚点传入，初始为 0） */
  private genAnchorMs = 0
  private lastVideoDtsMs: number | null = null
  /** 音频全局单调时钟（µs）：跨批防回退 */
  private lastAudioPtsUs: number | null = null

  /** 首个音频批次是否已派发（决定批次窗口：首批短窗口快速出声） */
  private firstAudioBatchSent = false

  constructor(opts: WasmPlayerOptions) {
    this.video = opts.video
    this.sourceUrl = opts.sourceUrl
    this.headers = opts.headers
    this.fallbackDurationSec = opts.fallbackDurationSec
    this.onFatal = opts.onFatal
    // seek 桥接：外部（进度条拖拽/键盘/同步协议）直接设置 currentTime
    // 到未缓冲区域时，MSE 无数据会让元素停在 seeking 状态永久卡死
    // （零报错零日志）。监听 seeking 自愈：目标在缓冲外即触发引擎
    // 自身的 seekTo（Range 续传重建管线）。
    this.video.addEventListener('seeking', this.seekBridgeHandler)
  }

  get isAttached(): boolean {
    return !!this.mse && this.mse.readyState === 'open'
  }

  get isSeeking(): boolean {
    return false // 重入由内部重建处理，上层无需感知中间态
  }

  /**
   * 主入口：启动整条管线。resolve 表示至少已可开始播放。
   */
  async start(startTimeSec = 0): Promise<void> {
    const gen = ++this.pipelineGen
    this.eofReached = false
    this.pendingVideo = []
    this.audioBatch = null
    this.firstAudioBatchSent = false

    // worker 幂等启动：核心下载与网络取流并行推进，进度在控制栏展示。
    this.attachWorker()

    const duration = this.durationSec ?? this.fallbackDurationSec ?? null
    this.durationSec = duration

    let startOffsetBytes = 0
    if (startTimeSec > 0 && this.demuxer) {
      const off = this.nearestClusterOffset(startTimeSec * 1000)
      if (off !== null) startOffsetBytes = off
    }

    this.byteSource = new MediaByteSource(this.sourceUrl, {
      headers: this.headers,
      startOffset: startOffsetBytes,
    })

    if (!this.demuxer) this.demuxer = this.createDemuxer(gen)
    void this.pumpLoop(gen, this.demuxer)

    await this.setupMediaSource()
    await this.waitForPlaybackStart(gen)
  }

  private createDemuxer(gen: number): MatroskaDemuxer {
    return new MatroskaDemuxer(
      {
        onTracks: (t) => void this.onTracks(t),
        onInfo: (info) => {
          if (info.durationSec && info.durationSec > (this.durationSec ?? 0)) {
            this.durationSec = info.durationSec
            // 不能用 Number.isFinite(this.mse.duration) 守卫——fallback
            // 缺失时 duration 恒为 NaN，容器真实时长永远写不进去。
            try {
              if (this.mse && this.mse.readyState === 'open') {
                this.mse.duration = info.durationSec
              }
            } catch {
              /* ignore */
            }
          }
        },
        onFrame: (f) => this.onFrame(gen, f),
        onClusterIndexed: (ts) => {
          if (ts > this.lastKnownClusterTsMs) this.lastKnownClusterTsMs = ts
        },
      },
      0
    )
  }

  private async pumpLoop(gen: number, demuxer: MatroskaDemuxer): Promise<void> {
    try {
      for (;;) {
        if (gen !== this.pipelineGen || gen === -1) return
        if (this.parsingPaused) {
          // 暂停期间必须自行重估恢复条件：暂停后无新数据就无 append，
          // 若只被动等待，播放到缓冲末端（播放点 + LOOKAHEAD_SEC）即卡死。
          this.markParsingPaused()
          await new Promise((r) => setTimeout(r, 250))
          continue
        }
        const chunk = await this.byteSource!.read()
        demuxer.append(chunk)
      }
    } catch (err) {
      if (gen !== this.pipelineGen) return
      // 必须用 instanceof：自定义 Error 子类实例的 .name 仍是 'Error'，
      // 用 name 判断会把「文件正常读完（EOS）」误判为致命错误。
      if (err instanceof StreamEndedError) {
        await this.handleEof()
        return
      }
      this.onFatal(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /** 从 Cluster 索引中找 ≤ targetMs(+1.5s 容差) 的最近偏移 */
  private nearestClusterOffset(targetMs: number): number | null {
    const idx = this.demuxer?.clusterIndex ?? []
    let best: number | null = null
    for (const item of idx) {
      if (item.timestampMs <= targetMs + 1500) best = item.offset
      else break
    }
    return best
  }

  private async onTracks(tracks: DemuxedTrack[]): Promise<void> {
    if (this.tracks.length > 0) return
    this.tracks = tracks
    this.videoTrack = tracks.find((t) => t.trackType === 1) ?? null
    this.audioTrack = tracks.find((t) => t.trackType === 2) ?? null

    if (!this.videoTrack || !this.audioTrack) {
      this.onFatal(new Error('MKV 中未找到完整的视频/音频轨'))
      return
    }
    if (!this.videoTrack.codecPrivate) {
      this.onFatal(new Error('视频轨缺少 CodecPrivate，无法封装'))
      return
    }
    this.structureReady = true
    this.ensureVideoMuxer()
    if (this.needsTranscode()) {
      console.info(
        `[wasm-engine] 音轨 ${this.audioTrack.codecId} 需浏览器内转码`
      )
    }
  }

  /** 非 AAC 音轨一律走浏览器内解码重编码（MP4 容器对其他编码支持差） */
  private needsTranscode(): boolean {
    return !/^A_AAC/.test(this.audioTrack?.codecId ?? '')
  }

  // ---------- 视频轨：GOP 边界顺序写入 ----------

  private onFrame(gen: number, frame: DemuxedFrame): void {
    if (gen !== this.pipelineGen) return
    if (this.videoTrack && frame.trackNumber === this.videoTrack.trackNumber) {
      this.pendingVideo.push(frame)
      this.flushVideoBuffer(false)
      return
    }
    if (this.audioTrack && frame.trackNumber === this.audioTrack.trackNumber) {
      if (this.needsTranscode()) {
        this.pushToAudioBatch(frame)
      } else {
        // AAC 直通：直接进 audio muxer。durUs 必须给真实值：AAC 每帧
        // 固定 1024 样本，传 0 会导致整条音轨永不封装（无声）。
        const rate = this.audioTrack.samplingRate ?? 48000
        const durUs = Math.round((1024 / rate) * 1e6)
        this.appendAudioChunk(
          frame.data,
          frame.timestampMs * 1000,
          durUs,
          this.audioTrack.codecPrivate ?? null,
          Math.min(this.audioTrack.channels ?? 2, 2),
          rate
        )
      }
    }
  }

  /**
   * GOP 边界 flush：把 pendingVideo 中「首关键帧 → 下一关键帧」的完整
   * GOP 写入 video muxer。保持块序（= 解码顺序），禁止按 PTS 排序：
   * B 帧的解码依赖要求参考帧先行。
   *
   * final=true（EOF）时把剩余帧全部写出（尾部 GOP 无下一关键帧）。
   * 单一关键帧且缓冲超限时强制收窗（防坏流无限堆积）。
   */
  private flushVideoBuffer(final: boolean): void {
    if (!this.structureReady) return
    const frames = this.pendingVideo
    const firstKf = frames.findIndex((f) => f.keyframe)
    if (firstKf < 0) {
      // 尚无关键帧锚点：EOF 时丢弃（无法解码），否则等待
      if (final) this.pendingVideo = []
      return
    }
    let nextKf = -1
    for (let i = firstKf + 1; i < frames.length; i++) {
      if (frames[i]!.keyframe) {
        nextKf = i
        break
      }
    }
    let end: number
    if (nextKf > firstKf) {
      end = nextKf // 完整 GOP（下一关键帧之前全部封闭可写）
    } else if (final) {
      end = frames.length
    } else if (frames.length - firstKf > VIDEO_REORDER_MAX * 4) {
      end = frames.length // 坏流保护：单关键帧但缓冲爆炸，强制收窗
    } else {
      return // GOP 未封闭，等下一关键帧到达
    }

    const gop = frames.slice(firstKf, end)
    this.pendingVideo = frames.slice(end)
    this.writeGop(gop)
  }

  /**
   * 写入一个 GOP（块序 → GOP 内回推 DTS + compositionTimeOffset）。
   *
   * mp4-muxer 语义陷阱：addVideoChunkRaw 第三参是 PTS，内部 DTS =
   * timestamp - cto。若把 dts 传给第三参，B 帧（cto>0）时内部产生
   * 2*dts-pts 的负 DTS → 时间戳非单调抛错 → 管线崩溃。必须传 ptsUs。
   *
   * DTS 推断（GOP 内回推）：块序即解码序，真实 DTS 未知：
   *   dts[n-1] = pts[n-1]，dts[i] = min(pts[i], dts[i+1] - 1ms)
   * 保证 DTS 严格递增且 cto = pts - dts ≥ 0（Chrome MSE 兼容）。
   */
  private writeGop(gop: DemuxedFrame[]): void {
    if (gop.length === 0 || !this.videoCh.muxer) return
    const n = gop.length
    const dts: number[] = new Array(n)
    dts[n - 1] = gop[n - 1]!.timestampMs
    for (let i = n - 2; i >= 0; i--) {
      dts[i] = Math.min(gop[i]!.timestampMs, dts[i + 1]! - 1)
    }
    const floor = this.lastVideoDtsMs
    if (floor !== null && dts[0]! <= floor) {
      dts[0] = floor + 1
      for (let i = 1; i < n; i++) {
        if (dts[i]! <= dts[i - 1]!) dts[i] = dts[i - 1]! + 1
      }
    }
    // duration 必须传真实值：mp4-muxer 以「下一样本 dts 差」精化，但
    // 每 fragment 最后一个 sample 永远等不到下一样本——传 0 会让 trun
    // 中该 sample duration=0，解码器将其丢弃（每 fragment 丢 1 帧）。
    const estFrameDurUs =
      n > 1
        ? Math.max(
            1000,
            Math.round(
              ((gop[n - 1]!.timestampMs - gop[0]!.timestampMs) / (n - 1)) * 1000
            )
          )
        : Math.round(1e6 / 25)
    for (let i = 0; i < n; i++) {
      const f = gop[i]!
      const d = dts[i]!
      this.lastVideoDtsMs = d
      const ptsUs = f.timestampMs * 1000
      const cto = Math.max(0, Math.round(ptsUs - d * 1000))
      const durUs =
        i + 1 < n ? Math.max(1000, (dts[i + 1]! - d) * 1000) : estFrameDurUs
      try {
        // MKV 的 H.264 帧可能是 Annex-B 或 AVCC 两种存储约定，见
        // annexBToAvcc 的格式自适应说明。传错格式会让 Chrome 解码器
        // 确定性崩溃（PIPELINE_ERROR_DECODE）。
        const avcc = annexBToAvcc(f.data)
        this.videoCh.muxer.addVideoChunkRaw(
          avcc,
          f.keyframe ? 'key' : 'delta',
          ptsUs,
          durUs,
          {
            decoderConfig: {
              codec: 'avc1.640029',
              description: this.videoTrack!.codecPrivate!,
            },
          },
          cto
        )
      } catch (err) {
        console.warn('[wasm-engine] 视频 mux 失败', err)
      }
    }
  }

  // ---------- 音频轨：批次转码 / AAC 直通 ----------

  private pushToAudioBatch(frame: DemuxedFrame): void {
    if (!this.audioBatch) {
      this.audioBatch = { frames: [], bytes: 0, startMs: frame.timestampMs }
    }
    this.audioBatch.frames.push(frame.data)
    this.audioBatch.bytes += frame.data.byteLength
    // 首个批次用短窗口：起播后 ~1.5s 即可出声，不必等攒满 6s
    const batchMs = this.firstAudioBatchSent
      ? BATCH_DURATION_MS
      : FIRST_AUDIO_BATCH_MS
    if (
      frame.timestampMs - this.audioBatch.startMs >= batchMs ||
      this.audioBatch.bytes >= BATCH_MAX_BYTES
    ) {
      this.dispatchAudioBatch()
    }
  }

  private dispatchAudioBatch(): void {
    const batch = this.audioBatch
    this.audioBatch = null
    if (!batch || !this.worker || batch.frames.length === 0) return
    const total = batch.frames.reduce((n, f) => n + f.byteLength, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const f of batch.frames) {
      merged.set(f, off)
      off += f.byteLength
    }
    const id = ++this.audioBatchSeq
    this.batchRegistry.set(id, { id, frames: [], startMs: batch.startMs })
    this.worker.postMessage({ type: 'decode', id, data: merged.buffer }, [
      merged.buffer,
    ])
    this.firstAudioBatchSent = true
  }

  /**
   * worker 回传 ADTS AAC 流 → 解析 ADTS 帧序列 → 剥头后的裸 AAC 帧
   * 直接写入 audio muxer。
   *
   * 时间戳：以批次的 demuxer 起点（batch.startMs）为锚，按 AAC 每帧
   * 固定 1024 样本推算。批次锚点来自源容器时间轴，跨批次不累积漂移。
   */
  private onAdtsDecoded(id: number, adts: Uint8Array): void {
    const batch = this.batchRegistry.get(id)
    this.batchRegistry.delete(id)
    if (!batch) return // 旧世代残余批次，已作废

    let p = 0
    let frameIdx = 0
    while (p + 7 <= adts.length) {
      if (adts[p] !== 0xff || (adts[p + 1]! & 0xf0) !== 0xf0) {
        console.warn('[wasm-engine] ADTS 同步字丢失，丢弃剩余批次数据')
        return
      }
      const hdr = (adts[p + 1]! & 0x01) === 0 ? 9 : 7 // CRC protection bit 为 0 时头长 9
      const profileBits = (adts[p + 2]! >> 6) & 0x3 // AAC-LC = 0b00（profile-1）
      const freqIdx = (adts[p + 2]! >> 2) & 0xf
      const chanCfg = ((adts[p + 2]! & 0x1) << 2) | ((adts[p + 3]! >> 6) & 0x3)
      const frameLen =
        ((adts[p + 3]! & 0x3) << 11) |
        (adts[p + 4]! << 3) |
        ((adts[p + 5]! >> 5) & 0x7)
      if (frameLen < hdr || p + frameLen > adts.length) {
        console.warn('[wasm-engine] ADTS 帧长度异常，丢弃剩余批次数据')
        return
      }

      // 首帧时从 ADTS 头构造 AudioSpecificConfig（5+4+4=13bit 补齐到 16bit）
      if (!this.ascDescription) {
        const aot = profileBits + 1
        this.ascDescription = new Uint8Array([
          ((aot & 0x1f) << 3) | ((freqIdx & 0xf) >> 1),
          (((freqIdx & 0x1) << 7) | ((chanCfg & 0xf) << 3)) & 0xff,
        ])
        this.ascSampleRate = ADTS_FREQ_TABLE[freqIdx] ?? 48000
        console.info(
          `[wasm-engine] AAC ASC 构造完成 (AOT=${aot}, freq=${this.ascSampleRate}, ch=${chanCfg})`
        )
      }

      const sampleRate = ADTS_FREQ_TABLE[freqIdx] ?? 48000
      const frameDurUs = Math.round((1024 / sampleRate) * 1e6)
      // 全局单调时钟：批次锚点与 AAC 固定帧时长推算之间可能存在
      // ±几十 ms 的重叠，跨批时间戳回退会让 muxer 抛错，以前帧兜底。
      let ptsUs = batch.startMs * 1000 + frameIdx * frameDurUs
      if (this.lastAudioPtsUs !== null && ptsUs <= this.lastAudioPtsUs) {
        ptsUs = this.lastAudioPtsUs + frameDurUs
      }
      this.lastAudioPtsUs = ptsUs
      const payload = new Uint8Array(frameLen - hdr)
      payload.set(adts.subarray(p + hdr, p + frameLen))
      this.appendAudioChunk(
        payload,
        ptsUs,
        frameDurUs,
        this.ascDescription,
        2, // worker 固定 `-ac 2` 输出立体声
        this.ascSampleRate ?? 48000
      )
      frameIdx++
      p += frameLen
    }
  }

  /**
   * 写入一帧 AAC（转码/直通统一入口）。首次调用时按实际参数创建
   * audio muxer——采样率/ASC 此刻才精确已知。
   */
  private appendAudioChunk(
    data: Uint8Array,
    ptsUs: number,
    durUs: number,
    asc: Uint8Array | null,
    channels: number,
    sampleRate: number
  ): void {
    if (!asc || !this.mse || !this.structureReady) return
    if (!this.audioCh.muxer) {
      const self = this
      this.audioCh.muxer = new Muxer({
        target: new StreamTarget({
          // 签名必须是 (data, position)：mp4-muxer 运行时校验参数个数，
          // 单参会抛 TypeError 击杀整条写入链
          onData: (d, _pos) => self.appendTo(this.audioCh, d),
          chunked: false,
        }),
        fastStart: 'fragmented',
        minFragmentDuration: 1,
        firstTimestampBehavior: 'cross-track-offset',
        audio: { codec: 'aac', numberOfChannels: channels, sampleRate },
      })
    }
    try {
      this.audioCh.muxer.addAudioChunkRaw(data, 'key', ptsUs, durUs, {
        decoderConfig: {
          codec: 'mp4a.40.2',
          numberOfChannels: channels,
          sampleRate,
          description: asc,
        },
      })
    } catch (err) {
      console.warn('[wasm-engine] 音频 mux 失败', err)
    }
  }

  // ---------- Worker ----------

  /** worker 消息路由（注册到共享单例上） */
  private workerHandler = (msg: WasmWorkerMessage): void => {
    if (msg.type === 'loaded') {
      console.info('[wasm-engine] ffmpeg.wasm 核心加载完成')
      notifyWasmCoreProgress(null)
    } else if (msg.type === 'core-progress') {
      notifyWasmCoreProgress({
        part: msg.part,
        loaded: msg.loaded,
        total: msg.total,
      })
    } else if (msg.type === 'decoded') {
      this.onAdtsDecoded(msg.id, msg.adts)
    } else if (msg.type === 'error') {
      // 核心加载失败 = 转码链路整体不可用，必须上抛触发回退。
      // 同时销毁共享 worker：否则坏单例永久驻留，后续 attach 全部失败。
      console.warn('[wasm-engine] worker 错误:', msg.message)
      if (
        (msg.id === undefined || this.batchRegistry.has(msg.id)) &&
        /加载|下载|import|createFFmpegCore|初始化/.test(msg.message)
      ) {
        destroySharedWorker()
        notifyWasmCoreProgress(null)
        this.onFatal(new Error(`浏览器端转码核心加载失败: ${msg.message}`))
      }
    }
  }

  private attachWorker(): void {
    // 幂等：本实例只注册一次路由；worker 本身是模块级共享单例。
    if (this.worker) return
    this.worker = acquireSharedWorker(this.workerHandler)
  }

  // ---------- MSE ----------

  private setupMediaSource(): Promise<void> {
    if (!('MediaSource' in window)) {
      return Promise.reject(new Error('浏览器不支持 MSE'))
    }
    for (const mime of [this.videoCh.mime, this.audioCh.mime]) {
      if (!MediaSource.isTypeSupported(mime)) {
        return Promise.reject(
          new Error(`浏览器不支持编码 ${mime}，无法启用浏览器端转码`)
        )
      }
    }
    const mse = new MediaSource()
    // 先 revoke 旧 objectUrl：每次 seek 重建都会走到这里，旧 MSE 若仍被
    // blob URL 引用则无法回收，其 SB 缓冲数据（可达上百 MB）永久滞留，
    // 累积耗尽浏览器 MSE 内存配额（QuotaExceededError → 音频无声）。
    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl)
      } catch {
        /* ignore */
      }
    }
    this.mse = mse
    this.objectUrl = URL.createObjectURL(mse)

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('MediaSource 打开超时')),
        10000
      )
      mse.addEventListener(
        'sourceopen',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
      this.video.src = this.objectUrl!
      this.video.load()
    }).then(() => {
      // 立即创建两个 SourceBuffer（不等首个分片）：配额耗尽等致命问题
      // 在起播前暴露 → 快速失败回退原生引擎，而不是播放十几秒后音频
      // 通道静默无声（懒创建时 addSourceBuffer 失败只 warn，用户只看到
      // 「没声」没有任何错误提示）。
      for (const ch of [this.videoCh, this.audioCh]) {
        if (ch.sb) continue
        try {
          const sb = this.mse!.addSourceBuffer(ch.mime)
          sb.mode = 'segments'
          ch.sb = sb
        } catch (err) {
          throw new Error(
            `创建 SourceBuffer 失败（${ch === this.audioCh ? '音频' : '视频'}通道）：${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      if (!Number.isFinite(this.video.duration) || this.video.duration === 0) {
        const d = this.durationSec ?? this.fallbackDurationSec
        if (d && d > 0) {
          try {
            this.mse!.duration = d
          } catch {
            /* ignore */
          }
        }
      }
    })
  }

  private ensureVideoMuxer(): void {
    if (this.videoCh.muxer || !this.mse || !this.structureReady) return
    const self = this
    this.videoCh.muxer = new Muxer({
      target: new StreamTarget({
        // 签名必须是 (data, position)：见 appendAudioChunk 内同款注释
        onData: (d, _pos) => self.appendTo(this.videoCh, d),
        chunked: false,
      }),
      fastStart: 'fragmented',
      // fragment 的最小分片时长：mp4-muxer 只在关键帧处切分，且要求
      // 当前分片累计时长 ≥ 该值。2s 会让小 GOP（<2s）片源额外多等一个
      // GOP 才产出首个可解码分片；1s 即可做到「第二个关键帧一到就出片」。
      minFragmentDuration: 1,
      firstTimestampBehavior: 'cross-track-offset',
      video: {
        codec: 'avc',
        width: this.videoTrack!.pixelWidth ?? 1920,
        height: this.videoTrack!.pixelHeight ?? 1080,
      },
    })
  }

  /**
   * 分片写入串行队列（每通道一条）。StreamTarget 的 onData 在一次 mux
   * 操作内同步连续触发多次，并发 appendBuffer 会抛 InvalidStateError
   * 且分片丢失（黑屏根因）。
   */
  private appendTo(ch: Channel, data: Uint8Array): void {
    if (data.byteLength === 0) return
    const gen = this.appendGen
    ch.busyDepth++
    ch.chain = ch.chain
      .then(() => {
        if (gen !== this.appendGen) return // 旧世代残余，丢弃
        return this.doAppendBuffer(ch, data)
      })
      .catch(() => undefined)
      .finally(() => {
        ch.busyDepth--
      })
  }

  private async doAppendBuffer(ch: Channel, data: Uint8Array): Promise<void> {
    if (!ch.sb) {
      // 必须包 try：MSE 在 ended/closed 状态下 addSourceBuffer 抛
      // InvalidStateError，且此处在 doAppendBuffer 的主 try 之外，
      // 异常会被 append 链的 catch 静默吞掉（表现为零日志无声）。
      let sb: SourceBuffer | null = null
      try {
        sb = this.mse?.addSourceBuffer(ch.mime) ?? null
      } catch (err) {
        console.warn('[wasm-engine] addSourceBuffer 失败', err)
      }
      if (!sb) return
      sb.mode = 'segments'
      ch.sb = sb
    }
    if (!ch.offsetApplied) {
      // 把 muxer 输出的世代相对时间平移回影片绝对秒
      ch.sb.timestampOffset = this.genAnchorMs / 1000
      ch.offsetApplied = true
    }
    try {
      ch.appendCount++
      ch.appendedBytes += data.byteLength
      if (data.byteLength > 1024 * 1024 || ch.appendCount % 10 === 0) {
        console.info(
          `[wasm-engine] append ${ch === this.audioCh ? 'audio' : 'video'} #${ch.appendCount}: ${(data.byteLength / 1024).toFixed(0)}KB（累计 ${(ch.appendedBytes / 1024 / 1024).toFixed(1)}MB）`
        )
      }
      // 先等可能进行中的 remove 完成：驱逐的 remove 是异步的且不经过
      // append 链。不等待的话 appendBuffer 会抛 InvalidStateError。
      await this.waitForSbIdle(ch.sb)
      ch.sb.appendBuffer(data as unknown as ArrayBuffer)
      await this.waitForSbIdle(ch.sb)
    } catch (err) {
      console.warn('[wasm-engine] appendBuffer 失败', err)
    }
    this.evict(ch)
    // 数据驱动的暂停评估：缓冲水位随 append 变化，达到 lookahead 即
    // 暂停拉流（pumpLoop 内只在已暂停时重估恢复，进入路径必须在这里）。
    // 缺失该触发时快源下视频轨会全速写完整片先于音频转码 EOF，
    // 后到的音频写入全部失败 → 无声。
    this.markParsingPaused()
  }

  /** 等待 SourceBuffer 空闲；已空闲时立即返回 */
  private waitForSbIdle(sb: SourceBuffer): Promise<void> {
    if (!sb.updating) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      sb.addEventListener('updateend', done, { once: true })
      sb.addEventListener('error', done, { once: true })
      // 兜底：updateend 意外丢失（sb 已拆除等）时超时放行
      const timer = setTimeout(done, 10_000)
    })
  }

  /** 缓冲尾部驱逐：与播放点保持 BACK_BUFFER_SEC 距离 */
  private evict(ch: Channel): void {
    const sb = ch.sb
    if (!sb || this.video.currentTime <= BACK_BUFFER_SEC) return
    const removeEnd = this.video.currentTime - BACK_BUFFER_SEC
    try {
      const b = sb.buffered
      if (b.length > 0 && b.start(0) < removeEnd - 1) {
        sb.remove(b.start(0), removeEnd)
      }
    } catch {
      /* ignore */
    }
  }

  private bufferAhead(): number {
    const t = this.video.currentTime
    const b = this.video.buffered
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.5 && t <= b.end(i)) return b.end(i) - t
    }
    return 0
  }

  /**
   * 统一重估读取暂停状态。进入暂停的那一刻把不满 6s 的音频尾批立即送
   * 转码：否则尾批要等恢复读取后才凑满派发，恢复加载时出现一个批次
   * 周期的音频空窗。
   */
  private markParsingPaused(): void {
    // 索引追赶期间禁止暂停：必须让 pumpLoop 继续读取、Cluster 索引
    // 继续生长，否则远距离跳转永远「目标尚未索引」失败。
    const shouldPause =
      this.bufferAhead() >= LOOKAHEAD_SEC &&
      !this.eofReached &&
      this.waitForIndexTargetMs == null
    if (
      shouldPause &&
      !this.parsingPaused &&
      this.audioBatch &&
      this.audioBatch.frames.length > 0
    ) {
      this.dispatchAudioBatch()
    }
    this.parsingPaused = shouldPause
  }

  // ---------- EOF / 恢复 ----------

  private async handleEof(): Promise<void> {
    // 双重 EOF 守卫：重建后的新 pumpLoop 可能在残存读流结束时再次触发
    if (this.eofReached) return
    this.eofReached = true
    // 最后一批音频（不足 BATCH_DURATION_MS）也送出解码
    if (this.audioBatch) this.dispatchAudioBatch()
    // 等所有在途批次编码完成。deadline 必须远大于核心加载时间（32MB
    // wasm 首次下载+编译可能 30s+）+ 全队列转码：视频轨直通是快路径，
    // 音频转码是慢路径，带病 finalize 会让后到的音频全部写入失败
    // （endOfStream 后 addSourceBuffer 抛错被 append 链静默吞掉）→ 无声。
    const deadline = Date.now() + 120000
    while (this.batchRegistry.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    // 尾部 GOP 冲刷 + 关键时序：等写入链完全排空后再 finalize。
    // 若先行 finalize，泵残余产出的分片会在 finalize 之后到达而被拒收。
    this.flushVideoBuffer(true)
    await this.drainChannels()
    for (const ch of [this.videoCh, this.audioCh]) {
      if (ch.muxer && !ch.finalized) {
        try {
          ch.muxer.finalize()
          ch.finalized = true
        } catch (err) {
          console.warn('[wasm-engine] finalize 失败', err)
        }
      }
    }
    await this.drainChannels()
    try {
      if (this.mse?.readyState === 'open') this.mse.endOfStream()
    } catch {
      /* ignore */
    }
    console.info(
      `[wasm-engine] EOF：finalize 完成（video append ${this.videoCh.appendCount} 次 / ${(this.videoCh.appendedBytes / 1024 / 1024).toFixed(1)}MB，audio append ${this.audioCh.appendCount} 次 / ${(this.audioCh.appendedBytes / 1024 / 1024).toFixed(1)}MB）`
    )
  }

  private async drainChannels(): Promise<void> {
    while (
      this.videoCh.busyDepth > 0 ||
      this.audioCh.busyDepth > 0 ||
      this.videoCh.sb?.updating ||
      this.audioCh.sb?.updating
    ) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /**
   * 解码错误恢复策略：MSE 的 PIPELINE_ERROR_DECODE 对同一字节序列是
   * **确定性**的——回溯重放必然复现并耗尽重试。因此恢复必须「向前跳过」
   * 可疑区域：从播放位置向前跳 RECOVERY_JUMP_SEC×次数，用 Cluster 索引
   * 做 Range 重连，直接越过坏 GOP 继续播放。
   */
  private recovering = false
  private recoveryAttempts = 0

  private async recoverFromDecodeError(atSec: number): Promise<void> {
    if (this.recovering || this.recoveryAttempts >= 3) {
      throw new Error(
        `视频解码错误且多次跳越失败(code见日志)@${atSec.toFixed(1)}s`
      )
    }
    // 跳跃基准必须是【播放位置】（解码器真实卡住的地方），不能用封装
    // 前沿（天然领先播放几十秒，会误判为「已到片尾」→ 无限循环）。
    const baseSec = atSec || 0
    const durationSec = this.durationSec ?? this.fallbackDurationSec ?? Infinity
    let targetSec = baseSec + RECOVERY_JUMP_SEC * (this.recoveryAttempts + 1)
    if (Number.isFinite(durationSec)) {
      targetSec = Math.min(targetSec, durationSec - 2)
    }
    if (targetSec <= baseSec && !this.eofReached) {
      throw new Error(
        `解码错误 @${baseSec.toFixed(1)}s 无法跳越（目标 ≤ 当前，时长 ${durationSec.toFixed(1)}s）`
      )
    }
    this.recovering = true
    try {
      const offset = this.nearestClusterOffset(targetSec * 1000)
      if (offset === null) {
        throw new Error(`解码错误后无法定位跳跃点 @${targetSec.toFixed(1)}s`)
      }
      console.warn(
        `[wasm-engine] video.error @${baseSec.toFixed(1)}s 附近，跳过可疑区段重建流水线：从 ~${targetSec.toFixed(1)}s 继续（第 ${this.recoveryAttempts + 1} 次恢复）`
      )
      await this.rebuildAt(offset, targetSec)
      this.recoveryAttempts++
    } finally {
      this.recovering = false
    }
  }

  /** 起播等待（含自动恢复）：video.error 时先跳越恢复再放弃 */
  private async waitForPlaybackStart(gen: number): Promise<void> {
    for (;;) {
      const outcome = await this.waitForPlaybackStartOnce(gen)
      if (outcome === 'ready' || outcome === 'superseded') return
      await this.recoverFromDecodeError(this.video.currentTime || 0)
      gen = this.pipelineGen // 已被 rebuild 更新
    }
  }

  private waitForPlaybackStartOnce(
    gen: number
  ): Promise<'ready' | 'superseded' | 'decode-error'> {
    return new Promise((resolve, reject) => {
      let waited = 0
      const timer = setInterval(() => {
        if (gen !== this.pipelineGen) {
          clearInterval(timer)
          resolve('superseded')
          return
        }
        waited += 200
        if (waited > 60000) {
          clearInterval(timer)
          reject(new Error('等待首帧超时（60s）'))
          return
        }
        if (this.video.error) {
          clearInterval(timer)
          console.warn(
            `[wasm-engine] video.error(code=${this.video.error.code}): ${this.video.error.message ?? '媒体不可解码'}`
          )
          resolve('decode-error')
          return
        }
        // 空隙对齐：恢复跳越后 currentTime 可能落在缓冲起点之前（Cluster
        // 索引向下取整所致），浏览器无法在空隙上起播，必须对齐。
        {
          const b = this.video.buffered
          if (b.length > 0 && this.video.currentTime < b.start(0)) {
            console.info(
              `[wasm-engine] 播放位置 ${this.video.currentTime.toFixed(1)}s 落后于缓冲起点 ${b.start(0).toFixed(1)}s，对齐`
            )
            try {
              this.video.currentTime = b.start(0) + 0.05
            } catch {
              /* ignore */
            }
          }
        }
        if (
          this.video.readyState >= 3 ||
          this.bufferAhead() >= INITIAL_BUFFER_SEC
        ) {
          clearInterval(timer)
          const b = this.video.buffered
          console.info(
            `[wasm-engine] 起播条件达成：readyState=${this.video.readyState} buffered=${b.length ? `${b.start(0).toFixed(1)}~${b.end(b.length - 1).toFixed(1)}s` : '空'} append=${this.videoCh.appendCount + this.audioCh.appendCount}次`
          )
          resolve('ready')
          return
        }
        if (waited % 3000 === 0) {
          const b = this.video.buffered
          console.info(
            `[wasm-engine] 等待中 ${Math.round(waited / 1000)}s：readyState=${this.video.readyState}，buffered=${b.length ? `${b.start(0).toFixed(1)}~${b.end(b.length - 1).toFixed(1)}s` : '空'}，video=${this.videoCh.appendCount}次/${(this.videoCh.appendedBytes / 1024).toFixed(0)}KB，audio=${this.audioCh.appendCount}次/${(this.audioCh.appendedBytes / 1024).toFixed(0)}KB，批次表=${this.batchRegistry.size}，读取=${this.demuxer ? `${(this.demuxer.consumedBytes / 1024 / 1024).toFixed(1)}MB` : '无'}`
          )
        }
        if (this.video.paused && this.video.readyState >= 1) {
          this.video.play().catch(() => undefined)
        }
      }, 200)
    })
  }

  // ---------- seek ----------

  /** seek 串行链：连续快速 seek 排队执行，配合世代令牌只有最新目标生效 */
  private seekChain: Promise<{ success: boolean }> = Promise.resolve({
    success: true,
  })

  async seekTo(targetTimeSec: number): Promise<{ success: boolean }> {
    const run = this.seekChain.then(
      () => this.seekToInner(targetTimeSec),
      () => this.seekToInner(targetTimeSec)
    )
    this.seekChain = run.then(
      () => ({ success: true }),
      () => ({ success: false })
    )
    return run
  }

  private async seekToInner(targetTimeSec: number): Promise<{
    success: boolean
  }> {
    if (!this.isAttached) return { success: false }
    const b = this.video.buffered
    for (let i = 0; i < b.length; i++) {
      if (targetTimeSec >= b.start(i) && targetTimeSec <= b.end(i)) {
        this.video.currentTime = targetTimeSec
        return { success: true }
      }
    }
    // 目标超前于已解析前沿（lookahead 暂停导致索引停在播放点+60s）：
    // 恢复拉流追赶索引，而不是直接失败——直接失败会让元素卡死在
    // seeking 态，用户反复拖动反复失败。
    if (
      !this.eofReached &&
      this.lastKnownClusterTsMs < targetTimeSec * 1000
    ) {
      const indexed = await this.catchUpIndex(targetTimeSec * 1000)
      if (!indexed) return { success: false }
    }
    if (this.eofReached && this.lastKnownClusterTsMs < targetTimeSec * 1000) {
      // 已读完整个文件但索引仍未覆盖（目标超出片长）
      return { success: false }
    }
    const offset = this.nearestClusterOffset(targetTimeSec * 1000)
    if (offset === null) return { success: false }
    this.seekFillActive = true
    try {
      await this.rebuildAt(offset, targetTimeSec)
    } finally {
      this.seekFillActive = false
      // 重建期间用户可能又拖到了别的位置（桥接因 seekFillActive 跳过
      // 了那次 seeking）：结算后自检一次，卡在未缓冲位置则继续治愈
      setTimeout(() => this.maybeSelfHeal(), 400)
    }
    return { success: true }
  }

  /**
   * 恢复拉流并等待 Cluster 索引覆盖目标时间（远距离向前跳转用）。
   * 返回 false 表示超时（网络太慢）或期间被停止。
   */
  private catchUpIndex(targetMs: number): Promise<boolean> {
    if (this.lastKnownClusterTsMs >= targetMs) return Promise.resolve(true)
    if (this.eofReached) return Promise.resolve(false)
    this.waitForIndexTargetMs = targetMs
    this.parsingPaused = false
    console.info(
      `[wasm-engine] 索引追赶：目标 ${(targetMs / 1000).toFixed(1)}s，当前前沿 ${(this.lastKnownClusterTsMs / 1000).toFixed(1)}s，恢复拉流`
    )
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const timer = setInterval(() => {
        if (
          this.pipelineGen === -1 ||
          this.lastKnownClusterTsMs >= targetMs ||
          this.eofReached
        ) {
          clearInterval(timer)
          this.waitForIndexTargetMs = null
          resolve(this.lastKnownClusterTsMs >= targetMs)
          return
        }
        if (Date.now() - startedAt > 30000) {
          clearInterval(timer)
          this.waitForIndexTargetMs = null
          console.warn('[wasm-engine] 索引追赶超时（30s）')
          resolve(false)
        }
      }, 200)
    })
  }

  // ---------- seek 桥接（未缓冲区域自愈） ----------

  private seekBridgeTimer: ReturnType<typeof setTimeout> | null = null
  /** seek 触发的重建/索引追赶进行中：桥接跳过（防自触发死循环） */
  private seekFillActive = false

  private readonly seekBridgeHandler = (): void => {
    if (this.pipelineGen === -1) return
    // 拖拽进度条时 seeking 每帧触发一次：去抖到位置稳定后只处理一次
    if (this.seekBridgeTimer) clearTimeout(this.seekBridgeTimer)
    this.seekBridgeTimer = setTimeout(() => {
      this.seekBridgeTimer = null
      this.maybeSelfHeal()
    }, 300)
  }

  /**
   * 自愈入口（桥接去抖后与 seekTo 结算后共用）：
   * currentTime 卡在未缓冲区域时触发引擎自身 seekTo 重建管线。
   * seekFillActive 期间跳过——引擎自己正在填充数据，再触发会中断
   * 填充重新来过，数据永远积累不起来。
   */
  private maybeSelfHeal(): void {
    if (
      this.pipelineGen === -1 ||
      this.rebuilding ||
      this.seekFillActive ||
      !this.isAttached
    )
      return
    if (this.isCurrentTimeCovered()) return
    const t = this.video.currentTime
    const wasPaused = this.video.paused
    console.info(
      `[wasm-engine] seek 到未缓冲区域 ${t.toFixed(1)}s，触发管线重建`
    )
    void this.seekTo(t).then((r) => {
      if (!r.success) {
        console.warn(
          `[wasm-engine] 未缓冲 seek 重建失败 @${t.toFixed(1)}s（索引追赶超时或目标超出片长）`
        )
        return
      }
      // 重建尾部会 play()：seek 前是暂停态则恢复暂停
      if (wasPaused && !this.video.paused) this.video.pause()
    })
  }

  /** currentTime 是否被缓冲覆盖（含容差） */
  private isCurrentTimeCovered(): boolean {
    const t = this.video.currentTime
    const b = this.video.buffered
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) return true
    }
    return false
  }

  /** 重建进行中标志：seek 桥接在此期间不做自愈（自身 currentTime 变化） */
  private rebuilding = false

  /**
   * 整条管线重建（seek 到未缓冲区域 / 解码错误恢复）：
   * 销毁两个 SourceBuffer 与 muxer，从 byteOffset 的最近 Cluster 锚点
   * Range 重连。世代令牌 genToken 保证被取代的旧重建不收尾。
   */
  private async rebuildAt(
    byteOffset: number,
    targetSec: number
  ): Promise<void> {
    this.rebuilding = true
    try {
      // 结束当前世代
      this.pipelineGen++
      this.appendGen++
      this.byteSource?.abort()
      // 锚点：目标 Cluster 的时间码
      const idx = this.demuxer?.clusterIndex ?? []
      let anchorMs = 0
      for (const item of idx) {
        if (item.offset <= byteOffset) anchorMs = item.timestampMs
        else break
      }
      this.genAnchorMs = anchorMs
      this.lastVideoDtsMs = null
      this.lastAudioPtsUs = null

      // 通道状态重置（muxer/SB 重建，旧世代排队写入由 appendGen 丢弃）
      this.disposeSourceBuffers()
      this.videoCh.muxer = null
      this.audioCh.muxer = null
      this.videoCh.finalized = false
      this.audioCh.finalized = false
      this.videoCh.offsetApplied = false
      this.audioCh.offsetApplied = false

      this.pendingVideo = []
      this.audioBatch = null
      this.firstAudioBatchSent = false
      this.batchRegistry.clear()
      this.eofReached = false
      this.parsingPaused = false
      this.waitForIndexTargetMs = null

      const genToken = this.pipelineGen
      this.byteSource = new MediaByteSource(this.sourceUrl, {
        headers: this.headers,
        startOffset: byteOffset,
      })
      const demuxer = this.createDemuxer(genToken)
      demuxer.inheritClusterIndex(idx)
      this.demuxer = demuxer
      void this.pumpLoop(genToken, demuxer)

      await this.setupMediaSource()
      if (genToken !== this.pipelineGen) return
      this.ensureVideoMuxer()
      await this.waitForPlaybackStart(genToken)
      if (genToken !== this.pipelineGen) return
      // 重建成功且未被取代：恢复次数清零，重新获得完整恢复预算
      this.recoveryAttempts = 0
      this.video.currentTime = targetSec
      // 空隙处理 + 等待目标被缓冲覆盖再收尾：锚点（Cluster 向下取整）
      // 与目标可能差一个 Cluster 间隔，浏览器无法在空隙上起播——
      // seeking 永真、readyState=1、画面卡死。必须对齐到缓冲起点。
      const coverDeadline = Date.now() + 15000
      while (
        genToken === this.pipelineGen &&
        !this.isCurrentTimeCovered() &&
        !this.video.error &&
        Date.now() < coverDeadline
      ) {
        const b = this.video.buffered
        if (b.length > 0 && this.video.currentTime < b.start(0)) {
          console.info(
            `[wasm-engine] 跳转目标 ${this.video.currentTime.toFixed(1)}s 落在缓冲起点 ${b.start(0).toFixed(1)}s 之前的空隙，对齐`
          )
          try {
            this.video.currentTime = b.start(0) + 0.05
          } catch {
            /* ignore */
          }
        }
        await new Promise((r) => setTimeout(r, 150))
      }
      if (genToken !== this.pipelineGen) return
      this.video.play().catch(() => undefined)
    } finally {
      this.rebuilding = false
    }
  }

  /** 移除两个 SourceBuffer（MSE 实例与 video.src 保留给重建复用） */
  private disposeSourceBuffers(): void {
    for (const ch of [this.videoCh, this.audioCh]) {
      // 'ended' 态（EOF 后 endOfStream）也必须移除：removeSourceBuffer
      // 在 open/ended 态均合法，且是立即释放 SB 缓冲数据（单轨可达上百
      // MB）的唯一途径。若只在 open 态移除，EOF 后的每次重建都会泄漏
      // 一个持有完整缓冲的「不死 SB」，累积耗尽浏览器 MSE 内存配额
      // （addSourceBuffer 抛 QuotaExceededError → 新播放音频无声）。
      try {
        if (
          ch.sb &&
          this.mse &&
          (this.mse.readyState === 'open' || this.mse.readyState === 'ended')
        ) {
          this.mse.removeSourceBuffer(ch.sb)
        }
      } catch {
        /* ignore */
      }
      ch.sb = null
      ch.chain = Promise.resolve()
    }
  }

  private disposeMseOnly(): void {
    this.disposeSourceBuffers()
    try {
      if (this.mse && this.mse.readyState === 'open') this.mse.endOfStream()
    } catch {
      /* ignore */
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
    this.mse = null
  }

  /** 彻底清理（切换影片/销毁播放器时调用） */
  cleanup(): void {
    this.pipelineGen = -1
    this.video.removeEventListener('seeking', this.seekBridgeHandler)
    if (this.seekBridgeTimer) {
      clearTimeout(this.seekBridgeTimer)
      this.seekBridgeTimer = null
    }
    this.byteSource?.abort()
    // 不 terminate 共享 worker：32MB wasm 核心整个会话内复用（一次下载，
    // 永久使用），仅注销本实例的消息路由。
    releaseSharedWorker(this.workerHandler)
    this.worker = null
    notifyWasmCoreProgress(null)
    this.disposeMseOnly()
    try {
      this.video.removeAttribute('src')
      this.video.load()
    } catch {
      /* ignore */
    }
  }
}

/** ADTS header 中的采样率索引表（MPEG-4） */
const ADTS_FREQ_TABLE: Record<number, number> = {
  0: 96000,
  1: 88200,
  2: 64000,
  3: 48000,
  4: 44100,
  5: 32000,
  6: 24000,
  7: 22050,
  8: 16000,
  9: 12000,
  10: 11025,
  11: 8000,
  12: 7350,
}

/**
 * Annex-B → AVCC 转换（输入格式自适应）。
 *
 * Matroska 中 V_MPEG4/ISO/AVC 的帧实际存在两种存储约定（真实文件两者皆有）：
 * - Annex-B 起始码分隔（mkvmerge 等封装器）；
 * - AVCC 4 字节大端长度前缀（ffmpeg matroskaenc 等封装器）。
 *
 * 危险陷阱：AVCC 帧的首个 NALU 长度落在 0x0100~0x01FF（256~511 字节）时，
 * 长度前缀字节恰好是 `00 00 01 xx`，会被朴素的起始码扫描误判成 Annex-B
 * 起始码，"转换"产物错位一个字节成为垃圾数据 → MSE 解码错误 → 黑屏。
 * （本工程离线管线实测：60s/1440 帧测试片中 29 个小 P 帧因此损坏。）
 *
 * 因此先做 AVCC 走查校验：4 字节长度前缀恰好完整消费整个帧且 NALU 类型
 * 合法即认定输入已是 AVCC，原样返回；否则才按 Annex-B 逐 NALU 重写。
 */
export function annexBToAvcc(data: Uint8Array): Uint8Array {
  if (data.length > 0 && isWellFormedAvcc(data)) return data

  const naluStarts: number[] = []
  for (let i = 0; i + 2 < data.length; ) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      naluStarts.push(i + 3)
      i += 3
    } else {
      i++
    }
  }
  if (naluStarts.length === 0) return data

  // 计算每个 NALU 的结束位置：下一个起始码的前导 0x00 序列之前
  const out: Uint8Array[] = []
  let total = 0
  for (let k = 0; k < naluStarts.length; k++) {
    const start = naluStarts[k]
    let end: number
    if (k + 1 < naluStarts.length) {
      // 下一起始码的 01 位于 [naluStarts[k+1]-1]；其前的连续 0x00 属于起始码
      let b = naluStarts[k + 1] - 2 // 指向 00 00 01 的首个 00
      while (b > start && data[b - 1] === 0) b--
      end = b
    } else {
      end = data.length
    }
    const len = Math.max(0, end - start)
    const prefix = new Uint8Array(4)
    prefix[0] = (len >>> 24) & 0xff
    prefix[1] = (len >>> 16) & 0xff
    prefix[2] = (len >>> 8) & 0xff
    prefix[3] = len & 0xff
    out.push(prefix, data.subarray(start, start + len))
    total += 4 + len
  }

  const merged = new Uint8Array(total)
  let off = 0
  for (const part of out) {
    merged.set(part, off)
    off += part.byteLength
  }
  return merged
}

/**
 * 判断数据是否已是合法的 4 字节长度前缀 AVCC：
 * 逐 NALU 走查（长度 ≥1、不越界、NALU 头类型合法），
 * 恰好完整消费全部字节才算通过。
 */
function isWellFormedAvcc(data: Uint8Array): boolean {
  // 常见合法 NALU 类型：1/5 slice、6 SEI、7 SPS、8 PPS、9 AUD、12 filler
  const validType = (t: number) =>
    t === 1 || t === 5 || t === 6 || t === 7 || t === 8 || t === 9 || t === 12
  let p = 0
  let nals = 0
  while (p + 4 <= data.length) {
    const len =
      ((data[p]! << 24) |
        (data[p + 1]! << 16) |
        (data[p + 2]! << 8) |
        data[p + 3]!) >>>
      0
    if (len < 1 || p + 4 + len > data.length) return false
    if (!validType(data[p + 4]! & 0x1f)) return false
    p += 4 + len
    nals++
  }
  return nals > 0 && p === data.length
}
