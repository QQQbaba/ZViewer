/**
 * 计数式事件抑制 ref。
 *
 * 背景：suppressEventsRef 是跨 hook 共享的"事件抑制"标记——房主/观众在
 * attach、恢复、seek、缓冲下载等异步流程期间抑制 video 事件广播，避免
 * 中间态被广播给观众/写入服务器播放记忆。
 *
 * 旧实现为单布尔，存在"先完成者提前释放抑制窗口"问题：
 * 流程 A（观众加入的缓冲下载，可持续数分钟）与流程 B（一次普通状态同步）
 * 重叠时，B 完成后把 suppress 置 false，A 仍在下载中事件抑制即失效，
 * 后续 attach/error/seeking 事件泄漏广播。
 *
 * 实现：写入 true = 获取一次抑制（计数 +1），写入 false = 释放一次（-1），
 * 读取 current = 计数 > 0。每个异步流程应保证 true/false 成对出现
 * （try/finally）；resetSuppression 供"新加载代际"等全局重置点强制清零
 * （旧流程的抑制作废，避免悬挂计数导致永久抑制）。
 */
import type { MutableRefObject } from 'react'

/** 计数式抑制 ref 的内部结构（__suppressCount 为内部计数存储）。 */
interface CountedSuppressRef extends MutableRefObject<boolean> {
  __suppressCount: number
}

/** 创建计数式事件抑制 ref（接口与普通 useRef(boolean) 完全兼容）。 */
export function createSuppressRef(): MutableRefObject<boolean> {
  const holder = {
    __suppressCount: 0,
  } as CountedSuppressRef
  Object.defineProperty(holder, 'current', {
    get: () => holder.__suppressCount > 0,
    set: (v: boolean) => {
      holder.__suppressCount = v
        ? holder.__suppressCount + 1
        : Math.max(0, holder.__suppressCount - 1)
    },
  })
  return holder
}

/**
 * 强制清零抑制计数。
 *
 * 仅在"新加载代际"等全局重置点调用（loadMovie / reloadBilibili / previewPlay
 * 启动时）：此时所有旧流程的抑制语义已作废，清零可避免异常路径漏释放导致
 * 的悬挂计数（永久抑制）。对非计数式 ref 退化为直接置 false。
 */
export function resetSuppression(ref: MutableRefObject<boolean>): void {
  const holder = ref as CountedSuppressRef
  if (typeof holder.__suppressCount === 'number') {
    holder.__suppressCount = 0
  } else {
    ref.current = false
  }
}
