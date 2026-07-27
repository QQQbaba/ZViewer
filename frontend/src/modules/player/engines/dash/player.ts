/**
 * DashPlayer：基于 dash.js 的 DASH 播放器门面。
 *
 * 职责：
 * 1. 将 B站非标准 DASH 流（分离的 video/audio m4s）包装为 dash.js 可识别的 MPD manifest
 * 2. 管理 dash.js MediaPlayer 实例生命周期（显式状态机）
 * 3. 实现 PlayerController 接口，与 MsePlayer 在 usePlayerSource 中可互换
 *
 * B站 DASH 源特点：
 * - 非标准 DASH：没有 .mpd manifest，只有分离的 video.m4s + audio.m4s
 * - m4s 是 fragmented MP4（fMP4），包含 ftyp + moov + 多个 moof/mdat
 * - mvhd.duration 为 0（duration 在 moof 的 tfdt 中累积）
 * - 没有 sidx box（无法按 sidx 索引 seek）
 * - B站 CDN 不返回 CORS 头，必须走后端 /api/stream/proxy 代理
 *
 * 解决方案：动态生成虚拟 MPD manifest
 * - type="static" + mediaPresentationDuration（来自后端权威值）
 * - 两个 AdaptationSet（video + audio），每个一个 Representation
 * - BaseURL 指向代理后的 m4s URL
 * - dash.js 会下载 m4s 头部（ftyp + moov），扫描 moof box 构建索引
 *
 * 状态机：idle → attaching → attached ⇄ seeking → disposed
 */
import dashjs from 'dashjs'
import type { MediaPlayerClass } from 'dashjs'
import type { PlayerController, SeekResult } from '../../types'
import { isBilibiliMediaUrl, buildProxyUrl } from '../../services/url-proxy'
import { findAllSidxInBuffer, findMoovRange } from './mp4-box-parser'

/** DashPlayer 构造参数 */
export interface DashPlayerOptions {
  video: HTMLVideoElement
  /** 视频流 URL（B站 m4s） */
  videoUrl: string
  /** 音频流 URL（B站 m4s） */
  audioUrl: string
  /** 视频编码（如 'avc1.64001E'），用于 MPD codecs 属性 */
  videoCodec?: string
  /** 音频编码（如 'mp4a.40.2'），用于 MPD codecs 属性 */
  audioCodec?: string
  /**
   * 媒体总时长（秒），来自后端 resolve 接口的权威值。
   * 用于 MPD mediaPresentationDuration，dash.js 据此设置 video.duration。
   */
  duration?: number
}

type PlayerState = 'idle' | 'attaching' | 'attached' | 'seeking' | 'disposed'

/** metadata 加载超时（30s，与 MSE 引擎一致） */
const METADATA_TIMEOUT_MS = 30000
/** seek 等待超时（30s，dash.js seek 长视频可能较慢） */
const SEEK_TIMEOUT_MS = 30000
/** 预下载 init segment 的最大字节数（用于解析 sidx/moov） */
const INIT_SEGMENT_PRELOAD_BYTES = 256 * 1024 // 256KB
/** 二次扫描 sidx 的最大字节数（用于检测多 sidx 结构） */
const SIDX_SCAN_BYTES = 5 * 1024 * 1024 // 5MB

export interface DashSegmentInfo {
  startTime: number
  duration: number
  byteOffset: number
  byteSize: number
}

export interface DashPlayerInitInfo {
  sidxRange?: string
  moovRange?: string
  initRange?: string
  /** sidx 覆盖的总时长（秒），用于判断 sidx 是否完整 */
  sidxCoverage?: number
  /** 是否找到多个 sidx box */
  sidxCount?: number
  /** 从 sidx 解析出的 segment 列表 */
  segments?: DashSegmentInfo[]
  /** 文件总大小（从 Content-Length 获取） */
  totalSize?: number
  /** init segment 的结束位置（moov 之后） */
  initEnd?: number
}

