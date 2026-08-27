import { useCallback, useEffect, useRef, useState } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { apiFetch } from '@/lib/api'
import {
  detectFormat,
  parseSubtitle,
  getSubtitleLabel,
  type SubtitleFormat,
  type ParsedCue,
} from '@/lib/subtitleParser'
import {
  extractEmbeddedSubtitle,
  resolveServerFile,
  buildServerFileProxyUrl,
} from '@/modules/server-files/serverFilesApi'
import {
  probeMkvSubtitleTracks,
  streamMkvSubtitleTrack,
} from '@/modules/subtitles/mkv-embedded'
import { appendAuthToken } from '@/modules/player/services/url-proxy'

export interface SubtitleTrack {
  cues: ParsedCue[]
  label: string
  lang?: string
}

/** 服务器文件内嵌字幕轨道（含用于展示的 label）。 */
export interface EmbeddedTrackInfo {
  index: number
  codecName: string
  language: string | null
  title: string | null
  label: string
  /** MKV TrackNumber（前端提取路径的轨道标识；后端 ffmpeg 轨道无此字段） */
  trackNumber?: number
  /** 前端 demux 提取（非后端 ffmpeg）时为 true */
  frontend?: boolean
}

/**
 * 内嵌字幕提取的源描述。
 * - server-files：后端本地文件路径
 * - webdav / openlist：中转与直链均可——直链时前端 MKV demux 是唯一路径
 *   （后端 ffmpeg 无法访问直链），失败静默（无回退）
 * - emby / jellyfin：直接用其自带字幕接口（PlaybackInfo / Subtitles Stream），不受直链限制
 * url：可 fetch 的中转/代理/直链 URL（提供时优先走前端 MKV demux 提取）
 * directLink：直链模式标记——后端 ffmpeg 端点不可用，前端失败时不回退
 */
export type EmbeddedSource =
  | { kind: 'server-files'; path: string; url?: string }
  | { kind: 'webdav'; movieId: number; url?: string; directLink?: boolean }
  | { kind: 'openlist'; movieId: number; url?: string; directLink?: boolean }
  | { kind: 'emby'; movieId: number }
  | { kind: 'jellyfin'; movieId: number }

/** 后端字幕提取返回的格式 → subtitleParser 的 SubtitleFormat（'webvtt' → 'vtt'）。 */
function mapOutputFormat(format: string): SubtitleFormat {
  switch (format) {
    case 'ass':
      return 'ass'
    case 'webvtt':
      return 'vtt'
    case 'smi':
      return 'smi'
    case 'sub':
      return 'sub'
    default:
      return 'srt'
  }
}

/** 生成内封字幕轨道的展示标签。 */
function embeddedTrackLabel(track: {
  title?: string | null
  language?: string | null
  index: number
}): string {
  return track.title || track.language || `轨道 ${track.index}`
}

export interface SubtitleState {
  subtitleEnabled: boolean
  subtitleTracks: SubtitleTrack[]
  activeTrackIndex: number
  subtitleFontSize: number
  /** 字幕时间偏移（秒），正值延迟显示，负值提前显示 */
  subtitleOffset: number
  /** 字幕水平位移（百分比，-50~50），正值右移 */
  subtitleShiftX: number
  /** 字幕垂直位移（百分比，-50~50），正值下移 */
  subtitleShiftY: number
  /** 字幕字体族（CSS font-family），空串表示默认 */
  subtitleFontFamily: string
}

interface SubtitleBroadcastPayload {
  enabled: boolean
  tracks: SubtitleTrack[]
  activeIndex: number
  fontSize: number
  offset: number
  shiftX?: number
  shiftY?: number
  fontFamily?: string
}

export interface UseSubtitlesOptions {
  roomId: string
  isHost: boolean
}

const DEFAULT_SUBTITLE_STATE: SubtitleState = {
  subtitleEnabled: false,
  subtitleTracks: [],
  activeTrackIndex: -1,
  subtitleFontSize: 20,
  subtitleOffset: 0,
  subtitleShiftX: 0,
  subtitleShiftY: 0,
  subtitleFontFamily: '',
}

