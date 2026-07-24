/**
 * 面板关闭 Hook：统一管理「外点击 / Escape / 窗口 resize」三种关闭路径。
 *
 * 溢出菜单与设置面板共用：任一打开时生效；
 * 点击发生在控制栏根节点内部时不关闭（面板本身是根节点的子元素）。
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

export interface UsePanelDismissOptions {
  /** 是否有面板打开 */
  open: boolean
  /** 控制栏根节点 ref：点击其内部不视为「外点击」 */
  rootRef: RefObject<HTMLElement | null>
  /** 触发关闭时调用（父组件负责把所有面板置为关闭） */
  onDismiss: () => void
}

export function usePanelDismiss({
  open,
  rootRef,
  onDismiss,
}: UsePanelDismissOptions): void {
  useEffect(() => {
    if (!open) return

    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return
      onDismiss()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    const onResize = () => onDismiss()

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open, rootRef, onDismiss])
}
