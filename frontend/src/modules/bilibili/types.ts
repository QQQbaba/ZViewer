/**
 * Bilibili 模块相关类型定义
 *
 * 注意：`QualityOption` 与 `ResolvedSource` 也被 FTP / WebDAV / OpenList 等
 * 非 Bilibili 逻辑使用，因此在本模块定义并由 `resolveSource.ts` re-export
 * 以保持向后兼容。
 */
import type { MediaFormat } from '@/lib/mediaFormat'

export interface QualityOption {
  id: number
  label: string
  resolution?: string
}

/**
 * B站视频分集（P）信息。
 * 多 P 视频的每个分集有独立的 cid 和 m4s 文件。
 * 前端用于在影片列表中显示分P选择器，切换分P时使用对应 cid 重新解析。
 */
export interface BilibiliVideoPage {
  /** 分集序号，从 1 开始 */
  page: number
  /** 分集 cid */
  cid: number
  /** 分集标题（part） */
  part: string
  /** 分集时长（秒） */
  duration: number
}

export interface ResolvedSource {
  title?: string
  videoUrl: string
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  duration?: number
  /** 媒体容器格式。FTP/WebDAV/OpenList 可能返回 mkv/avi 等浏览器不支持的格式。 */
  format: MediaFormat
  loggedIn?: boolean
  cid?: number
  currentQn?: number
  acceptQuality?: QualityOption[]
  /** 大会员状态：0=非大会员，1=大会员。用于统一会员感知逻辑。 */
  vipStatus?: number
  /** 多 P 视频的分集列表（单 P 视频为 undefined） */
  pages?: BilibiliVideoPage[]
  /** 当前播放的分集序号（从 1 开始，默认 1） */
  currentPage?: number
}

export interface BilibiliQrData {
  qrcodeKey: string
  qrUrl: string
  qrDataUrl: string
}

export interface BilibiliUserInfo {
  name: string
  avatar: string
  vipStatus?: 0 | 1
}

/** B站 解析进度行（NDJSON 单行） */
export interface ResolveProgressLine {
  success?: boolean
  status: 'parsing' | 'done' | 'error'
  step?: string
  message?: string
  code?: string
  title?: string
  videoUrl?: string
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  duration?: number
  format?: MediaFormat
  loggedIn?: boolean
  cid?: number
  currentQn?: number
  acceptQuality?: QualityOption[]
  /** 大会员状态：0=非大会员，1=大会员。后端在解析时会回传该字段。 */
  vipStatus?: number
  /** 多 P 视频的分集列表（单 P 视频为 undefined） */
  pages?: BilibiliVideoPage[]
  /** 当前播放的分集序号（从 1 开始） */
  currentPage?: number
}

export type BilibiliCodec = 'auto' | 'avc' | 'hevc' | 'av1'

export interface BilibiliParseOptions {
  codec?: BilibiliCodec
  /**
   * 播放模式偏好：true=MP4 直链（流畅，seek 无卡顿，清晰度通常 480P/720P）；
   * false/undefined=DASH 分离流（高清，支持 1080P/4K，seek 需 MSE 重新缓冲）。
   */
  preferMp4?: boolean
}
