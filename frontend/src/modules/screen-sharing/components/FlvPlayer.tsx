/**
 * FlvPlayer —— HTTP-FLV 拉流播放器（ArtPlayer 版）。
 *
 * 基于 ArtPlayer（isLive 模式）+ flv.js：
 * - 控制栏（播放/音量/全屏）由 ArtPlayer 提供，附自定义「刷新」控件
 * - 保留重构前全部行为：指数退避重连（最多 5 次）、卡顿自动追帧、
 *   统计信息每秒上报、自动播放静音重试
 * - props 契约与重构前完全一致（WatchPage / StreamPushPage 无需改动）
 */
import { useEffect, useRef, useState } from 'react'
import flvjs from 'flv.js'
import Artplayer from 'artplayer'
import { Spinner } from '@/components/ui/Spinner'
import { configureArtStatics } from '@/modules/art-player'
import { cn } from '@/lib/utils'
import '@/modules/art-player/art-overrides.css'

/** flv.js 统计信息
 *
 * 注意：flv.js 的 STATISTICS_INFO 事件只提供网络层统计，
 * 不提供 videoDataRate/audioDataRate 等编码层信息。
 * 帧率通过 decodedFrames 差值自行计算，
 * 总码率近似为 speed（下载速度 KB/s）× 8。
 */
export interface FlvStatistics {
  /** 网络下载速度 (KB/s) */
  speed: number
  /** 当前近似总码率 (Kbps)，由 speed × 8 计算得出 */
  totalDataRate: number
  /** 当前帧率（fps），由 decodedFrames 差值 / 时间差计算） */
  fps: number
  /** 已解码帧数 */
  decodedFrames: number
  /** 丢帧数 */
  droppedFrames: number
}

interface FlvPlayerProps {
  /** 拉流地址（HTTP-FLV），例如 http://host:3335/live/xxx.flv */
  src: string
  /** 是否自动播放 */
  autoPlay?: boolean
  /** 是否静音（默认 true，处理浏览器自动播放策略） */
  muted?: boolean
  /** 附加 className */
  className?: string
  /** 拉流出错时回调 */
  onError?: (error: Error) => void
  /** 状态变化回调 */
  onStatusChange?: (
    status: 'connecting' | 'playing' | 'error' | 'stopped'
  ) => void
  /** 统计信息回调（每秒触发） */
  onStatistics?: (stats: FlvStatistics) => void
}

const MAX_RETRY = 5
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]

