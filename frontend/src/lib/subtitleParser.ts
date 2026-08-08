/**
 * 多格式字幕解析器
 *
 * 支持 SRT、ASS/SSA、VTT、SMI、SUB(MicroDVD) 格式，
 * 统一转换为 WebVTT 供浏览器原生 <track> 元素渲染。
 *
 * 设计要点：
 * - 纯前端解析，无需后端参与
 * - 转换为 WebVTT Blob URL，兼容原生 <track> 元素
 * - ASS/SSA 格式剥离高级样式标签，保留基础文本（粗体/斜体/颜色）
 * - SMI 格式解析 <SYNC> 标签，提取文本
 * - SUB(MicroDVD) 格式解析帧号时间码
 */

// ── 公共类型 ──────────────────────────────────────────────

/** 字幕格式类型 */
export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'smi' | 'sub' | 'unknown'

/** 解析后的字幕条目 */
interface SubtitleCue {
  start: number // 秒
  end: number // 秒
  text: string
}

// ── 格式检测 ──────────────────────────────────────────────

/** 从文件扩展名推断格式 */
export function detectFormatFromExtension(filename: string): SubtitleFormat {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'vtt':
      return 'vtt'
    case 'srt':
      return 'srt'
    case 'ass':
    case 'ssa':
      return 'ass'
    case 'smi':
    case 'sami':
      return 'smi'
    case 'sub':
      return 'sub'
    default:
      return 'unknown'
  }
}

/** 从内容特征推断格式（当扩展名无法判断时使用） */
export function detectFormatFromContent(content: string): SubtitleFormat {
  const trimmed = content.trim()
  if (trimmed.startsWith('WEBVTT')) return 'vtt'
  if (/^\[Script Info\]/i.test(trimmed) || /^\[Events\]/i.test(trimmed))
    return 'ass'
  if (/<SAMI>/i.test(trimmed) || /<SYNC/i.test(trimmed)) return 'smi'
  // SRT: 以数字序号开头，后跟时间码行
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/m.test(trimmed)) return 'srt'
  // MicroDVD: {帧号}{帧号}文本
  if (/^\{\d+\}\{\d+\}/m.test(trimmed)) return 'sub'
  return 'unknown'
}

/** 综合文件名和内容检测格式 */
export function detectFormat(
  filename: string,
  content: string
): SubtitleFormat {
  const byExt = detectFormatFromExtension(filename)
  if (byExt !== 'unknown') return byExt
  return detectFormatFromContent(content)
}

// ── 时间码工具 ─────────────────────────────────────────────