export class DashPlayer implements PlayerController {
  private readonly video: HTMLVideoElement
  private readonly videoUrl: string
  private readonly audioUrl: string
  private readonly videoCodec?: string
  private readonly audioCodec?: string
  private readonly duration?: number

  private dashPlayer: MediaPlayerClass | null = null
  private mpdBlobUrl: string | null = null
  private state: PlayerState = 'idle'
  private initInfo: DashPlayerInitInfo = {}
  /** 最近一次 dash.js 错误事件（用于 seek 失败诊断） */
  private lastDashError: { code?: string; message?: string; raw?: unknown } | null = null

  constructor(options: DashPlayerOptions) {
    this.video = options.video
    this.videoUrl = options.videoUrl
    this.audioUrl = options.audioUrl
    this.videoCodec = options.videoCodec
    this.audioCodec = options.audioCodec
    this.duration = options.duration
  }

  // ── 公开 API ──────────────────────────────────────

  get isAttached(): boolean {
    return this.state === 'attached' || this.state === 'seeking'
  }

  get isSeeking(): boolean {
    return this.state === 'seeking'
  }

  /**
   * 生成 MPD manifest → Blob URL → dash.js 加载。
   * @param startTime 可选，从该时间开始播放（房主刷新恢复 / 重载按钮保留进度）
   * @returns MPD 的 Blob URL（供调用方在切换时 revokeObjectURL）
   */
  async attach(startTime?: number): Promise<string> {
    if (this.state !== 'idle') {
      throw new Error(`DashPlayer 状态不允许 attach: ${this.state}`)
    }
    this.state = 'attaching'

    console.log(
      `[DashPlayer] attach 开始: startTime=${startTime?.toFixed(1) ?? '无'}, videoUrl=${this.videoUrl.substring(0, 80)}...`
    )

    try {
      // 1. 预下载视频 m4s 的头部，解析 sidx 和 moov 位置
      //    dash.js 需要 sidx 来实现 seek（计算目标时间对应的字节偏移）。
      //    没有 sidx 时，dash.js 无法 seek（只知道顺序下载，不知道跳转位置）。
      const videoInitInfo = await this.preloadInitSegment(this.videoUrl)
      this.initInfo = videoInitInfo

      // 2. 生成 MPD manifest（含 SegmentBase/indexRange，如果解析到 sidx）
      const mpd = this.generateMpd()

      // 3. 包装成 Blob URL
      const blob = new Blob([mpd], { type: 'application/dash+xml' })
      this.mpdBlobUrl = URL.createObjectURL(blob)

      // 4. 创建 dash.js 实例
      const player = dashjs.MediaPlayer().create()
      this.dashPlayer = player

      // 5. 配置 dash.js
      //    - 禁用 ABR 自动切换（B站 DASH 只有一个 Representation，ABR 无意义）
      //    - 启用 fastSwitch（seek 后快速恢复播放）
      //    - 配置缓冲策略（与 MSE 引擎 TARGET_BUFFER_AHEAD 对齐）
      player.updateSettings({
        streaming: {
          buffer: {
            fastSwitchEnabled: true,
            bufferTimeAtTopQuality: 30,
            bufferTimeAtTopQualityLongForm: 60,
            bufferToKeep: 30,
            bufferPruningInterval: 10,
          },
          gaps: {
            enableSeekFix: true,
          },
          abr: {
            autoSwitchBitrate: { video: false, audio: false },
          },
        },
        debug: {
          logLevel: 3, // LOG_LEVEL_WARNING
        },
      })

      // 5. 让 dash.js 所有 XHR 请求携带凭证（cookie）
      //    B站 CDN URL 经后端 /api/stream/proxy 代理，该接口要求登录态。
      //    dash.js 默认 XHR 不带 credentials，会导致 401 拒绝。
      //    需要对所有请求类型（MPD/fragment/init/xlink）都启用 withCredentials。
      player.setXHRWithCredentialsForType('MPD', true)
      player.setXHRWithCredentialsForType('MediaSegment', true)
      player.setXHRWithCredentialsForType('InitializationSegment', true)
      player.setXHRWithCredentialsForType('XLink', true)
      player.setXHRWithCredentialsForType('mtime', true)

      // 6. 初始化 dash.js 并加载 MPD
      //    initialize(view, source, AutoPlay, startTime)
      //    传入 startTime 让 dash.js 直接从该时间开始加载，避免先加载文件头再 seek
      player.initialize(
        this.video,
        this.mpdBlobUrl,
        false,
        startTime && startTime > 0 ? startTime : undefined
      )

      // 6.1 监听 dash.js 错误事件，记录详细错误信息用于 seek 失败诊断
      //     dash.js 在 segment 下载失败、解析错误、CORS 问题时都会触发 ERROR 事件
      player.on(dashjs.MediaPlayer.events.ERROR, (event: unknown) => {
        const e = event as { error?: { code?: string; message?: string } }
        this.lastDashError = {
          code: e.error?.code,
          message: e.error?.message,
          raw: event,
        }
        console.warn('[DashPlayer] dash.js ERROR 事件:', e.error ?? event)
      })

      // 7. 等待 metadata 加载（video.readyState >= 1）
      await this.waitForMetadata()

      this.state = 'attached'
      return this.mpdBlobUrl
    } catch (err) {
      this.cleanup()
      throw err
    }
  }

