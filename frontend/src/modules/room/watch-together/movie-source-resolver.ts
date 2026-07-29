/**
 * 影片播放源解析器（从 useWatchTogether.loadMovie 抽取）。
 *
 * 将「影片记录 → 可 attach 的播放源字段」的决策逻辑收敛为纯数据函数：
 * - B站 源：在线解析 playurl（带解析进度回调）；
 * - 房主刷新恢复（recovery）且旧 URL 可用：优先复用旧 URL，
 *   标记 reusedRecoveryUrl，attach 失败时由调用方回退到在线解析；
 * - 其他源（webdav / ftp / url 等）：直接使用影片记录字段。
 *
 * 本模块不触碰 React 状态 / store / message，所有副作用留在调用方。
 */
import type { Movie } from '@/store/roomStore'
import type { MediaFormat } from '@/lib/mediaFormat'
import { resolveBilibiliWithOptions } from '@/modules/bilibili/bilibiliApi'
import { extractBvid, resolveBilibiliViaCli } from '@/modules/bilibili/cliApi'
import { useCliAgentStore } from '@/store/cliAgentStore'
import { getBilibiliParseOptions } from '@/modules/bilibili/parseOptions'
import type { QualityOption } from './resolveSource'

/** 房主刷新恢复时由后端返回的最近一次播放状态（源相关子集） */
export interface RecoverySourceInfo {
  currentTime: number
  playbackRate: number
  isPlaying: boolean
  duration?: number
  sourceUrl?: string
  sourceType?: string
  audioUrl?: string
  format?: MediaFormat
  videoCodec?: string
  audioCodec?: string
  cid?: number
  currentQn?: number
  acceptQuality?: QualityOption[]
  currentMovieId?: number
  headers?: Record<string, string>
}

/** 解析出的播放源字段（供构建 WatchTogetherState） */
export interface ResolvedMovieSource {
  sourceUrl: string
  audioUrl?: string
  format?: MediaFormat
  videoCodec?: string
  audioCodec?: string
  cid?: number
  duration: number
  currentQn?: number
  acceptQuality?: QualityOption[]
  headers?: Record<string, string>
  /**
   * true 表示本次复用了 recovery 中的旧 URL（未在线解析）。
   * attach 失败（通常 403/404 deadline 过期）时调用方应回退到
   * resolveBilibiliOnline 重新解析后重试。
   */
  reusedRecoveryUrl: boolean
}

export interface ResolveMovieSourceOptions {
  movie: Movie
  /** 归一化后的源类型（movie.sourceType 中 'mp4' 已映射为 'url'） */
  sourceType: string
  /** 恢复信息；仅当 currentMovieId 与影片匹配时由调用方传入 */
  recovery?: RecoverySourceInfo | null
  /** B站 在线解析进度回调 */
  onProgress?: (step: string, message: string) => void
}

/**
 * 获取当前可用的 CLI 代理 URL。
 * 仅当本地健康检查通过且房间内至少有一个代理时返回有效地址。
 */
export function getActiveCliProxyUrl(): string | null {
  const { localOnline, agents } = useCliAgentStore.getState()
  if (!localOnline || agents.length === 0) return null
  return agents[0].proxyUrl
}

/**
 * 获取影片实际生效的 MP4 偏好。
 *
 * 当用户启用 CLI 高画质代理且本地 CLI 已连接时，强制走 DASH 代理路径，
 * 不再降级到 MP4；CLI 启用但未连接时，强制降级为 MP4 模式，避免 DASH
 * 高画质地址因无大会员 Cookie 而无法播放。
 */
export function getEffectivePreferMp4(movieId: number): boolean {
  const { preferMp4, cliEnabled } = getBilibiliParseOptions(movieId)
  if (cliEnabled) {
    // CLI 已连接：强制使用 DASH，不再降级 MP4
    if (getActiveCliProxyUrl()) return false
    // CLI 启用但未连接：强制降级为 MP4
    return true
  }
  return preferMp4
}

