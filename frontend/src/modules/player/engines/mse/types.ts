/**
 * MSE 引擎共享类型与常量（v2 重写）。
 *
 * 模块划分：
 * - player.ts     MsePlayer 门面（状态机 + 双轨编排：attach / seekTo / cleanup）
 * - track.ts      MediaTrack（单条流的完整生命周期：head → init → 流式下载 → seek 重载）
 * - processor.ts  appendPipeline（ReadableStream → SourceBuffer 的流式写入管线）
 * - downloader.ts HTTP Range 下载（重试 + 缓存读写 + 代理包装）
 * - parser.ts     MP4 头部解析（init segment / sidx / seek 偏移计算）
 * - stream-cache  IndexedDB 字节缓存（覆盖查询 + LRU + TTL）
 */
import type { SidxInfo } from '../../services/mp4-parser'

// ── 常量 ──────────────────────────────────────────────

/** 流下载分块大小 512KB：达到该积累量即 flush 到 SourceBuffer（较小分块减少主线程压力） */
export const STREAM_CHUNK_SIZE = 512 * 1024
/**
 * 前瞻缓冲高水位 60s（1min）。
 *
 * 1080P 5Mbps 下 60s ≈ 37.5MB/轨，双轨 ≈ 75MB，远低于 Chrome SourceBuffer
 * 150MB 总上限。旧值 120s 在 1080P 下双轨即达 150MB，频繁触发
 * QuotaExceededError 导致连环 abort 与播放卡死。
 */
export const TARGET_BUFFER_AHEAD = 60
/** 缓冲恢复低水位 30s（0.5min），低于此值后恢复下载 */
export const RESUME_BUFFER_THRESHOLD = 30
/** 头部下载大小 512KB，用于解析 init segment + sidx */
export const HEAD_SIZE = 512 * 1024
/** 扫描 moof 最大积累量 8MB，超限则放弃对齐直接 append */
export const MOOF_SCAN_LIMIT = 8 * 1024 * 1024
/** seek 首次 flush 最小字节数 256KB */
export const MIN_SEEK_FLUSH = 256 * 1024
/** seek 快速路径：先下载 256KB 找 moof，找到后立即 flush 减少首帧等待 */
export const SEEK_HEAD_SIZE = 256 * 1024
/**
 * seek 快速路径（有 sidx 时）：64KB 小块下载。
 * sidx 提供精确字节偏移，moof 在 range 起点附近，只需覆盖 moof 头 + mdat 首帧数据。
 * 相比 256KB 减少 4 倍下载量，显著缩短大跨度 seek 的首帧等待。
 */
export const SEEK_HEAD_SIZE_PRECISE = 64 * 1024
/** seek 首次 flush 上限 512KB，超过会延迟首帧 */
export const MAX_SEEK_FLUSH = 512 * 1024
/** fetch 最大重试次数 */
export const MAX_FETCH_RETRIES = 3
/** 首次数据就绪等待超时（attach 30s / seek 30s）。
 *  seek 超时从 15s 提升到 30s：1080P 大 fragment（2MB+）在代理链路下
 *  下载需更长时间，15s 易超时导致 needReload 循环。 */
export const INITIAL_APPEND_TIMEOUT_MS = 30000
export const SEEK_FLUSH_TIMEOUT_MS = 30000
/** MediaSource 打开超时 */
export const MEDIA_SOURCE_OPEN_TIMEOUT_MS = 30000

// ── 类型 ──────────────────────────────────────────────

/** 单条流元数据（init segment / sidx / duration / totalSize）。 */
export interface StreamMeta {
  initSegment: ArrayBuffer | null
  sidx: SidxInfo | null
  duration: number | null
  totalSize: number | null
  initSize: number | null
}

export function createStreamMeta(): StreamMeta {
  return {
    initSegment: null,
    sidx: null,
    duration: null,
    totalSize: null,
    initSize: null,
  }
}

/** MsePlayer 构造参数。 */
export interface MsePlayerOptions {
  video: HTMLVideoElement
  videoUrl: string
  audioUrl: string
  videoCodec?: string
  audioCodec?: string
}

/** seek 返回结果。 */
export interface SeekResult {
  success: boolean
  message?: string
  needReload?: boolean
  /**
   * true 表示已有另一个 seek 正在同一实例上进行（状态冲突，未执行）。
   * 调用方可把目标记录为待处理，由进行中的 seek 流程完成后接续。
   */
  busy?: boolean
}

/** 下载器选项。 */
export interface DownloadOptions {
  startByte?: number
  signal: AbortSignal
}
