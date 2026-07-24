/**
 * 控制栏自动隐藏 Hook。
 *
 * 行为规则（与重写前一致）：
 * - 鼠标在容器内移动：立即显示，3s 无操作后自动隐藏；
 * - 鼠标离开容器：取消隐藏计时（保持当前显示状态）；
 * - 任意面板（溢出菜单 / 设置面板）打开期间：不自动隐藏；
 * - showControls() 句柄：外部（如视频点击）强制唤醒一次。
 *
 * 计时器全部收敛在本 Hook 内，主组件不再直接管理 setTimeout。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const IDLE_HIDE_DELAY_MS = 3000

export interface UseControlsVisibilityOptions {
  /** 播放容器：监听其 mousemove / mouseleave */
  containerRef?: RefObject<HTMLElement | null>
  /** 是否有面板打开（溢出菜单 / 设置面板）：打开期间不自动隐藏 */
  panelOpen: boolean
}

export interface UseControlsVisibilityReturn {
  visible: boolean
  /** 强制显示并重置隐藏计时（绑定到 VideoControlsHandle.showControls） */
  showControls: () => void
}

export function useControlsVisibility({
  containerRef,
  panelOpen,
}: UseControlsVisibilityOptions): UseControlsVisibilityReturn {
  const [visible, setVisible] = useState(true)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // latest ref：面板开关状态变化时无需重绑容器监听
  const panelOpenRef = useRef(panelOpen)
  useEffect(() => {
    panelOpenRef.current = panelOpen
  }, [panelOpen])

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }, [])

  const scheduleHide = useCallback(() => {
    clearIdleTimer()
    if (panelOpenRef.current) return
    idleTimerRef.current = setTimeout(
      () => setVisible(false),
      IDLE_HIDE_DELAY_MS
    )
  }, [clearIdleTimer])

  const showControls = useCallback(() => {
    setVisible(true)
    scheduleHide()
  }, [scheduleHide])

  // 面板打开期间取消计时保持常显；面板从打开变为关闭时恢复计时。
  // 注意：初始挂载不调度隐藏（与旧版一致——初始常显，直到首次鼠标活动）。
  const prevPanelOpenRef = useRef(panelOpen)
  useEffect(() => {
    const wasOpen = prevPanelOpenRef.current
    prevPanelOpenRef.current = panelOpen
    if (panelOpen) {
      clearIdleTimer()
    } else if (wasOpen && visible) {
      scheduleHide()
    }
  }, [panelOpen, visible, clearIdleTimer, scheduleHide])

  // 容器鼠标活动监听
  useEffect(() => {
    const container = containerRef?.current
    const onMove = () => {
      setVisible(true)
      scheduleHide()
    }
    const onLeave = () => clearIdleTimer()
    container?.addEventListener('mousemove', onMove)
    container?.addEventListener('mouseleave', onLeave)
    return () => {
      container?.removeEventListener('mousemove', onMove)
      container?.removeEventListener('mouseleave', onLeave)
      clearIdleTimer()
    }
  }, [containerRef, scheduleHide, clearIdleTimer])

  // 卸载清理
  useEffect(() => () => clearIdleTimer(), [clearIdleTimer])

  return { visible, showControls }
}
