/** 将秒数格式化为 mm:ss 或 h:mm:ss */
export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '00:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const mm = m.toString().padStart(2, '0')
  const ss = sec.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
