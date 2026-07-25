/**
 * 播放器键盘快捷键 Hook（document 级）。
 *
 * 快捷键（与主流播放器一致）：
 * - Space        播放 / 暂停（仅房主可操作）
 * - M            静音切换
 * - F            全屏切换
 * - ← / →        快退 / 快进 5s（Shift：10s，仅房主）
 * - ↑ / ↓        音量 +/- 0.05
 *
 * 防护规则：
 * - 事件目标位于 input / textarea / select / contenteditable 时忽略，
 *   不影响弹幕输入框与聊天输入框打字；
 * - readOnly 观众端仅开放音量与全屏（播放/跳转无权限，与按钮 disabled 一致）。
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

export interface UsePlayerShortcutsOptions {
  video: HTMLVideoElement | null
  isHost: boolean
  readOnly: boolean
  /** 全屏目标容器 */
  containerRef?: RefObject<HTMLElement | null>
  /** 后端解析的权威视频时长（秒）。传入后 ←/→ 快进快退以此为边界，
   *  避免 MSE seek 期间 video.duration 临时变短导致跳转受限。 */
  duration?: number
}

/** 事件目标是否为可输入元素（打字场景，不触发快捷键） */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function usePlayerShortcuts({
  video,
  isHost,
  readOnly,
  containerRef,
  duration: authoritativeDuration,
}: UsePlayerShortcutsOptions): void {
  useEffect(() => {
    if (!video) return

    const canControlPlayback = isHost && !readOnly

    const toggleFullscreen = async () => {
      const container = containerRef?.current
      if (!container) return
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await container.requestFullscreen()
      } catch (err) {
        console.error('[usePlayerShortcuts] fullscreen:', err)
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return

      switch (e.key) {
        case ' ':
          if (!canControlPlayback) return
          e.preventDefault()
          if (video.paused) void video.play()
          else video.pause()
          break
        case 'm':
        case 'M':
          video.muted = !video.muted
          break
        case 'f':
        case 'F':
          e.preventDefault()
          void toggleFullscreen()
          break
        case 'ArrowLeft':
        case 'ArrowRight': {
          const totalDuration =
            Number.isFinite(authoritativeDuration) && authoritativeDuration! > 0
              ? authoritativeDuration
              : video.duration
          if (!canControlPlayback || !totalDuration) return
          e.preventDefault()
          const step = (e.shiftKey ? 10 : 5) * (e.key === 'ArrowLeft' ? -1 : 1)
          video.currentTime = Math.min(
            totalDuration,
            Math.max(0, video.currentTime + step)
          )
          break
        }
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault()
          const delta = e.key === 'ArrowUp' ? 0.05 : -0.05
          video.volume = Math.min(1, Math.max(0, video.volume + delta))
          if (video.volume > 0) video.muted = false
          break
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [video, isHost, readOnly, containerRef, authoritativeDuration])
}