  /**
   * seek 到目标时间。
   *
   * dash.js 的 seek 机制：设置 video.currentTime = x 后，
   * dash.js 内部自动 abort 旧下载、清空 SourceBuffer、按需 Range 重新下载目标位置的 segment。
   * 不需要像 MsePlayer 那样手动管理 SourceBuffer 清理 + init segment 重 append。
   *
   * 等待 seeked 事件后再返回，避免 seek-service 的 isReloadingRef 过早释放
   * 导致后续 seeking 事件触发循环 seek。
   */
  async seekTo(targetTime: number): Promise<SeekResult> {
    if (!this.isAttached) {
      return { success: false, message: 'DashPlayer 未 attach' }
    }

    const prevState = this.state
    this.state = 'seeking'
    // 清空上次错误记录，避免误报
    this.lastDashError = null

    try {
      // 快速路径：目标在已缓冲范围内，直接 seek
      for (let i = 0; i < this.video.buffered.length; i++) {
        if (
          targetTime >= this.video.buffered.start(i) &&
          targetTime <= this.video.buffered.end(i)
        ) {
          this.video.currentTime = targetTime
          this.state = 'attached'
          return { success: true }
        }
      }

      // dash.js 的 seek 由 video.currentTime = x 触发，内部自动处理 Range 请求
      this.video.currentTime = targetTime

      // 等待 seeked 事件（dash.js 完成下载并 append）
      await this.waitForSeeked(targetTime)

      this.state = 'attached'
      return { success: true }
    } catch (err) {
      this.state = prevState
      const message = err instanceof Error ? err.message : 'seek 失败'
      // 输出详细诊断信息：video.error + dash.js 错误事件 + 缓冲状态
      const videoErr = this.video.error
      const buffered =
        this.video.buffered.length > 0
          ? `${this.video.buffered.start(0).toFixed(1)}-${this.video.buffered.end(this.video.buffered.length - 1).toFixed(1)}`
          : '空'
      console.error(
        `[DashPlayer] seek 到 ${targetTime.toFixed(1)}s 失败: ${message}\n` +
          `  video.error: ${videoErr ? `code=${videoErr.code} ${videoErr.message}` : '无'}\n` +
          `  dash.js 错误: ${this.lastDashError ? `${this.lastDashError.code || ''} ${this.lastDashError.message || ''}` : '无'}\n` +
          `  缓冲范围: ${buffered}\n` +
          `  readyState: ${this.video.readyState}\n` +
          `  networkState: ${this.video.networkState}`
      )
      // seek 超时或 video.error 视为不可恢复错误，需要上层 forceReload
      return { success: false, message, needReload: true }
    }
  }

