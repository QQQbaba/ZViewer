import { useSyncExternalStore } from 'react'
import type { BilibiliCodec, BilibiliParseOptions } from './types'

// re-export 便于调用方从单一入口导入
export type { BilibiliCodec }

/** localStorage 持久化 key */
const STORAGE_KEY = 'zcontrol:bilibili-parse-options'
/** 旧版独立 key（迁移用） */
const LEGACY_PREFER_MP4_KEY = 'zc-prefer-mp4'
/** 跨组件同步用的自定义事件名 */
const OPTIONS_CHANGE_EVENT = 'zcontrol:bilibili-parse-options-change'

function readBilibiliParseOptions(): BilibiliParseOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as BilibiliParseOptions
      // 一次性迁移：旧版 preferMp4 存在独立 key 中
      if (parsed.preferMp4 === undefined) {
        const legacy = localStorage.getItem(LEGACY_PREFER_MP4_KEY)
        if (legacy === 'true') {
          parsed.preferMp4 = true
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
        }
        localStorage.removeItem(LEGACY_PREFER_MP4_KEY)
      }
      return parsed
    }
    // 旧版无 STORAGE_KEY 但有独立 preferMp4 key
    const legacy = localStorage.getItem(LEGACY_PREFER_MP4_KEY)
    if (legacy === 'true') {
      localStorage.removeItem(LEGACY_PREFER_MP4_KEY)
      return { preferMp4: true }
    }
  } catch {
    // 忽略 localStorage 读取异常
  }
  return {}
}

export function getBilibiliParseOptions(): BilibiliParseOptions & {
  codec: BilibiliCodec
  preferMp4: boolean
} {
  const stored = readBilibiliParseOptions()
  const codec = stored.codec || 'auto'
  const preferMp4 = stored.preferMp4 === true
  return { ...stored, codec, preferMp4 }
}

export function setBilibiliParseOptions(
  options: Partial<BilibiliParseOptions>
): void {
  const current = readBilibiliParseOptions()
  const next: BilibiliParseOptions = { ...current, ...options }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 忽略写入异常（例如隐私模式）
  }
  // 派发自定义事件，通知订阅者（同一窗口内的其他组件）
  cachedSnapshot = getBilibiliParseOptions()
  window.dispatchEvent(new Event(OPTIONS_CHANGE_EVENT))
}

// ===== 跨组件同步 hook =====
// 解析偏好存储在 localStorage，但 MovieListPanel 与 MoviePushPanel 是兄弟组件，
// 需要一个跨组件同步机制。使用 useSyncExternalStore + 自定义事件实现轻量同步，
// 避免创建额外的 Zustand store。

let cachedSnapshot = getBilibiliParseOptions()

function subscribePreference(callback: () => void): () => void {
  window.addEventListener(OPTIONS_CHANGE_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(OPTIONS_CHANGE_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

function getPreferenceSnapshot() {
  return cachedSnapshot
}

/**
 * 读取 B站 解析偏好（codec + preferMp4），跨组件同步。
 * 任一组件通过 setBilibiliParseOptions 修改偏好后，所有使用此 hook 的组件都会更新。
 */
export function useBilibiliParsePreferences() {
  return useSyncExternalStore(
    subscribePreference,
    getPreferenceSnapshot,
    getPreferenceSnapshot
  )
}
