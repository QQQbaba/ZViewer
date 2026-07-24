/**
 * 倍速控制（两种形态）。
 *
 * - RateSelect：桌面控制行使用的下拉选择器；
 * - RateGrid：移动端溢出菜单使用的 3 列按钮网格。
 *
 * 两种形态共享同一份 RATE_OPTIONS 与变更逻辑，仅房主可操作。
 */
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export const RATE_OPTIONS = [
  { label: '0.5x', value: '0.5' },
  { label: '0.75x', value: '0.75' },
  { label: '1x', value: '1' },
  { label: '1.25x', value: '1.25' },
  { label: '1.5x', value: '1.5' },
  { label: '2x', value: '2' },
]

export interface RateControlProps {
  video: HTMLVideoElement | null
  playbackRate: number
  isHost: boolean
}

function useRateChange({ video, isHost }: RateControlProps) {
  return (value: string) => {
    if (video && isHost) video.playbackRate = Number(value)
  }
}

/** 桌面形态：紧凑 pill 触发 + 浮层网格 */
export function RateSelect(props: RateControlProps) {
  const [open, setOpen] = useState(false)
  const handleChange = useRateChange(props)
  const currentLabel =
    RATE_OPTIONS.find((opt) => String(props.playbackRate) === opt.value)?.label ?? '1x'

  return (
    <div className="relative">
      <button
        type="button"
        disabled={!props.isHost}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'vc-icon-btn inline-flex items-center justify-center gap-0.5 rounded-lg px-1.5 text-xs font-medium transition-all duration-200',
          'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)] hover:-translate-y-0.5 hover:shadow-sm',
          'active:translate-y-0 active:scale-95',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:shadow-none',
          open && 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
        )}
      >
        {currentLabel}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div
          className="glass-strong absolute bottom-full right-0 z-[200] mb-1 w-32 rounded-lg border border-[var(--glass-border)] p-1.5 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="grid grid-cols-3 gap-1">
            {RATE_OPTIONS.map((opt) => {
              const active = String(props.playbackRate) === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={!props.isHost}
                  onClick={() => {
                    handleChange(opt.value)
                    setOpen(false)
                  }}
                  className={cn(
                    'rounded-md px-1 py-1 text-[11px] font-medium transition-colors',
                    active
                      ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)]'
                      : 'bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]',
                    !props.isHost && 'cursor-not-allowed opacity-60'
                  )}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** 移动端形态：3 列按钮网格（带标题） */
export function RateGrid(props: RateControlProps) {
  const handleChange = useRateChange(props)
  return (
    <div>
      <div
        className="mb-1 text-[10px] font-medium uppercase tracking-wide"
        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
      >
        倍速
      </div>
      <div className="grid grid-cols-3 gap-1">
        {RATE_OPTIONS.map((opt) => {
          const active = String(props.playbackRate) === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              disabled={!props.isHost}
              onClick={() => handleChange(opt.value)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)]'
                  : 'bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]',
                !props.isHost && 'cursor-not-allowed opacity-60'
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