  /** 清理所有资源：销毁 dash.js 实例 + revoke MPD Blob URL */
  cleanup(): void {
    this.state = 'disposed'
    if (this.dashPlayer) {
      try {
        this.dashPlayer.destroy()
      } catch {
        /* ignore */
      }
      this.dashPlayer = null
    }
    if (this.mpdBlobUrl) {
      URL.revokeObjectURL(this.mpdBlobUrl)
      this.mpdBlobUrl = null
    }
  }

  // ── 内部实现 ──────────────────────────────────────

  /**
   * 预下载 m4s 文件头部，解析 sidx 和 moov 的字节范围。
   *
   * 为什么需要预下载：
   * - B站 m4s 是 fMP4 格式，没有标准 MPD manifest
   * - dash.js 需要 sidx box（segment index）来计算 seek 目标位置的字节偏移
   * - 没有 sidx 时，dash.js 只能顺序播放，seek 会失败（不知道从哪里下载）
   *
   * 预下载策略：
   * 1. 首次下载 256KB，解析 moov 和第一个 sidx
   * 2. 如果 sidx 覆盖时长 < duration，下载 5MB 扫描所有 sidx box
   *    （B站 m4s 可能有多 sidx 结构，每个 sidx 索引一段视频）
   * 3. 输出诊断信息，用于判断 sidx 是否完整
   */
  private async preloadInitSegment(url: string): Promise<DashPlayerInitInfo> {
    const proxyUrl = isBilibiliMediaUrl(url) ? buildProxyUrl(url) : url
    const info: DashPlayerInitInfo = {}

    try {
      const controller = new AbortController()
      const response = await fetch(proxyUrl, {
        headers: {
          Range: `bytes=0-${INIT_SEGMENT_PRELOAD_BYTES - 1}`,
        },
        credentials: 'include',
        signal: controller.signal,
      })

      if (!response.ok && response.status !== 206) {
        console.warn(
          `[DashPlayer] 预下载 init segment 失败: status=${response.status}`
        )
        return info
      }

      // 从 Content-Range 提取文件总大小
      const contentRange = response.headers.get('Content-Range')
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/)
        if (match) {
          info.totalSize = parseInt(match[1], 10)
        }
      }
      if (!info.totalSize) {
        const contentLength = response.headers.get('Content-Length')
        if (contentLength) {
          info.totalSize = parseInt(contentLength, 10)
        }
      }

      const buffer = await response.arrayBuffer()

      // 解析 moov 范围（用于 init segment 标识）
      const moovRange = findMoovRange(buffer)
      if (moovRange) {
        info.moovRange = moovRange
        const moovEnd = parseInt(moovRange.split('-')[1], 10)
        info.initRange = `0-${moovEnd}`
        info.initEnd = moovEnd + 1
      }

