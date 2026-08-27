/**
 * 浏览器 <video>/MSE 原生支持的音频编码白名单。
 *
 * 与旧版后端 services/ffmpeg BROWSER_SUPPORTED_AUDIO_CODECS 保持一致；
 * 不在此列表中的编码（DTS/AC3/EAC3/TrueHD 等）由 wasm-engine 在浏览器内
 * 实时转码为 AAC。未知编码（audioCodec 为 null/空）不在转码范围——
 * 与旧行为一致，保守回退原生播放（可能无声）。
 */
export const BROWSER_SUPPORTED_AUDIO_CODECS = [
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'flac',
] as const

/** 判断音轨编码是否需要浏览器端 wasm 转码。null（未知）返回 false。 */
export function needsWasmAudioTranscode(
  audioCodec: string | null | undefined
): boolean {
  if (!audioCodec) return false
  return !(BROWSER_SUPPORTED_AUDIO_CODECS as readonly string[]).includes(
    audioCodec.toLowerCase()
  )
}