/** 将秒数格式化为 VTT 时间码 HH:MM:SS.mmm */
function formatVttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const milli = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`
}

/** 解析 SRT 时间码 HH:MM:SS,mmm → 秒 */
function parseSrtTime(timeStr: string): number {
  const match = timeStr.match(
    /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/
  )
  if (!match) return 0
  const [, h, m, s, ms] = match
  return (
    parseInt(h) * 3600 +
    parseInt(m) * 60 +
    parseInt(s) +
    parseInt(ms.padEnd(3, '0')) / 1000
  )
}

/** 解析 ASS/SSA 时间码 H:MM:SS.CS（百分秒）→ 秒 */
function parseAssTime(timeStr: string): number {
  const match = timeStr.match(/(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,2})/)
  if (!match) return 0
  const [, h, m, s, cs] = match
  return (
    parseInt(h) * 3600 +
    parseInt(m) * 60 +
    parseInt(s) +
    parseInt(cs.padEnd(2, '0')) / 100
  )
}

// ── SRT 解析 ──────────────────────────────────────────────

function parseSrt(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  // 以空行分割块，每块包含序号、时间码、文本
  const blocks = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n\s*\n/)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length < 2) continue

    // 找到包含 --> 的时间码行
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'))
    if (timeLineIndex < 0) continue

    const timeMatch = lines[timeLineIndex].match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/
    )
    if (!timeMatch) continue

    const start = parseSrtTime(timeMatch[1])
    const end = parseSrtTime(timeMatch[2])
    const text = lines
      .slice(timeLineIndex + 1)
      .join('\n')
      .trim()

    if (text) {
      cues.push({ start, end, text })
    }
  }

  return cues
}

// ── ASS/SSA 解析 ──────────────────────────────────────────

/** ASS 样式覆盖标签映射 */
const ASS_TAG_MAP: Record<string, (open: boolean) => string> = {
  b: (open) => (open ? '<b>' : '</b>'),
  i: (open) => (open ? '<i>' : '</i>'),
  u: (open) => (open ? '<u>' : '</u>'),
  s: (open) => (open ? '<s>' : '</s>'),
}

/**
 * 清理 ASS 文本中的样式覆盖标签，保留基础 HTML 标签。
 *
 * {\b1}粗体{\b0} → <b>粗体</b>
 * {\i1}斜体{\i0} → <i>斜体</i>
 * {\c&HFFFFFF&}颜色 → 剥离（VTT ::cue 不支持内联颜色）
 * {其他标签} → 剥离
 */
function cleanAssText(text: string): string {
  let result = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '{') {
      // 解析 {...} 标签
      const end = text.indexOf('}', i)
      if (end < 0) break
      const tagContent = text.slice(i + 1, end)
      // 处理复合标签如 {\b1\i1}
      const tags = tagContent.split('\\').filter(Boolean)
      for (const tag of tags) {
        const match = tag.match(/^([a-z]+)(\d+)$/i)
        if (match) {
          const [, name, val] = match
          const isOpen = val !== '0'
          const converter = ASS_TAG_MAP[name.toLowerCase()]
          if (converter) {
            result += converter(isOpen)
          }
        }
      }
      i = end + 1
    } else if (text[i] === '\\' && text[i + 1] === 'N') {
      // ASS 硬换行 \N
      result += '\n'
      i += 2
    } else if (text[i] === '\\' && text[i + 1] === 'n') {
      // ASS 软换行 \n
      result += '\n'
      i += 2
    } else if (text[i] === '\\' && text[i + 1] === 'h') {
      // ASS 硬空格 \h
      result += '\u00A0'
      i += 2
    } else {
      result += text[i]
      i++
    }
  }
  return result
}

function parseAss(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  let inEvents = false
  let formatFields: string[] = []
  let textFieldIndex = -1
  let startFieldIndex = -1
  let endFieldIndex = -1

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inEvents = trimmed.toLowerCase() === '[events]'
      formatFields = []
      continue
    }

    if (!inEvents) continue

    // 解析 Format 行
    if (trimmed.toLowerCase().startsWith('format:')) {
      formatFields = trimmed
        .slice(7)
        .split(',')
        .map((f) => f.trim().toLowerCase())
      textFieldIndex = formatFields.indexOf('text')
      startFieldIndex = formatFields.indexOf('start')
      endFieldIndex = formatFields.indexOf('end')
      continue
    }

    // 解析 Dialogue 行
    if (
      trimmed.toLowerCase().startsWith('dialogue:') &&
      formatFields.length > 0
    ) {
      const data = trimmed.slice(9)
      // ASS 字段以逗号分隔，但 text 字段可能包含逗号
      // 按 formatFields 数量切割，最后一个字段取剩余全部
      const parts: string[] = []
      let remaining = data
      for (let f = 0; f < formatFields.length - 1; f++) {
        const commaIdx = remaining.indexOf(',')
        if (commaIdx < 0) break
        parts.push(remaining.slice(0, commaIdx).trim())
        remaining = remaining.slice(commaIdx + 1)
      }
      parts.push(remaining.trim())

      if (startFieldIndex < 0 || endFieldIndex < 0 || textFieldIndex < 0)
        continue

      const start = parseAssTime(parts[startFieldIndex] ?? '0')
      const end = parseAssTime(parts[endFieldIndex] ?? '0')
      const rawText = parts[textFieldIndex] ?? ''
      const text = cleanAssText(rawText).trim()

      if (text && end > start) {
        cues.push({ start, end, text })
      }
    }
  }

  return cues
}

// ── SAMI (SMI) 解析 ───────────────────────────────────────

function parseSmi(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  // 提取所有 <SYNC Start=...>...</SYNC> 块
  const syncRegex = /<SYNC\s+Start=(\d+)[^>]*>([\s\S]*?)(?=<SYNC|<\/BODY|$)/gi
  const matches: { start: number; html: string }[] = []

  let match: RegExpExecArray | null
  while ((match = syncRegex.exec(content)) !== null) {
    matches.push({
      start: parseInt(match[1]) / 1000, // ms → s
      html: match[2] || '',
    })
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]
    const next = matches[i + 1]
    const end = next ? next.start : current.start + 4 // 无后续则默认 4 秒

    // 提取 <P> 标签内的文本，剥离 HTML
    let text = current.html
    // 移除 <br> 转 \n
    text = text.replace(/<br\s*\/?>/gi, '\n')
    // 移除所有 HTML 标签
    text = text.replace(/<[^>]+>/g, '')
    // 解码 HTML 实体
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    text = text.trim()

    if (text) {
      cues.push({ start: current.start, end, text })
    }
  }

  return cues
}

// ── MicroDVD (SUB) 解析 ───────────────────────────────────

function parseSub(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  // 尝试检测 FPS（MicroDVD 第一行可能是 {DEFAULT}{}帧率）
  let fps = 23.976
  const fpsMatch = content.match(/\{1\}\{1\}(\d+(?:\.\d+)?)/)
  if (fpsMatch) {
    const detected = parseFloat(fpsMatch[1])
    if (detected > 0 && detected < 120) fps = detected
  }

  for (const line of lines) {
    const m = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/)
    if (!m) continue
    const [, startFrame, endFrame, text] = m
    const start = parseInt(startFrame) / fps
    const end = parseInt(endFrame) / fps
    const cleaned = cleanSubText(text)
    if (cleaned && end > start) {
      cues.push({ start, end, text: cleaned })
    }
  }

  return cues
}

/** 清理 MicroDVD 文本中的控制字符 */
function cleanSubText(text: string): string {
  let result = text
  // MicroDVD 控制字符 {y:b}粗体 {y:i}斜体
  result = result.replace(/\{y:b\}/gi, '<b>')
  result = result.replace(/\{y:i\}/gi, '<i>')
  result = result.replace(/\{y:u\}/gi, '<u>')
  result = result.replace(/\{y:s\}/gi, '<s>')
  // 其他控制标签
  result = result.replace(/\{[^}]*\}/g, '')
  // 管道符换行
  result = result.replace(/\|/g, '\n')
  return result.trim()
}

// ── VTT 验证 ──────────────────────────────────────────────

/** 检查内容是否为有效的 VTT */
function isVtt(content: string): boolean {
  return content.trimStart().startsWith('WEBVTT')
}

// ── 统一转换入口 ───────────────────────────────────────────

/**
 * 将字幕条目列表转换为 WebVTT 字符串。
 */
function cuesToVtt(cues: SubtitleCue[]): string {
  const lines = ['WEBVTT', '']

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]
    lines.push(String(i + 1))
    lines.push(
      `${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}`
    )
    lines.push(cue.text)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 解析字幕内容并转换为 WebVTT。
 *
 * @param content 字幕文件原始文本
 * @param format 字幕格式
 * @returns WebVTT 格式字符串
 */
export function parseSubtitle(
  content: string,
  format: SubtitleFormat
): string {
  // VTT 直接返回（确保格式规范）
  if (format === 'vtt' || isVtt(content)) {
    return content.trimStart().startsWith('WEBVTT')
      ? content
      : `WEBVTT\n\n${content}`
  }

  let cues: SubtitleCue[]

  switch (format) {
    case 'srt':
      cues = parseSrt(content)
      break
    case 'ass':
      cues = parseAss(content)
      break
    case 'smi':
      cues = parseSmi(content)
      break
    case 'sub':
      cues = parseSub(content)
      break
    default:
      // 未知格式尝试按 SRT 解析（最常见的兜底）
      cues = parseSrt(content)
  }

  if (cues.length === 0) {
    // 解析失败，返回空 VTT
    return 'WEBVTT\n\n'
  }

  return cuesToVtt(cues)
}

/**
 * 将 VTT 字符串转换为 Blob URL。
 *
 * 用于给 <track src=...> 提供可加载的 URL，
 * 也可用于替换非 VTT 格式的原始 URL。
 */
export function vttToBlobUrl(vtt: string): string {
  const blob = new Blob([vtt], { type: 'text/vtt' })
  return URL.createObjectURL(blob)
}

/**
 * 从文件名生成字幕标签（去掉扩展名）。
 */
export function getSubtitleLabel(filename: string): string {
  return filename.replace(/\.(vtt|srt|ass|ssa|smi|sami|sub)$/i, '')
}