      // 解析所有 sidx box
      const allSidx = findAllSidxInBuffer(buffer)
      if (allSidx.length > 0) {
        const firstSidx = allSidx[0]
        info.sidxRange = firstSidx.range
        info.sidxCount = allSidx.length

        const sidx = firstSidx.info
        if (sidx && sidx.references.length > 0) {
          const totalDuration =
            sidx.references.reduce(
              (sum, r) => sum + r.subsegmentDuration,
              0
            ) / sidx.timescale
          info.sidxCoverage = totalDuration

          // 构建 segments 列表
          const segments: DashSegmentInfo[] = []
          let currentTime = sidx.earliestPresentationTime / sidx.timescale
          // sidx box 的结束位置 = firstOffset 之前的位置
          // firstOffset 是相对于 sidx box 之后的偏移量
          const sidxEnd = parseInt(firstSidx.range.split('-')[1], 10)
          let byteOffset = sidxEnd + 1 + sidx.firstOffset

          for (const ref of sidx.references) {
            segments.push({
              startTime: currentTime,
              duration: ref.subsegmentDuration / sidx.timescale,
              byteOffset,
              byteSize: ref.referencedSize,
            })
            currentTime += ref.subsegmentDuration / sidx.timescale
            byteOffset += ref.referencedSize
          }
          info.segments = segments

          console.log(
            `[DashPlayer] sidx 详细信息（首次扫描 ${INIT_SEGMENT_PRELOAD_BYTES / 1024}KB）:\n` +
              `  sidx 数量: ${allSidx.length}\n` +
              `  第一个 sidx: references=${sidx.references.length}, range=${firstSidx.range}\n` +
              `  timescale: ${sidx.timescale}\n` +
              `  earliestPresentationTime: ${sidx.earliestPresentationTime}\n` +
              `  firstOffset: ${sidx.firstOffset}\n` +
              `  累积时长: ${totalDuration.toFixed(1)}s (后端权威 duration: ${this.duration ?? '未知'}s)\n` +
              `  segments 数量: ${segments.length}\n` +
              `  第一个 segment: start=${segments[0].startTime.toFixed(2)}s, byte=${segments[0].byteOffset}, size=${segments[0].byteSize}\n` +
              `  最后一个 segment: start=${segments[segments.length - 1].startTime.toFixed(2)}s, byte=${segments[segments.length - 1].byteOffset}, size=${segments[segments.length - 1].byteSize}\n` +
              `  文件总大小: ${info.totalSize ?? '未知'} bytes`
          )

          if (
            this.duration &&
            totalDuration < this.duration - 1
          ) {
            console.warn(
              `[DashPlayer] sidx 覆盖不足 (${totalDuration.toFixed(1)}s < ${this.duration}s)`
            )

            if (allSidx.length === 1) {
              // 单 sidx：尝试二次扫描更大范围，检测是否有多 sidx 结构
              await this.scanForMoreSidx(proxyUrl, info)
            }

            // 二次扫描后若仍覆盖不足，使用线性估算扩展 segments
            // B站 m4s 的 sidx 通常只索引前若干 segment，剩余部分需按已知 segment 的
            // 平均时长和大小估算，让 dash.js 能 seek 到 sidx 覆盖范围外的位置
            if (
              info.segments &&
              info.sidxCoverage &&
              info.sidxCoverage < this.duration - 1
            ) {
              info.segments = this.extendSegmentsWithLinearEstimation(
                info.segments,
                info.totalSize,
                this.duration
              )
              // 扩展后 sidxCoverage 已等于 duration，避免重复扩展
              info.sidxCoverage = this.duration
            }
          }
        } else {
          console.log(
            `[DashPlayer] 找到 sidx: range=${firstSidx.range}, references=${sidx?.references.length || 0}`
          )
        }
      } else {
        console.warn('[DashPlayer] 未找到 sidx box，seek 可能无法正常工作')
      }

