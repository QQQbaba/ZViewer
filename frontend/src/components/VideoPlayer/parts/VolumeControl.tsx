/**
 * 音量控制：悬浮触发按钮 + 竖向滑块弹窗，节省控制栏横向空间。
 *
 * - 点击扬声器图标切换静音
 * - 悬停图标弹出竖向音量滑块，拖动或点击轨道调节音量
 * - 静音时滑块显示 0，拖动滑块到 0 等价于静音
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { IconButton } from '@/components/VideoControls'

export interface VolumeControlProps {
  video: HTMLVideoElement | null
  volume: number
  isMuted: boolean
}

interface VerticalSliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  height?: number
  onChange: (value: number) => void
}

function VerticalSlider({
  value,
  min = 0,
  max = 1,
  step = 0.05,
  height = 80,
  onChange,
}: VerticalSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const clamped = Math.min(max, Math.max(min, value))
  const percent = ((clamped - min) / (max - min)) * 100

  const updateFromClientY = useCallback(
    (clientY: number) => {
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const ratio = 1 - (clientY - rect.top) / rect.height
      const stepped = Math.round((ratio * (max - min)) / step) * step + min
      onChange(Math.min(max, Math.max(min, stepped)))
    },
    [min, max, step, onChange]
  )

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    updateFromClientY(e.clientY)
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    setDragging(true)
    updateFromClientY(e.touches[0].clientY)
  }

  useEffect(() => {
    if (!dragging) return

    const handleMouseMove = (e: MouseEvent) => updateFromClientY(e.clientY)
    const handleTouchMove = (e: TouchEvent) => updateFromClientY(e.touches[0].clientY)
    const handleEnd = () => setDragging(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleEnd)
    window.addEventListener('touchmove', handleTouchMove)
    window.addEventListener('touchend', handleEnd)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleEnd)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleEnd)
    }
  }, [dragging, updateFromClientY])

  return (
    <div
      ref={trackRef}
      className="relative cursor-pointer rounded-full"
      style={{ width: 4, height }}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent)',
        }}
      />
      <div
        className="absolute bottom-0 left-0 right-0 rounded-full"
        style={{
          height: `${percent}%`,
          backgroundColor: 'var(--md-sys-color-primary)',
        }}
      />
      <div
        className="absolute left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border-2 shadow transition-transform"
        style={{
          bottom: `calc(${percent}% - 6px)`,
          backgroundColor: 'var(--md-sys-color-primary)',
          borderColor: 'var(--md-sys-color-primary)',
          transform: `translateX(-50%) scale(${dragging ? 1.25 : 1})`,
        }}
      />
    </div>
  )
}

export function VolumeControl({ video, volume, isMuted }: VolumeControlProps) {
  const muted = isMuted || volume === 0

  const toggleMute = () => {
    if (video) video.muted = !video.muted
  }

  const handleVolumeChange = (v: number) => {
    if (video) {
      video.volume = v
      video.muted = v === 0
    }
  }

  return (
    <div className="group relative flex items-center">
      {/* 竖向音量弹窗 */}
      <div className="absolute bottom-full left-1/2 z-50 flex -translate-x-1/2 flex-col items-center opacity-0 transition-opacity duration-200 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
        <div
          className="glass-strong flex flex-col items-center gap-1.5 rounded-xl border border-[var(--glass-border)] p-2 shadow-lg"
          style={{
            boxShadow:
              '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-shadow) 40%, transparent)',
          }}
        >
          <span
            className="text-xs font-semibold tabular-nums"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
          >
            {Math.round((muted ? 0 : volume) * 100)}
          </span>
          <VerticalSlider
            value={muted ? 0 : volume}
            min={0}
            max={1}
            step={0.05}
            height={72}
            onChange={handleVolumeChange}
          />
          <button
            type="button"
            onClick={toggleMute}
            className="rounded-full p-1 transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            title={muted ? '取消静音' : '静音'}
          >
            {muted ? (
              <VolumeX className="h-3.5 w-3.5" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        {/* 透明悬停桥接，避免鼠标经过间隙时弹窗消失 */}
        <div className="h-2 w-full" />
      </div>

      <IconButton
        icon={muted ? <VolumeX /> : <Volume2 />}
        label={muted ? '取消静音' : '静音'}
        onClick={toggleMute}
      />
    </div>
  )
}
