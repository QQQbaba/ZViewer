import type { BilibiliCodec, BilibiliParseOptions } from './types'

/** localStorage 持久化 key */
const STORAGE_KEY = 'zcontrol:bilibili-parse-options'

function readBilibiliParseOptions(): BilibiliParseOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as BilibiliParseOptions
  } catch {
    // 忽略 localStorage 读取异常
  }
  return {}
}

export function getBilibiliParseOptions(): BilibiliParseOptions & {
  codec: BilibiliCodec
} {
  const stored = readBilibiliParseOptions()
  const codec = stored.codec || 'auto'
  return { ...stored, codec }
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
}