function mapResolvedSourceToMovieSource(
  resolved: {
    videoUrl: string
    audioUrl?: string
    format?: MediaFormat
    videoCodec?: string
    audioCodec?: string
    cid?: number
    duration?: number
    currentQn?: number
    acceptQuality?: QualityOption[]
  },
  movie: Movie
): ResolvedMovieSource {
  if (!resolved.videoUrl) {
    throw new Error('未获取到对应清晰度的播放地址')
  }
  return {
    sourceUrl: resolved.videoUrl,
    audioUrl: resolved.audioUrl,
    format: resolved.format,
    videoCodec: resolved.videoCodec,
    audioCodec: resolved.audioCodec,
    cid: resolved.cid,
    duration: resolved.duration ?? movie.duration ?? 0,
    currentQn: resolved.currentQn ?? movie.currentQn,
    acceptQuality: resolved.acceptQuality ?? movie.acceptQuality,
    headers: undefined,
    reusedRecoveryUrl: false,
  }
}

/**
 * 在线解析 B站 视频 playurl。
 * 独立导出供「复用旧 URL 失败后的回退重新解析」复用。
 *
 * 若该影片启用了 CLI 代理且本地 CLI 在线，则通过 CLI 使用用户自己的 Cookie
 * 解析高画质地址；否则回退到服务端解析。
 */
export async function resolveBilibiliOnline(
  movie: Movie,
  onProgress?: (step: string, message: string) => void,
  options?: { preferMp4?: boolean }
): Promise<ResolvedMovieSource> {
  const parsePrefs = getBilibiliParseOptions(movie.id)
  const proxyUrl = parsePrefs.cliEnabled ? getActiveCliProxyUrl() : null
  // CLI 已连接时强制使用 DASH 代理，不再降级 MP4；未连接时强制 MP4
  const effectivePreferMp4 =
    options?.preferMp4 ?? getEffectivePreferMp4(movie.id)
  const forceDash = parsePrefs.cliEnabled && !!proxyUrl

  if (proxyUrl) {
    const bvid = extractBvid(movie.url)
    if (bvid && movie.cid) {
      const resolved = await resolveBilibiliViaCli(
        proxyUrl,
        bvid,
        movie.cid,
        movie.currentQn,
        effectivePreferMp4,
        forceDash
      )
      return mapResolvedSourceToMovieSource(resolved, movie)
    }
  }

  const resolved = await resolveBilibiliWithOptions(
    movie.url,
    movie.currentQn,
    onProgress,
    { preferMp4: effectivePreferMp4 }
  )
  return mapResolvedSourceToMovieSource(resolved, movie)
}

/**
 * 解析影片的播放源。
 *
 * B站 地址带有快速过期的签名（通常 1-2 小时）。房主刷新恢复时优先复用
 * recovery 中的旧 sourceUrl（刚过期几秒到几分钟，大概率仍有效），避免一次
 * 在线解析的网络往返；仅在 attach 失败时才由调用方回退重新解析。
 *
 * @throws 在线解析失败且无旧 URL 可复用时抛错（调用方决定提示与重试策略）
 */
export async function resolveMovieSource({
  movie,
  sourceType,
  recovery,
  onProgress,
}: ResolveMovieSourceOptions): Promise<ResolvedMovieSource> {
  if (sourceType === 'bilibili') {
    // 恢复场景且旧 URL 可用：直接复用，跳过在线解析
    if (recovery?.sourceUrl) {
      return {
        sourceUrl: recovery.sourceUrl,
        audioUrl: recovery.audioUrl,
        format: recovery.format,
        videoCodec: recovery.videoCodec,
        audioCodec: recovery.audioCodec,
        cid: recovery.cid,
        duration: recovery.duration ?? movie.duration ?? 0,
        currentQn: recovery.currentQn ?? movie.currentQn,
        acceptQuality: recovery.acceptQuality ?? movie.acceptQuality,
        headers: recovery.headers,
        reusedRecoveryUrl: true,
      }
    }
    return resolveBilibiliOnline(movie, onProgress)
  }

  // 非 B站 源：直接使用影片记录字段（Movie 类型不含 headers，见 roomStore）
  return {
    sourceUrl: movie.url,
    audioUrl: movie.audioUrl,
    format: movie.format,
    videoCodec: movie.videoCodec,
    audioCodec: movie.audioCodec,
    cid: movie.cid,
    duration: movie.duration || 0,
    currentQn: movie.currentQn,
    acceptQuality: movie.acceptQuality,
    headers: undefined,
    reusedRecoveryUrl: false,
  }
}
