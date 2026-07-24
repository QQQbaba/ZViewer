/**
 * 视频控制栏（v2 重写）：纯编排组件。
 *
 * 职责拆解：
 * - useVideoControls        视频状态订阅（useSyncExternalStore + rAF 节流）
 * - useControlsVisibility   自动隐藏状态机（idle 3s / 面板打开常显 / showControls 句柄）
 * - usePanelDismiss         面板关闭（外点击 / Escape / resize）
 * - usePlayerShortcuts      键盘快捷键（Space/M/F/方向键，输入框聚焦时忽略）
 * - ProgressTrack           进度条
 * - SettingsPanel           设置面板（字幕 + 弹幕样式）
 * - DanmakuInput / VolumeControl / RateSelect   桌面/移动复用部件
 *
 * VideoControlsProps / VideoControlsHandle 契约与重写前完全一致，
 * WatchTogetherPanel 无需改动。
 */
import {
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
  memo,
  type ForwardedRef,
} from 'react'
import {
  Play,
  Pause,
  Settings,
  Maximize,
  Minimize2,
  RotateCcw,
  RotateCw,
  Hand,
} from 'lucide-react'
import { IconButton } from '@/components/VideoControls'
import { useVideoControls } from './useVideoControls'
import { ProgressTrack } from './ProgressTrack'
import { SettingsPanel } from './SettingsPanel'
import { DanmakuInput } from './parts/DanmakuInput'
import { VolumeControl } from './parts/VolumeControl'
import { RateSelect } from './parts/RateControl'
import { useControlsVisibility } from './hooks/useControlsVisibility'
import { usePanelDismiss } from './hooks/usePanelDismiss'
import { usePlayerShortcuts } from './hooks/usePlayerShortcuts'
import { fmtTime } from './format'
import { cn } from '@/lib/utils'
import type { SubtitleTrack } from '@/hooks/useSubtitles'
import type {
  DanmakuStyleState,
  DanmakuTypeFilters,
  DanmakuAdvancedStyle,
} from '@/store/danmakuStore'

/**
 * 弹幕开关图标：圆角屏幕内带“弹”字，关闭时叠加斜线。
 */
function DanmakuIcon({ off }: { off?: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="10"
        fontWeight="600"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      >
        弹
      </text>
      {off && <line x1="5" y1="5" x2="19" y2="19" />}
    </svg>
  )
}

// ── Props（保持与旧版兼容，WatchTogetherPanel 无需改动）────────────

export interface VideoControlsProps {
  video: HTMLVideoElement | null
  isHost: boolean
  readOnly?: boolean
  isDanmakuEnabled: boolean
  onToggleDanmaku: () => void
  onSendDanmaku?: (text: string) => void
  onSync?: () => void
  onReload?: () => void
  containerRef?: React.RefObject<HTMLElement | null>
  isWebFullscreen?: boolean
  onToggleWebFullscreen?: () => void
  subtitleEnabled?: boolean
  subtitleTracks?: SubtitleTrack[]
  activeTrackIndex?: number
  subtitleFontSize?: number
  onToggleSubtitles?: (enabled: boolean) => void
  onSelectSubtitleTrack?: (index: number) => void
  onAddSubtitleUrl?: (url: string, label?: string) => void
  onAddSubtitleFile?: (file: File) => void
  onChangeSubtitleFontSize?: (size: number) => void
  danmakuStyle?: DanmakuStyleState
  onDanmakuStyleChange?: (updates: Partial<DanmakuStyleState>) => void
  onDanmakuFilterChange?: (updates: Partial<DanmakuTypeFilters>) => void
  onDanmakuAdvancedChange?: (updates: Partial<DanmakuAdvancedStyle>) => void
  onResetDanmakuStyle?: () => void
  onRequestSeek?: (time: number) => void
  onRequestPause?: () => void
  onRequestPlay?: () => void
  pausePending?: boolean
  playPending?: boolean
  timeOverride?: number | null
  syncTime?: number | null
}

export interface VideoControlsHandle {
  showControls: () => void
}

