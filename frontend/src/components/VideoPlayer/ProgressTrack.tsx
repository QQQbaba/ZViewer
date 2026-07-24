import {
  useRef,
  useState,
  useCallback,
  useEffect,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { cn } from '@/lib/utils'
import { fmtTime } from './format'

interface ProgressTrackProps {
  video: HTMLVideoElement | null
  duration: number
  bufferedPercent: number
  /** 已播放进度（含 timeOverride 覆盖），0-100 */
  displayPercent: number
  /** 当前展示时间（含 timeOverride 覆盖），用于键盘步进基准 */
  displayTime: number
  isHost: boolean
  readOnly: boolean
  onRequestSeek?: (time: number) => void
  /** 服务器同步线位置（秒） */
  syncTime?: number | null
}

/**
 * 进度条：轨道 / 缓冲 / 已播放 / 拖拽手柄 / 同步线 / 时间提示。
 *
 * 防跳动机制（pendingSeek）：
 * - 拖拽结束 / 键盘步进 / seeking 事件触发时，记录目标 seek 时间到 pendingSeek。
 * - fillPercent 优先使用 pendingSeek 计算，持续显示目标位置，
 *   不依赖 timeupdate 事件（有几十毫秒延迟，会导致进度条先跳回旧位置再跳到新位置）。
 * - 当 displayPercent（来自 useVideoControls 的 timeupdate）追上 pendingSeek
 *   （差异 < 0.5%）时清除，切换回 displayPercent。
 * - 超时 1.5s 兜底清除，防止 seek 失败或观众端申请被拒绝时永久锁定。
 *
 * 仅房主或只读观众（带 onRequestSeek）可拖拽；
 * 键盘快进/快退由 document 级快捷键统一处理（usePlayerShortcuts），
 * 本组件仅保留 tabIndex 与 ARIA 供无障碍访问。
 */
export function ProgressTrack({
  video,
  duration,
  bufferedPercent,
  displayPercent,
  displayTime,
  isHost,
  readOnly,
  onRequestSeek,
  syncTime,
}: ProgressTrackProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState({
    visible: false,
    x: 0,
    time: 0,
    dragging: false,
  })
  /** seek 锁定：期间进度条显示此目标时间，避免等待 timeupdate 导致跳动 */
  const [pendingSeek, setPendingSeek] = useState<number | null>(null)

  const canSeek = isHost || (readOnly && !!onRequestSeek)

  const computeTime = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track || !duration) return 0
      const rect = track.getBoundingClientRect()
      return (
        Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) *
        Math.max(0, duration)
      )
    },
    [duration]
  )

  const handleMouseDown = (e: ReactMouseEvent) => {
    if (!duration || !video) return
    if (!isHost && !readOnly) return
    if (readOnly && !onRequestSeek) return
    e.preventDefault()
    const startTime = computeTime(e.clientX)
    setTooltip((p) => ({ ...p, visible: true, dragging: true, time: startTime }))
    // 拖拽开始时清除上一次的 pendingSeek，避免冲突
    setPendingSeek(null)

    const onMove = (ev: MouseEvent) =>
      setTooltip((p) => ({ ...p, time: computeTime(ev.clientX) }))
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const t = computeTime(ev.clientX)
      // 锁定目标位置：拖拽结束后立即显示新位置，不等 timeupdate
      setPendingSeek(t)
      if (readOnly) onRequestSeek?.(t)
      else if (isHost && video) video.currentTime = t
      setTooltip((p) => ({ ...p, dragging: false }))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleMouseMove = (e: ReactMouseEvent) => {
    const track = trackRef.current
    if (!track || !duration) return
    const rect = track.getBoundingClientRect()
    setTooltip((p) => ({
      ...p,
      visible: true,
      x: Math.min(rect.width, Math.max(0, e.clientX - rect.left)),
      time: computeTime(e.clientX),
    }))
  }

  const handleMouseLeave = () =>
    setTooltip((p) => ({ ...p, visible: p.dragging, dragging: false }))

  // 监听 seeking 事件：捕获键盘步进等非拖拽 seek，立即锁定目标位置
  useEffect(() => {
    if (!video || !duration) return
    const onSeeking = () => setPendingSeek(video.currentTime)
    video.addEventListener('seeking', onSeeking)
    return () => video.removeEventListener('seeking', onSeeking)
  }, [video, duration])

  // displayPercent 追上 pendingSeek 时清除锁定
  useEffect(() => {
    if (pendingSeek == null || !duration) return
    const targetPercent = (pendingSeek / duration) * 100
    if (Math.abs(displayPercent - targetPercent) < 0.5) {
      setPendingSeek(null)
    }
  }, [displayPercent, duration, pendingSeek])

  // 超时兜底清除：防止 seek 失败或观众端申请被拒绝时永久锁定
  useEffect(() => {
    if (pendingSeek == null) return
    const id = setTimeout(() => setPendingSeek(null), 1500)
    return () => clearTimeout(id)
  }, [pendingSeek])

  // fillPercent 优先级：拖拽中 > pendingSeek 锁定 > displayPercent
  const fillPercent =
    tooltip.dragging && duration
      ? (tooltip.time / duration) * 100
      : pendingSeek != null && duration
        ? (pendingSeek / duration) * 100
        : displayPercent

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label="视频进度"
      aria-valuemin={0}
      aria-valuemax={Math.floor(duration)}
      aria-valuenow={Math.floor(displayTime)}
      tabIndex={canSeek ? 0 : -1}
      className={cn(
        'group relative h-5 cursor-default select-none py-2',
        canSeek && 'cursor-pointer'
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* 轨道 */}
      <div
        className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 16%, transparent)',
        }}
      />
      {/* 缓冲 */}
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
        style={{
          width: `${bufferedPercent}%`,
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 24%, transparent)',
        }}
      />
      {/* 已播放 */}
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
        style={{
          width: `${fillPercent}%`,
          backgroundColor: 'var(--md-sys-color-primary)',
        }}
      />
      {/* 拖拽手柄 */}
      {canSeek && (
        <div
          className={cn(
            'absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary)] shadow transition-all',
            readOnly ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          style={{
            left: `${fillPercent}%`,
            transform: `translate(-50%, -50%) ${
              tooltip.dragging ? 'scale(1.3)' : 'scale(1)'
            }`,
          }}
        />
      )}
      {/* 服务器同步线 */}
      {typeof syncTime === 'number' && syncTime >= 0 && duration > 0 && (
        <div
          className="pointer-events-auto absolute bottom-0.5 z-10 h-2.5 w-0.5 rounded-full"
          style={{
            left: `${(syncTime / duration) * 100}%`,
            backgroundColor: 'var(--md-sys-color-tertiary)',
            transform: 'translateX(-50%)',
          }}
          title={`服务器进度: ${fmtTime(syncTime)}`}
        />
      )}
      {/* 时间提示 */}
      {tooltip.visible && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded px-2 py-1 text-xs font-medium"
          style={{
            left: tooltip.x,
            backgroundColor: 'var(--md-sys-color-inverse-surface)',
            color: 'var(--md-sys-color-inverse-on-surface)',
          }}
        >
          {fmtTime(tooltip.time)}
        </div>
      )}
    </div>
  )
}