      return info
    } catch (err) {
      console.warn('[DashPlayer] 预下载 init segment 异常:', err)
      return info
    }
  }

  /**
   * 二次扫描：下载更大范围的数据，查找所有 sidx box。
   * 用于检测 B站 m4s 是否有多 sidx 结构。
   */
  private async scanForMoreSidx(
    proxyUrl: string,
    info: DashPlayerInitInfo
  ): Promise<void> {
    try {
      const controller = new AbortController()
      const response = await fetch(proxyUrl, {
        headers: {
          Range: `bytes=0-${SIDX_SCAN_BYTES - 1}`,
        },
        credentials: 'include',
        signal: controller.signal,
      })

      if (!response.ok && response.status !== 206) {
        console.warn(
          `[DashPlayer] 二次扫描失败: status=${response.status}`
        )
        return
      }

      const buffer = await response.arrayBuffer()
      const allSidx = findAllSidxInBuffer(buffer)
      info.sidxCount = allSidx.length

      console.log(
        `[DashPlayer] 二次扫描结果 (${SIDX_SCAN_BYTES / 1024 / 1024}MB): 找到 ${allSidx.length} 个 sidx box`
      )

      // 输出每个 sidx 的覆盖范围
      let totalCoverage = 0
      for (let i = 0; i < allSidx.length; i++) {
        const sidx = allSidx[i].info
        if (sidx && sidx.references.length > 0) {
          const duration =
            sidx.references.reduce(
              (sum, r) => sum + r.subsegmentDuration,
              0
            ) / sidx.timescale
          totalCoverage += duration
          console.log(
            `[DashPlayer]   sidx[${i}]: range=${allSidx[i].range}, references=${sidx.references.length}, 时长=${duration.toFixed(1)}s`
          )
        }
      }

      if (totalCoverage > 0) {
        info.sidxCoverage = totalCoverage
        console.log(
          `[DashPlayer] sidx 总覆盖时长: ${totalCoverage.toFixed(1)}s (duration: ${this.duration}s)`
        )
      }
    } catch (err) {
      console.warn('[DashPlayer] 二次扫描异常:', err)
    }
  }

  /**
   * 线性估算扩展 segments：当 sidx 覆盖不足时，基于已知 segments 的平均时长和大小
   * 估算剩余 segments，让 dash.js 能 seek 到 sidx 覆盖范围外的位置。
   *
   * 估算策略：
   * - 使用最后 5 个 segment 的平均时长和大小作为估算基准（末尾 segment 更接近未知的剩余部分）
   * - 从最后一个 segment 的字节位置开始，按平均值逐步扩展
   * - 扩展到 duration 或 totalSize（如果已知）
   *
   * 精度说明：
   * - B站 m4s 的 segment 大小通常在 ±20% 范围内波动，估算位置可能略有偏差
   * - dash.js 在 seek 到估算位置后，会从该位置附近的 moof 开始解析
   * - 即使字节位置略有偏差，dash.js 能通过扫描 moof box 找到正确的 segment
   */
  private extendSegmentsWithLinearEstimation(
    segments: DashSegmentInfo[],
    totalSize: number | undefined,
    duration: number | undefined
  ): DashSegmentInfo[] {
    if (segments.length === 0 || !duration) {
      return segments
    }

    const lastSeg = segments[segments.length - 1]
    const coveredDuration = lastSeg.startTime + lastSeg.duration
    const coveredBytes = lastSeg.byteOffset + lastSeg.byteSize

    // 如果 sidx 已覆盖完整，不需要扩展
    if (coveredDuration >= duration - 1) {
      return segments
    }

    // 验证 totalSize 合理性：
    // 后端代理可能未返回 Content-Range 头，导致 totalSize 被错误地设置为
    // 分片大小（如 256KB）而非完整文件大小。如果 totalSize 小于已覆盖字节数，
    // 视为无效，忽略它（仅按 duration 扩展）
    const validTotalSize =
      totalSize && totalSize > coveredBytes + 1024 ? totalSize : undefined

    if (totalSize && !validTotalSize) {
      console.warn(
        `[DashPlayer] totalSize=${totalSize} 小于已覆盖字节 ${coveredBytes}，视为无效，忽略 totalSize`
      )
    }

    // 使用末尾 5 个 segment（或全部，如果不足 5 个）的平均时长和大小
    // 末尾 segment 更接近剩余部分的特征
    const sampleSize = Math.min(5, segments.length)
    const sample = segments.slice(-sampleSize)
    const estDuration =
      sample.reduce((sum, s) => sum + s.duration, 0) / sample.length
    const estSize =
      sample.reduce((sum, s) => sum + s.byteSize, 0) / sample.length

    if (estDuration <= 0 || estSize <= 0) {
      console.warn(
        '[DashPlayer] 线性估算失败: 平均时长或大小为 0',
        `estDuration=${estDuration}, estSize=${estSize}`
      )
      return segments
    }

    console.log(
      `[DashPlayer] 线性估算参数: coveredDuration=${coveredDuration.toFixed(1)}s, ` +
        `coveredBytes=${coveredBytes}, duration=${duration}s, ` +
        `totalSize=${validTotalSize ?? '无效'}, ` +
        `estDuration=${estDuration.toFixed(2)}s, estSize=${estSize} bytes`
    )

    const extended: DashSegmentInfo[] = [...segments]
    let currentTime = coveredDuration
    let byteOffset = coveredBytes

    // 扩展到 duration 或 totalSize
    const maxIterations = 5000 // 防止无限循环
    let iter = 0
    let extendedCount = 0

    while (currentTime < duration && iter < maxIterations) {
      // 如果 totalSize 已知且 byteOffset 接近或超过 totalSize，停止
      if (validTotalSize && byteOffset + estSize > validTotalSize) {
        // 最后一个 segment 可能小于平均值，按比例调整
        const remainingBytes = validTotalSize - byteOffset
        if (remainingBytes > 0) {
          const ratio = remainingBytes / estSize
          extended.push({
            startTime: currentTime,
            duration: estDuration * ratio,
            byteOffset,
            byteSize: remainingBytes,
          })
          extendedCount++
        }
        break
      }

      extended.push({
        startTime: currentTime,
        duration: estDuration,
        byteOffset,
        byteSize: estSize,
      })

      currentTime += estDuration
      byteOffset += estSize
      iter++
      extendedCount++
    }

    console.log(
      `[DashPlayer] 线性估算扩展: ${segments.length} → ${extended.length} segments ` +
        `(+${extendedCount} 估算), ` +
        `覆盖 ${coveredDuration.toFixed(1)}s → ${currentTime.toFixed(1)}s, ` +
        `字节 ${coveredBytes} → ${byteOffset} ` +
        `(avg duration=${estDuration.toFixed(2)}s, avg size=${estSize} bytes)`
    )

    return extended
  }

  /**
   * 生成虚拟 MPD manifest。
   *
   * 结构：
   * - MPD type="static"，mediaPresentationDuration 来自后端权威值
   * - 单个 Period
   * - 两个 AdaptationSet（video + audio），每个一个 Representation
   *
   * sidx 覆盖判断：
   * - sidx 覆盖完整（sidxCoverage >= duration）：使用 SegmentBase + indexRange，seek 快速准确
   * - sidx 覆盖不足（sidxCoverage < duration）：用线性估算扩展 segments，使用 SegmentList
   *   这样 dash.js 能基于估算的 segment 列表进行 seek，虽然精度略低但能正常跳转
   */
  private generateMpd(): string {
    const duration = this.duration ?? 0
    const durationStr = `PT${duration}S`
    const videoCodec = this.videoCodec || 'avc1.64001E'
    const audioCodec = this.audioCodec || 'mp4a.40.2'
    const sidxRange = this.initInfo.sidxRange
    const sidxCoverage = this.initInfo.sidxCoverage
    const segments = this.initInfo.segments
    const initEnd = this.initInfo.initEnd

    // B站 CDN URL 走后端代理（防盗链 + CORS）
    const videoUrl = isBilibiliMediaUrl(this.videoUrl)
      ? buildProxyUrl(this.videoUrl)
      : this.videoUrl
    const audioUrl = isBilibiliMediaUrl(this.audioUrl)
      ? buildProxyUrl(this.audioUrl)
      : this.audioUrl

    let videoSegmentInfo = ''

    if (segments && segments.length > 0 && initEnd !== undefined) {
      // 使用 SegmentList + SegmentTimeline（支持不等长 segments）
      // SegmentTimeline 指定每个 segment 的精确时长和起始时间，
      // 让 dash.js 能准确计算 seek 目标位置对应的 segment
      const initRange = this.initInfo.initRange || `0-${initEnd - 1}`

      // SegmentTimeline: 第一个 S 需要 t 属性指定起始时间，后续继承
      const timelineEntries = segments
        .map((seg, i) => {
          const d = Math.round(seg.duration * 1000)
          if (i === 0) {
            return `        <S t="${Math.round(seg.startTime * 1000)}" d="${d}" />`
          }
          return `        <S d="${d}" />`
        })
        .join('\n')

      const segmentUrls = segments
        .map(
          (seg) =>
            `      <SegmentURL mediaRange="${seg.byteOffset}-${seg.byteOffset + seg.byteSize - 1}"/>`
        )
        .join('\n')

      videoSegmentInfo = `<SegmentList timescale="1000">
        <Initialization range="${initRange}" />
        <SegmentTimeline>
${timelineEntries}
        </SegmentTimeline>
${segmentUrls}
      </SegmentList>`

      console.log(
        `[DashPlayer] 使用 SegmentList+SegmentTimeline (${segments.length} 个 segments, 覆盖 ${sidxCoverage?.toFixed(1)}s)`
      )
    } else if (sidxRange) {
      // fallback: SegmentBase + indexRange
      const sidxStart = parseInt(sidxRange.split('-')[0], 10)
      const initEndForBase = sidxStart - 1
      videoSegmentInfo = `<SegmentBase indexRange="${sidxRange}">
        <Initialization range="0-${initEndForBase}" />
      </SegmentBase>`
      console.log(`[DashPlayer] 使用 SegmentBase+indexRange (fallback)`)
    }

    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${durationStr}" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-main:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="${this.escapeXml(videoCodec)}" contentType="video" startWithSAP="1" segmentAlignment="true">
      <Representation id="v" bandwidth="1000000" codecs="${this.escapeXml(videoCodec)}" mimeType="video/mp4">
        <BaseURL>${this.escapeXml(videoUrl)}</BaseURL>
        ${videoSegmentInfo}
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" codecs="${this.escapeXml(audioCodec)}" contentType="audio" startWithSAP="1" segmentAlignment="true">
      <Representation id="a" bandwidth="128000" codecs="${this.escapeXml(audioCodec)}" mimeType="audio/mp4">
        <BaseURL>${this.escapeXml(audioUrl)}</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    console.log('[DashPlayer] 生成的 MPD:', mpd)

    return mpd
  }

  /** XML 特殊字符转义 */
  private escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  /** 等待 video metadata 加载完成（readyState >= 1） */
  private waitForMetadata(): Promise<void> {
    if (this.video.readyState >= 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.video.removeEventListener('loadedmetadata', onLoaded)
        this.video.removeEventListener('error', onError)
        reject(new Error('dash.js metadata 加载超时'))
      }, METADATA_TIMEOUT_MS)

      const onLoaded = () => {
        clearTimeout(timeout)
        this.video.removeEventListener('loadedmetadata', onLoaded)
        this.video.removeEventListener('error', onError)
        resolve()
      }

      const onError = () => {
        clearTimeout(timeout)
        this.video.removeEventListener('loadedmetadata', onLoaded)
        this.video.removeEventListener('error', onError)
        const err = this.video.error
        reject(
          new Error(
            `dash.js 加载失败: ${err ? `code=${err.code} ${err.message}` : '未知错误'}`
          )
        )
      }

      this.video.addEventListener('loadedmetadata', onLoaded, { once: true })
      this.video.addEventListener('error', onError, { once: true })
    })
  }

  /** 等待 video seeked 事件（dash.js 完成目标位置数据下载与 append） */
  private waitForSeeked(targetTime: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.video.removeEventListener('seeked', onSeeked)
        this.video.removeEventListener('error', onError)
        reject(new Error(`dash.js seek 到 ${targetTime.toFixed(1)}s 超时`))
      }, SEEK_TIMEOUT_MS)

      const onSeeked = () => {
        clearTimeout(timeout)
        this.video.removeEventListener('seeked', onSeeked)
        this.video.removeEventListener('error', onError)
        resolve()
      }

      const onError = () => {
        clearTimeout(timeout)
        this.video.removeEventListener('seeked', onSeeked)
        this.video.removeEventListener('error', onError)
        const err = this.video.error
        reject(
          new Error(
            `dash.js seek 期间发生错误: ${err ? `code=${err.code} ${err.message}` : '未知错误'}`
          )
        )
      }

      this.video.addEventListener('seeked', onSeeked, { once: true })
      this.video.addEventListener('error', onError, { once: true })
    })
  }
}