/** 刷新图标（ArtPlayer 控件用内联 SVG） */
const REFRESH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>`

export function FlvPlayer({
  src,
  autoPlay = true,
  muted = true,
  className,
  onError,
  onStatusChange,
  onStatistics,
}: FlvPlayerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [reloadVersion, setReloadVersion] = useState(0)

  // 用 ref 存储回调，避免内联函数引用变化导致 useEffect 重新执行（播放器闪烁）
  const onErrorRef = useRef(onError)
  const onStatusChangeRef = useRef(onStatusChange)
  const onStatisticsRef = useRef(onStatistics)
  const mutedRef = useRef(muted)

  useEffect(() => {
    onErrorRef.current = onError
    onStatusChangeRef.current = onStatusChange
    onStatisticsRef.current = onStatistics
    mutedRef.current = muted
  }, [onError, onStatusChange, onStatistics, muted])

  // 创建 ArtPlayer + flv.js（src 变化 / 手动刷新时重建）
  useEffect(() => {
    const container = containerRef.current
    if (!container || !src) return
    if (!flvjs.isSupported()) {
      const err = new Error('当前浏览器不支持 MSE / flv.js')
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 错误处理
      setErrorMsg(err.message)
      onErrorRef.current?.(err)
      onStatusChangeRef.current?.('error')
      return
    }

    configureArtStatics()

    let retryCount = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    // 帧率计算：flv.js STATISTICS_INFO 不直接提供 fps，通过 decodedFrames 差值计算
    let lastStatsTime = 0
    let lastDecodedFrames = 0

    setLoading(true)
    setErrorMsg(null)
    onStatusChangeRef.current?.('connecting')

    // ── ArtPlayer 实例（isLive 隐藏进度条与时间显示）────────────
    const art = new Artplayer({
      container,
      url: '',
      lang: 'zh-cn',
      isLive: true,
      muted: mutedRef.current,
      autoplay: false,
      hotkey: false,
      pip: false,
      screenshot: false,
      setting: false,
      loop: false,
      flip: false,
      playbackRate: false,
      aspectRatio: false,
      fullscreen: true,
      fullscreenWeb: false,
      subtitleOffset: false,
      miniProgressBar: false,
      airplay: false,
      mutex: true,
      backdrop: true,
      playsInline: true,
      moreVideoAttr: {
        playsInline: true,
      },
    })
    // 空 url 初始化会让 ArtPlayer 一直显示 loading，延迟隐藏
    const hideLoadingTimer = setTimeout(() => {
      art.loading.show = false
    }, 100)

    const video = art.video
    video.muted = mutedRef.current

    // 「刷新」控件：重建播放器
    art.controls.add({
      name: 'refresh',
      position: 'right',
      index: 60,
      html: REFRESH_ICON,
      tooltip: '刷新',
      click() {
        setReloadVersion((v) => v + 1)
      },
    })

    // ── flv.js 实例 ──────────────────────────────────────
    const player = flvjs.createPlayer(
      {
        type: 'flv',
        url: src,
        isLive: true,
        cors: true,
      },
      {
        enableWorker: false,
        enableStashBuffer: true,
        stashInitialSize: 256,
        // 自动清理已播放的 SourceBuffer，防止内存膨胀
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 8,
        autoCleanupMinBackwardDuration: 4,
        // 直播延迟追赶：缓冲超过阈值时自动追帧（flv.js 运行时支持，类型定义缺失）
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 1.5,
        liveBufferLatencyTargetLatency: 0.5,
      } as Record<string, unknown>
    )
    player.attachMediaElement(video)
    player.on(flvjs.Events.ERROR, (errorType: string, errorDetail: string) => {
      console.error('[FlvPlayer] error:', errorType, errorDetail)
      if (retryCount < MAX_RETRY) {
        const delay = RETRY_DELAYS_MS[retryCount]
        retryCount += 1
        console.log(`[FlvPlayer] retry ${retryCount}/${MAX_RETRY} in ${delay}ms`)
        onStatusChangeRef.current?.('connecting')
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          player.unload()
          player.load()
          try {
            const ret = player.play()
            if (ret && typeof ret.catch === 'function') ret.catch(() => {})
          } catch {
            // ignore
          }
        }, delay)
      } else {
        const err = new Error(
          `拉流失败（${errorType}/${errorDetail}），已重试 ${MAX_RETRY} 次`
        )
        setErrorMsg(err.message)
        onErrorRef.current?.(err)
        onStatusChangeRef.current?.('error')
      }
    })
    player.on(flvjs.Events.MEDIA_INFO, () => {
      retryCount = 0
      setLoading(false)
      setErrorMsg(null)
    })

    // 统计信息上报（flv.js 内部约每秒触发一次）
    player.on(flvjs.Events.STATISTICS_INFO, (info: Record<string, unknown>) => {
      const now = performance.now()
      const decodedFrames = (info.decodedFrames as number) ?? 0
      const droppedFrames = (info.droppedFrames as number) ?? 0
      const speed = (info.speed as number) ?? 0

      let fps = 0
      if (lastStatsTime > 0) {
        const dt = (now - lastStatsTime) / 1000
        const frameDelta = decodedFrames - lastDecodedFrames
        if (dt > 0 && frameDelta >= 0) {
          fps = Math.round(frameDelta / dt)
        }
      }
      lastStatsTime = now
      lastDecodedFrames = decodedFrames

      onStatisticsRef.current?.({
        speed: Math.round(speed),
        totalDataRate: Math.round(speed * 8),
        fps,
        decodedFrames,
        droppedFrames,
      })
    })

    // 兜底：当 video 元素实际拿到画面时关闭 loading（部分流 MEDIA_INFO 触发较晚或不触发）
    const handleLoadedMetadata = () => {
      retryCount = 0
      setLoading(false)
      setErrorMsg(null)
    }
    video.addEventListener('loadedmetadata', handleLoadedMetadata)

    // 卡死自动恢复：当视频暂停但 buffered 有数据时，向前跳过一小段恢复播放
    const handleWaiting = () => {
      if (video.readyState < 3) {
        const buffered = video.buffered
        if (buffered.length > 0) {
          const bufferedEnd = buffered.end(buffered.length - 1)
          if (bufferedEnd - video.currentTime > 0.5) {
            video.currentTime = bufferedEnd - 0.3
            console.log('[FlvPlayer] recovered from stall, seek to', video.currentTime)
          }
        }
      }
    }
    video.addEventListener('waiting', handleWaiting)

    // 兜底：video 播放卡住但未触发 waiting 时，通过定时器检测 stalled 状态
    const stallCheckTimer = setInterval(() => {
      if (!video.paused && video.readyState < 3) {
        const buffered = video.buffered
        if (buffered.length > 0) {
          const bufferedEnd = buffered.end(buffered.length - 1)
          if (bufferedEnd - video.currentTime > 0.5) {
            video.currentTime = bufferedEnd - 0.3
            console.log(
              '[FlvPlayer] recovered from stall (timer), seek to',
              video.currentTime
            )
          }
        }
      }
    }, 3000)

    player.on(flvjs.Events.LOADING_COMPLETE, () => {
      // 直播流不应触发 LOADING_COMPLETE，触发说明流已结束
      console.warn('[FlvPlayer] loading complete (stream ended)')
      onStatusChangeRef.current?.('stopped')
    })
    player.load()
    if (autoPlay) {
      const tryPlay = async () => {
        try {
          const ret = video.play()
          if (ret && typeof ret.catch === 'function') {
            await ret.catch(async (err: Error) => {
              console.warn('[FlvPlayer] autoplay failed:', err)
              if (!video.muted) {
                video.muted = true
                try {
                  await video.play()
                  console.log('[FlvPlayer] muted autoplay succeeded')
                } catch (mutedErr) {
                  console.warn('[FlvPlayer] muted autoplay failed:', mutedErr)
                }
              }
            })
          }
        } catch (err) {
          console.warn('[FlvPlayer] autoplay failed:', err)
        }
      }
      void tryPlay()
    }

    onStatusChangeRef.current?.('playing')

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('waiting', handleWaiting)
      clearInterval(stallCheckTimer)
      clearTimeout(hideLoadingTimer)
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      try {
        player.unload()
        player.detachMediaElement()
        player.destroy()
      } catch (err) {
        console.error('[FlvPlayer] destroy error:', err)
      }
      try {
        art.destroy(false)
      } catch (err) {
        console.warn('[FlvPlayer] art destroy error:', err)
      }
    }
  }, [src, autoPlay, reloadVersion])

  return (
    <div className={cn('zart-stage group', className)}>
      <div ref={containerRef} className="h-full w-full" />

      {loading && !errorMsg && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <Spinner tip="正在连接直播流..." size={32} />
        </div>
      )}
      {errorMsg && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
          <div className="text-base font-medium text-[var(--md-sys-color-error)]">
            {errorMsg}
          </div>
          <div className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
            请检查网络连接或房主推流状态
          </div>
          <button
            type="button"
            className="mt-1 rounded-lg border border-white/20 px-4 py-1.5 text-sm text-white transition-colors hover:bg-white/10"
            onClick={() => setReloadVersion((v) => v + 1)}
          >
            重新连接
          </button>
        </div>
      )}
    </div>
  )
}