/**
 * 字幕状态管理 + socket 同步。
 *
 * - 房主：调用 set* 方法变更状态并广播 `subtitle-update`
 * - 观众：监听 `subtitle-update` 自动应用相同配置
 *
 * 所有格式（SRT/ASS/SSA/VTT/SMI/SUB）解析为 ParsedCue[]，
 * 保留各格式的位置/对齐/样式信息，由自定义渲染层直接显示。
 * ParsedCue[] 是纯数据，可通过 socket 直接 JSON 序列化同步给观众。
 */
export function useSubtitles({ roomId, isHost }: UseSubtitlesOptions) {
  const { socket } = useSocket()
  const [state, setState] = useState<SubtitleState>(DEFAULT_SUBTITLE_STATE)

  // 观众本地偏好标记：观众自行修改过字幕设置（开关/轨道/字号/偏移）后，
  // 房主广播的 subtitle-update 只更新轨道数据，不再覆盖观众的本地选择。
  const viewerPrefTouchedRef = useRef(false)
  /**
   * 内嵌字幕自动加载防重入标记：
   * StrictMode 双执行 / sourceUrl·开关异步初始化会重跑加载 effect，
   * 首次加载还在 await 探测时二次调用会与首路并行、重复建轨
   * （如 2 条字幕轨变成 4 条）。相同 URL 的 loading/done 均直接跳过；
   * clearTracks 只重置 done（loading 流无法取消，保留标记防并行）。
   */
  const embeddedAutoLoadRef = useRef<{
    url: string
    status: 'loading' | 'done'
  } | null>(null)

  const broadcast = useCallback(
    (next: SubtitleState) => {
      if (!socket || !isHost) return
      const payload: SubtitleBroadcastPayload = {
        enabled: next.subtitleEnabled,
        tracks: next.subtitleTracks,
        activeIndex: next.activeTrackIndex,
        fontSize: next.subtitleFontSize,
        offset: next.subtitleOffset,
        shiftX: next.subtitleShiftX,
        shiftY: next.subtitleShiftY,
        fontFamily: next.subtitleFontFamily,
      }
      socket.emit('subtitle-update', { roomId, ...payload })
    },
    [socket, roomId, isHost]
  )

  const setEnabled = useCallback(
    (enabled: boolean) => {
      // 观众本地切换开关：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = {
          ...prev,
          subtitleEnabled: enabled,
          activeTrackIndex:
            enabled &&
            prev.activeTrackIndex < 0 &&
            prev.subtitleTracks.length > 0
              ? 0
              : prev.activeTrackIndex,
        }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  const setActiveTrack = useCallback(
    (index: number) => {
      // 观众本地切换轨道：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, activeTrackIndex: index }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  /**
   * 解析字幕内容并添加为轨道。
   *
   * 内部使用：将原始文本按格式解析为 ParsedCue[]，直接存入轨道。
   */
  const addParsedTrack = useCallback(
    (
      content: string,
      filename: string,
      format: SubtitleFormat,
      customLabel?: string,
      lang?: string
    ) => {
      const cues = parseSubtitle(content, format)
      const label = customLabel?.trim() || getSubtitleLabel(filename)

      setState((prev) => {
        const track: SubtitleTrack = {
          cues,
          label: label || `字幕 ${prev.subtitleTracks.length + 1}`,
          lang: lang?.trim() || undefined,
        }
        const next: SubtitleState = {
          ...prev,
          subtitleTracks: [...prev.subtitleTracks, track],
          subtitleEnabled: true,
          activeTrackIndex: prev.subtitleTracks.length,
        }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  const addTrackFromUrl = useCallback(
    async (url: string, label?: string, lang?: string) => {
      const trimmedUrl = url.trim()
      if (!trimmedUrl) return

      // fetch 内容后综合文件名+内容检测格式
      try {
        const res = await fetch(trimmedUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const content = await res.text()
        const detected = detectFormat(trimmedUrl, content)
        const filename =
          trimmedUrl.split('/').pop()?.split('?')[0] || 'subtitle'
        addParsedTrack(content, filename, detected, label, lang)
      } catch (err) {
        console.error('[useSubtitles] fetch subtitle URL failed:', err)
        // fetch 失败时添加空轨道
        setState((prev) => {
          const track: SubtitleTrack = {
            cues: [],
            label: label?.trim() || `字幕 ${prev.subtitleTracks.length + 1}`,
            lang: lang?.trim() || undefined,
          }
          const next: SubtitleState = {
            ...prev,
            subtitleTracks: [...prev.subtitleTracks, track],
            subtitleEnabled: true,
            activeTrackIndex: prev.subtitleTracks.length,
          }
          broadcast(next)
          return next
        })
      }
    },
    [broadcast, addParsedTrack]
  )

  const addTrackFromFile = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = () => {
        const content = reader.result
        if (typeof content !== 'string') return
        const format = detectFormat(file.name, content)
        addParsedTrack(content, file.name, format)
      }
      reader.onerror = () => {
        console.error('[useSubtitles] read file error:', reader.error)
      }
      reader.readAsText(file)
    },
    [addParsedTrack]
  )

  /**
   * 从字幕内容直接添加轨道（供目录浏览器使用）。
   */
  const addTrackFromContent = useCallback(
    (content: string, filename: string, format: string) => {
      const fmt = format.toLowerCase() as SubtitleFormat
      addParsedTrack(content, filename, fmt)
    },
    [addParsedTrack]
  )

  const clearTracks = useCallback(() => {
    // 清理自动加载的 URL 标记：done（已加载完）允许下次重新加载；
    // loading（进行中）保留——正在加载的流无法取消，标记继续防并行重入
    if (embeddedAutoLoadRef.current?.status === 'done') {
      embeddedAutoLoadRef.current = null
    }
    setState((prev) => {
      const next: SubtitleState = {
        ...prev,
        subtitleTracks: [],
        subtitleEnabled: false,
        activeTrackIndex: -1,
        subtitleOffset: 0,
      }
      broadcast(next)
      return next
    })
  }, [broadcast])

  /**
   * 自动搜索影片同目录下的字幕文件并加载。
   */
  const searchAutoSubtitles = useCallback(
    async (movieId: number): Promise<number> => {
      if (!isHost) return 0
      try {
        const res = await apiFetch(`/api/subtitles/search?movieId=${movieId}`)
        const data = (await res.json()) as {
          success: boolean
          subtitles?: { filename: string; format: string; content: string }[]
          message?: string
        }
        if (!res.ok || !data.success || !data.subtitles) {
          return 0
        }

        const found = data.subtitles
        if (found.length === 0) return 0

        // 解析所有字幕并构建轨道列表
        const newTracks: SubtitleTrack[] = found.map((sub) => {
          const format = sub.format as SubtitleFormat
          const cues = parseSubtitle(sub.content, format)
          const label = getSubtitleLabel(sub.filename) || sub.filename
          return { cues, label, lang: undefined }
        })

        // 一次性更新状态（清空旧轨道 + 加载新轨道）
        setState((prev) => {
          const next: SubtitleState = {
            ...prev,
            subtitleTracks: newTracks,
            subtitleEnabled: true,
            activeTrackIndex: 0,
          }
          broadcast(next)
          return next
        })
        return found.length
      } catch (err) {
        console.error('[useSubtitles] auto search failed:', err)
        return 0
      }
    },
    [isHost, broadcast]
  )

  /**
   * 前端流式提取 MKV 字幕轨：首段到达即建轨生效（秒级可播），
   * 后台逐批补齐 cues，无需等完整提取。
   *
   * - 首段到达 → resolve（字幕已开始播放）
   * - 首段前失败 / 轨为空 → reject（调用方走回退）
   * - 首段后中断 → 已提取部分保留，仅记录错误
   * - 提取过程不广播（cues 逐批增长，全量广播代价随进度二次增长），
   *   完成后广播一次全量同步观众
   *
   * @param activate 建轨时是否激活为当前字幕轨
   */
  const streamEmbeddedTrack = useCallback(
    (
      url: string,
      track: { trackNumber: number; label: string; language: string | null },
      activate: boolean
    ): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        let trackIndex = -1
        let settled = false
        let broadcastDone = false
        streamMkvSubtitleTrack(url, track.trackNumber, {
          onChunk: (chunk) => {
            const cues = parseSubtitle(chunk.text, chunk.format)
            if (cues.length === 0) return
            setState((prev) => {
              if (trackIndex < 0) {
                // 去重：相同 label 的轨道已存在（手动重复提取 / 并行流）
                // 时复用它，避免重复建轨（如 2 条字幕轨变 4 条）
                const existing = prev.subtitleTracks.findIndex(
                  (t) => t.label === track.label
                )
                if (existing >= 0) {
                  trackIndex = existing
                  return {
                    ...prev,
                    subtitleTracks: prev.subtitleTracks.map((t, i) =>
                      i === existing ? { ...t, cues: [...t.cues, ...cues] } : t
                    ),
                  }
                }
                trackIndex = prev.subtitleTracks.length
                const next: SubtitleState = {
                  ...prev,
                  subtitleTracks: [
                    ...prev.subtitleTracks,
                    {
                      cues,
                      label: track.label,
                      lang: track.language || undefined,
                    },
                  ],
                  subtitleEnabled: true,
                  activeTrackIndex: activate ? trackIndex : prev.activeTrackIndex,
                }
                return next
              }
              return {
                ...prev,
                subtitleTracks: prev.subtitleTracks.map((t, i) =>
                  i === trackIndex ? { ...t, cues: [...t.cues, ...cues] } : t
                ),
              }
            })
            if (!settled) {
              settled = true
              resolve()
            }
          },
        }).then(
          () => {
            if (!settled) {
              settled = true
              reject(new Error('字幕轨为空'))
              return
            }
            // 提取完成：广播全量同步观众（updater 返回原引用不触发渲染）
            setState((prev) => {
              if (!broadcastDone) {
                broadcastDone = true
                broadcast(prev)
              }
              return prev
            })
          },
          (err) => {
            if (!settled) {
              settled = true
              reject(err)
            } else {
              console.error(
                '[useSubtitles] 流式提取中断（保留已提取部分）：',
                err instanceof Error ? err.message : err
              )
              setState((prev) => {
                if (!broadcastDone) {
                  broadcastDone = true
                  broadcast(prev)
                }
                return prev
              })
            }
          }
        )
      })
    },
    [] // setState 稳定；broadcast 不在流式过程中使用（完成时快照）
  )

  /**
   * 加载视频文件中的内嵌字幕轨道。
   * @param filePath server-files 路径（后端回退链路使用）
   * @param sourceUrl 挂载源（webdav/openlist，中转或直链）播放 URL——
   *   提供时走前端提取且失败无后端回退（直链后端不可访问；中转的
   *   回退需要 movieId，由手动提取路径承担）
   */
  const loadEmbeddedSubtitles = useCallback(
    async (filePath: string, sourceUrl?: string): Promise<number> => {
      if (!isHost) return 0

      // mkv-embedded 的 fetch 无法携带 Authorization 头，
      // 本站 /api/ URL 必须附加 token query（与播放引擎 appendAuthToken 一致），
      // 否则 401 → 探测失败显示「未检测到内嵌字幕」。直链 URL 原样返回。
      const url = appendAuthToken(sourceUrl ?? buildServerFileProxyUrl(filePath))

      // 防并行重入：同一 URL 加载中（首路还在探测）或已完成时，
      // StrictMode/effect 重跑的二次调用直接跳过，避免重复建轨
      if (embeddedAutoLoadRef.current?.url === url) return 0
      embeddedAutoLoadRef.current = { url, status: 'loading' }

      // 前端路径：MKV demux 探测 + 流式提取（原后端 ffmpeg 职责）
      try {
        const probed = await probeMkvSubtitleTracks(url)
        const extractable = probed.filter((t) => t.supported)
        let started = 0
        for (const track of extractable) {
          try {
            // 逐轨 await 首段（秒级），后台继续补齐后续 cues
            await streamEmbeddedTrack(
              url,
              {
                trackNumber: track.trackNumber,
                label: track.label,
                language: track.language,
              },
              started === 0 // 首条成功轨激活；后续轨保持当前激活不变
            )
            started++
          } catch (err) {
            console.error(
              '[useSubtitles] frontend stream embedded subtitle failed:',
              track.trackNumber,
              err
            )
          }
        }
        if (started > 0) {
          // 首段已到达、字幕轨已生效，后台继续补齐，无需等待
          embeddedAutoLoadRef.current = { url, status: 'done' }
          return started
        }
        // 挂载源（sourceUrl 模式）：无后端回退（直链后端不可访问；
        // 中转自动加载无 movieId 回退链路，交给手动提取路径兜底）
        if (sourceUrl) {
          console.info(
            '[useSubtitles] 挂载源前端提取内嵌字幕不可用（非 MKV / 位图字幕轨 / CORS 拒绝），跳过自动加载'
          )
          embeddedAutoLoadRef.current = null
          return 0
        }
        // 前端一条都没提出来（如全部为位图字幕轨）→ 回退后端链路
      } catch (err) {
        if (sourceUrl) {
          console.info(
            '[useSubtitles] 挂载源前端探测内嵌字幕失败，跳过（直链/中转自动加载无回退）：',
            err instanceof Error ? err.message : err
          )
          embeddedAutoLoadRef.current = null
          return 0
        }
        console.info(
          '[useSubtitles] 前端探测内嵌字幕失败，回退后端 ffmpeg：',
          err instanceof Error ? err.message : err
        )
      }

      // 后端回退链路（仅 server-files：非 MKV 容器 / 位图字幕轨 / 前端探测失败）
      let tracks: {
        index: number
        language: string | null
        title: string | null
      }[]
      try {
        const resolved = await resolveServerFile(filePath)
        tracks = resolved.subtitleTracks ?? []
      } catch (err) {
        console.error(
          '[useSubtitles] resolve server file for embedded subtitles failed:',
          err
        )
        embeddedAutoLoadRef.current = null
        return 0
      }
      if (tracks.length === 0) {
        embeddedAutoLoadRef.current = { url, status: 'done' }
        return 0
      }

      const backendLoaded: SubtitleTrack[] = []
      for (const track of tracks) {
        try {
          const result = await extractEmbeddedSubtitle(filePath, track.index)
          const cues = parseSubtitle(
            result.content,
            mapOutputFormat(result.format)
          )
          const label = embeddedTrackLabel(track)
          backendLoaded.push({ cues, label, lang: track.language || undefined })
        } catch (err) {
          console.error(
            '[useSubtitles] extract embedded subtitle failed:',
            track.index,
            err
          )
        }
      }

      if (backendLoaded.length === 0) {
        embeddedAutoLoadRef.current = { url, status: 'done' }
        return 0
      }

      setState((prev) => {
        const next: SubtitleState = {
          ...prev,
          subtitleTracks: [...prev.subtitleTracks, ...backendLoaded],
          subtitleEnabled:
            prev.subtitleEnabled || prev.subtitleTracks.length === 0,
          activeTrackIndex:
            prev.subtitleTracks.length === 0 ? 0 : prev.activeTrackIndex,
        }
        broadcast(next)
        return next
      })
      embeddedAutoLoadRef.current = { url, status: 'done' }
      return backendLoaded.length
    },
    [isHost, broadcast]
  )

  /**
   * 列出视频文件内的内嵌字幕轨道（仅探测，不提取内容）。
   * 供 UI 先展示可用轨道，再由用户挑选某一条提取播放。
   * 优先前端 MKV demux 探测（server-files / 有中转 URL 的挂载源），
   * 失败回退后端探测端点。
   */
  const listEmbeddedTracks = useCallback(
    async (source: EmbeddedSource): Promise<EmbeddedTrackInfo[]> => {
      if (!isHost) return []
      // 前端探测：server-files 恒有代理 URL；挂载源（中转/直链）带 URL 时同样可探测。
      // /api/ URL 需附加 token query（同播放引擎），否则 401 探测失败
      if (source.kind !== 'emby' && source.kind !== 'jellyfin') {
        const url = appendAuthToken(
          source.kind === 'server-files'
            ? source.url || buildServerFileProxyUrl(source.path)
            : source.url
        )
        if (url) {
          try {
            const probed = await probeMkvSubtitleTracks(url)
            if (probed.length > 0) {
              return probed.map((t, i) => ({
                index: i,
                codecName: t.codecId,
                language: t.language,
                title: t.title,
                label: t.label,
                trackNumber: t.trackNumber,
                frontend: true,
              }))
            }
            return [] // MKV 无字幕轨，无需后端再探测
          } catch (err) {
            // 直链模式：后端 ffmpeg 无法访问直链，无回退（常见失败原因：
            // 直链服务器未开 CORS、非 MKV 容器）
            if (
              (source.kind === 'webdav' || source.kind === 'openlist') &&
              source.directLink
            ) {
              console.info(
                '[useSubtitles] 直链前端探测字幕轨失败（无后端回退）：',
                err instanceof Error ? err.message : err
              )
              return []
            }
            console.info(
              '[useSubtitles] 前端探测字幕轨失败，回退后端：',
              err instanceof Error ? err.message : err
            )
          }
        }
      }
      try {
        if (source.kind === 'server-files') {
          const resolved = await resolveServerFile(source.path)
          const tracks = resolved.subtitleTracks ?? []
          return tracks.map((t) => ({
            index: t.index,
            codecName: t.codecName,
            language: t.language,
            title: t.title,
            label: embeddedTrackLabel(t),
          }))
        }
        // 挂载源（服务器中转）：通过 movieId 走后端探测端点
        const res = await apiFetch(
          `/api/subtitles/embedded-tracks?movieId=${source.movieId}`
        )
        const data = (await res.json()) as {
          success: boolean
          tracks?: EmbeddedTrackInfo[]
          message?: string
        }
        if (!res.ok || !data.success || !data.tracks) {
          throw new Error(data.message || '获取内嵌字幕轨道失败')
        }
        return data.tracks
      } catch (err) {
        console.error('[useSubtitles] list embedded tracks failed:', err)
        return []
      }
    },
    [isHost]
  )

  /**
   * 提取指定一条内嵌字幕轨道并添加为可播放的字幕轨道。
   * 优先前端 MKV demux 提取（track.frontend 标记），失败回退后端
   * ffmpeg 提取（ass/webvtt/srt），保留 ASS 样式。
   */
  const extractEmbeddedTrack = useCallback(
    async (
      source: EmbeddedSource,
      track: EmbeddedTrackInfo
    ): Promise<number> => {
      if (!isHost) return 0

      // 前端提取路径：探测阶段标记的 MKV 轨道
      if (track.frontend && track.trackNumber != null) {
        // /api/ URL 需附加 token query（同播放引擎），否则 401 提取失败
        const rawUrl =
          source.kind === 'server-files'
            ? source.url || buildServerFileProxyUrl(source.path)
            : source.kind === 'webdav' || source.kind === 'openlist'
              ? source.url
              : undefined
        const url = rawUrl ? appendAuthToken(rawUrl) : undefined
        if (url) {
          try {
            // 流式提取：首段到达即建轨生效（秒级可播），后台补齐
            await streamEmbeddedTrack(
              url,
              {
                trackNumber: track.trackNumber,
                label: track.label,
                language: track.language,
              },
              true
            )
            return 1
          } catch (err) {
            console.error(
              '[useSubtitles] frontend extract embedded track failed:',
              track.trackNumber,
              err
            )
            // 直链模式：后端 ffmpeg 无法访问直链，无回退
            if (
              (source.kind === 'webdav' || source.kind === 'openlist') &&
              source.directLink
            ) {
              return 0
            }
            // 落到后端回退
          }
        }
      }

      try {
        let content: string
        let format: string
        let label: string
        let language: string | null
        if (source.kind === 'server-files') {
          const result = await extractEmbeddedSubtitle(source.path, track.index)
          content = result.content
          format = result.format
          label = result.label
          language = result.language
        } else {
          const res = await apiFetch(
            `/api/subtitles/embedded-extract?movieId=${source.movieId}&index=${track.index}`
          )
          const data = (await res.json()) as {
            success: boolean
            content?: string
            format?: string
            label?: string
            language?: string | null
            message?: string
          }
          if (!res.ok || !data.success || !data.content) {
            throw new Error(data.message || '提取内嵌字幕失败')
          }
          content = data.content
          format = data.format || 'srt'
          label = data.label || `轨道 ${track.index}`
          language = data.language ?? null
        }
        const cues = parseSubtitle(content, mapOutputFormat(format))
        const newTrack: SubtitleTrack = {
          cues,
          label: track.label || label || embeddedTrackLabel(track),
          lang: language || track.language || undefined,
        }
        setState((prev) => {
          // 去重：相同 label 的轨道已存在（重复手动提取）时激活它而非重复建轨
          const existing = prev.subtitleTracks.findIndex(
            (t) => t.label === newTrack.label
          )
          if (existing >= 0) {
            return prev
          }
          const next: SubtitleState = {
            ...prev,
            subtitleTracks: [...prev.subtitleTracks, newTrack],
            subtitleEnabled: true,
            activeTrackIndex: prev.subtitleTracks.length,
          }
          broadcast(next)
          return next
        })
        return 1
      } catch (err) {
        console.error(
          '[useSubtitles] extract embedded track failed:',
          track.index,
          err
        )
        return 0
      }
    },
    [isHost, broadcast]
  )

  const setFontSize = useCallback(
    (size: number) => {
      // 观众本地调字号：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleFontSize: size }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setOffset = useCallback(
    (offset: number) => {
      // 观众本地调偏移：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleOffset: offset }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setShiftX = useCallback(
    (shiftX: number) => {
      // 观众本地调水平位移：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleShiftX: shiftX }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setShiftY = useCallback(
    (shiftY: number) => {
      // 观众本地调垂直位移：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleShiftY: shiftY }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setFontFamily = useCallback(
    (fontFamily: string) => {
      // 观众本地换字体：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleFontFamily: fontFamily }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  // 观众：接收房主的字幕广播
  useEffect(() => {
    if (!socket || isHost) return
    const handler = (
      payload: Partial<SubtitleBroadcastPayload> | undefined
    ) => {
      if (!payload) return
      // 观众改过本地偏好（开关/轨道/字号/偏移）后，房主广播只更新轨道
      // 数据；偏好字段保持观众本地选择。未改过则全量跟随房主。
      const touched = viewerPrefTouchedRef.current
      setState((prev) => ({
        subtitleEnabled: touched
          ? prev.subtitleEnabled
          : payload.enabled ?? prev.subtitleEnabled,
        subtitleTracks: payload.tracks ?? prev.subtitleTracks,
        activeTrackIndex: touched
          ? prev.activeTrackIndex
          : payload.activeIndex ?? prev.activeTrackIndex,
        subtitleFontSize: touched
          ? prev.subtitleFontSize
          : payload.fontSize ?? prev.subtitleFontSize,
        subtitleOffset: touched
          ? prev.subtitleOffset
          : payload.offset ?? prev.subtitleOffset,
        subtitleShiftX: touched
          ? prev.subtitleShiftX
          : payload.shiftX ?? prev.subtitleShiftX,
        subtitleShiftY: touched
          ? prev.subtitleShiftY
          : payload.shiftY ?? prev.subtitleShiftY,
        subtitleFontFamily: touched
          ? prev.subtitleFontFamily
          : payload.fontFamily ?? prev.subtitleFontFamily,
      }))
    }
    socket.on('subtitle-update', handler)
    // 加入时后端在 request-join 处理中回发的 subtitle-update 早于此
    // 监听器挂载（组件渲染后才有 useEffect），会丢失。挂载完成后主动
    // 拉取一次房主缓存的字幕状态，确保中途加入/刷新的观众也能拿到字幕。
    socket.emit('subtitle-request', { roomId })
    return () => {
      socket.off('subtitle-update', handler)
    }
  }, [socket, isHost, roomId])

  return {
    ...state,
    setEnabled,
    setActiveTrack,
    addTrackFromUrl,
    addTrackFromFile,
    addTrackFromContent,
    clearTracks,
    searchAutoSubtitles,
    loadEmbeddedSubtitles,
    listEmbeddedTracks,
    extractEmbeddedTrack,
    setFontSize,
    setOffset,
    setShiftX,
    setShiftY,
    setFontFamily,
  }
}