// ── 主组件 ─────────────────────────────────────────────────────────

export const VideoControls = memo(
  forwardRef<VideoControlsHandle, VideoControlsProps>(function VideoControls(
    props,
    ref: ForwardedRef<VideoControlsHandle>
  ) {
    const {
      video,
      isHost,
      readOnly = false,
      isDanmakuEnabled,
      onToggleDanmaku,
      onSendDanmaku,
      onSync,
      onReload,
      containerRef,
      subtitleEnabled,
      subtitleTracks,
      activeTrackIndex,
      subtitleFontSize,
      onToggleSubtitles,
      onSelectSubtitleTrack,
      onAddSubtitleUrl,
      onAddSubtitleFile,
      onChangeSubtitleFontSize,
      danmakuStyle,
      onDanmakuStyleChange,
      onDanmakuFilterChange,
      onDanmakuAdvancedChange,
      onResetDanmakuStyle,
      onRequestSeek,
      onRequestPause,
      onRequestPlay,
      pausePending,
      playPending,
      timeOverride,
      syncTime,
    } = props

    const {
      isPlaying,
      currentTime,
      duration,
      bufferedPercent,
      volume,
      isMuted,
      playbackRate,
      isFullscreen,
      formattedCurrentTime,
      formattedDuration,
      progressPercent,
    } = useVideoControls(video)

    // timeOverride（重载期间显示目标时间而非 video.currentTime，避免进度条归零）
    const hasOverride = typeof timeOverride === 'number' && timeOverride >= 0
    const displayTime = hasOverride ? (timeOverride as number) : currentTime
    const displayPercent =
      hasOverride && duration
        ? (Math.min(duration, timeOverride as number) / duration) * 100
        : progressPercent
    const displayTimeStr = hasOverride
      ? fmtTime(timeOverride as number)
      : formattedCurrentTime

    // ── 面板开关 ────────────────────────────────────

    const [settingsOpen, setSettingsOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const panelOpen = settingsOpen

    // ── 自动隐藏 / 面板关闭 / 快捷键 ─────────────────

    const { visible, showControls } = useControlsVisibility({
      containerRef,
      panelOpen,
    })

    useImperativeHandle(ref, () => ({ showControls }), [showControls])

    const dismissPanels = useCallback(() => {
      setSettingsOpen(false)
    }, [])
    usePanelDismiss({ open: panelOpen, rootRef, onDismiss: dismissPanels })

    usePlayerShortcuts({ video, isHost, readOnly, containerRef })

    // ── 控制操作 ────────────────────────────────

    const togglePlay = () => {
      if (!video || !isHost) return
      if (video.paused) void video.play()
      else video.pause()
    }

    const handleFullscreen = async () => {
      const container = containerRef?.current
      if (!container) return
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await container.requestFullscreen()
      } catch (err) {
        console.error('[VideoControls] fullscreen:', err)
      }
    }

    const hasSettings = danmakuStyle || (isHost && subtitleEnabled !== undefined)

    const openSettings = () => {
      setSettingsOpen((prev) => !prev)
    }

    // ── 渲染 ────────────────────────────────────

    return (
      <div
        ref={rootRef}
        className={cn(
          'vc-container absolute bottom-0 left-0 right-0 z-20 p-1.5 transition-opacity duration-300',
          !visible && 'pointer-events-none opacity-0'
        )}
      >
        <div
          className="glass-strong flex flex-col gap-1 rounded-xl border border-[var(--glass-border)] px-2 py-1.5 shadow-lg"
          style={{
            boxShadow:
              '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-shadow) 40%, transparent)',
          }}
        >
          {/* 进度条 */}
          <ProgressTrack
            video={video}
            duration={duration}
            bufferedPercent={bufferedPercent}
            displayPercent={displayPercent}
            displayTime={displayTime}
            isHost={isHost}
            readOnly={readOnly}
            onRequestSeek={onRequestSeek}
            syncTime={syncTime}
          />

          {/* 控制行：左 / 中 / 右 三区 */}
          <div className="flex items-center gap-1 sm:gap-2">
            {/* 左侧：播放 + 时间 + 弹幕开关 */}
            <div className="flex items-center gap-1">
              {!readOnly && (
                <IconButton
                  icon={isPlaying ? <Pause /> : <Play />}
                  label={isPlaying ? '暂停' : '播放'}
                  disabled={!isHost}
                  onClick={togglePlay}
                />
              )}
              {readOnly && onRequestPause && (
                <IconButton
                  icon={<Hand />}
                  label="申请暂停"
                  disabled={pausePending}
                  onClick={onRequestPause}
                />
              )}
              {readOnly && onRequestPlay && (
                <IconButton
                  icon={<Play />}
                  label="申请继续播放"
                  disabled={playPending}
                  onClick={onRequestPlay}
                />
              )}

              <span
                className="hidden min-w-[4.5rem] shrink-0 select-none text-[11px] tabular-nums sm:block"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                <span style={{ color: 'var(--md-sys-color-on-surface)' }}>
                  {displayTimeStr}
                </span>{' '}
                / {formattedDuration}
              </span>

              <IconButton
                icon={<DanmakuIcon off={!isDanmakuEnabled} />}
                label={isDanmakuEnabled ? '关闭弹幕' : '开启弹幕'}
                onClick={onToggleDanmaku}
              />
            </div>

            {/* 中间：弹幕输入（桌面端自适应占满） */}
            <div className="hidden min-w-0 flex-1 items-center md:flex">
              <DanmakuInput onSend={onSendDanmaku} />
            </div>

            {/* 右侧：倍速 / 音量 / 同步 / 重载 / 设置 / 全屏 */}
            <div className="ml-auto flex items-center gap-1">
              {/* 播放参数 */}
              <div className="hidden items-center gap-1 sm:flex">
                {!readOnly && (
                  <RateSelect
                    video={video}
                    playbackRate={playbackRate}
                    isHost={isHost}
                  />
                )}
                <VolumeControl video={video} volume={volume} isMuted={isMuted} />
              </div>

              {/* 分隔线（仅桌面端） */}
              <div
                className="hidden h-5 w-px md:block"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
                }}
              />

              {/* 房间操作 */}
              <div className="hidden items-center gap-1 md:flex">
                {!readOnly && onSync && (
                  <IconButton
                    icon={<RotateCcw />}
                    label="同步进度"
                    disabled={!isHost}
                    onClick={onSync}
                  />
                )}
                {onReload && (
                  <IconButton
                    icon={<RotateCw />}
                    label="重载视频"
                    onClick={onReload}
                  />
                )}
              </div>

              {/* 系统菜单 */}
              <div className="flex items-center gap-1">
                {hasSettings && (
                  <IconButton
                    icon={<Settings />}
                    label="设置"
                    active={settingsOpen}
                    onClick={openSettings}
                  />
                )}
                <IconButton
                  icon={isFullscreen ? <Minimize2 /> : <Maximize />}
                  label={isFullscreen ? '退出全屏' : '全屏'}
                  onClick={handleFullscreen}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 设置面板 */}
        {settingsOpen && (
          <SettingsPanel
            isHost={isHost}
            danmakuStyle={danmakuStyle}
            subtitleEnabled={subtitleEnabled}
            subtitleTracks={subtitleTracks}
            activeTrackIndex={activeTrackIndex}
            subtitleFontSize={subtitleFontSize}
            onToggleSubtitles={onToggleSubtitles}
            onSelectSubtitleTrack={onSelectSubtitleTrack}
            onAddSubtitleUrl={onAddSubtitleUrl}
            onAddSubtitleFile={onAddSubtitleFile}
            onChangeSubtitleFontSize={onChangeSubtitleFontSize}
            onDanmakuStyleChange={onDanmakuStyleChange}
            onDanmakuFilterChange={onDanmakuFilterChange}
            onDanmakuAdvancedChange={onDanmakuAdvancedChange}
            onResetDanmakuStyle={onResetDanmakuStyle}
          />
        )}
      </div>
    )
  })
)
