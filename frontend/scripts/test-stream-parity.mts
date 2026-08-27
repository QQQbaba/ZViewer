/**
 * 流式 vs 完整提取一致性对比。
 * 两者都经 parseSubtitle 解析后对比 cue 数 / 首末时间戳。
 * 运行：npx tsx scripts/test-stream-parity.mts <mkv路径> [trackNumber]
 */
import { createServer } from 'node:http'
import { openSync, statSync, closeSync, readSync } from 'node:fs'
import {
  extractMkvSubtitleTrack,
  streamMkvSubtitleTrack,
} from '../src/modules/subtitles/mkv-embedded'
import { parseSubtitle } from '../src/lib/subtitleParser'

const file = process.argv[2]!
const trackNumber = parseInt(process.argv[3] ?? '4', 10)
const st = statSync(file)

const fd = openSync(file, 'r')
const server = createServer((req, res) => {
  const range = req.headers.range
  let start = 0
  let end = st.size - 1
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      if (m[1]) start = parseInt(m[1]!, 10)
      if (m[2]) end = parseInt(m[2]!, 10)
    }
  }
  const len = end - start + 1
  res.writeHead(206, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': len,
    'Content-Range': `bytes ${start}-${end}/${st.size}`,
    'Accept-Ranges': 'bytes',
  })
  const chunk = 4 * 1024 * 1024
  let pos = start
  const pump = () => {
    if (pos > end) { res.end(); return }
    const n = Math.min(chunk, end - pos + 1)
    const b = Buffer.alloc(n)
    readSync(fd, b, 0, n, pos)
    res.write(b)
    pos += n
    if (pos <= end) setImmediate(pump)
    else res.end()
  }
  pump()
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/video.mkv`

function summarize(cues: { start: number; end: number; text: string }[]) {
  return {
    count: cues.length,
    first: cues[0] ? `${cues[0]!.start.toFixed(2)} → ${cues[0]!.end.toFixed(2)}: ${cues[0]!.text.slice(0, 30)}` : '-',
    last: cues.at(-1) ? `${cues.at(-1)!.start.toFixed(2)} → ${cues.at(-1)!.end.toFixed(2)}: ${cues.at(-1)!.text.slice(0, 30)}` : '-',
    textLen: cues.reduce((s, c) => s + c.text.length, 0),
  }
}

try {
  // 流式
  const streamCues: { start: number; end: number; text: string }[] = []
  await streamMkvSubtitleTrack(url, trackNumber, {
    onChunk: (c) => streamCues.push(...parseSubtitle(c.text, c.format)),
  })
  console.log('[流式]', JSON.stringify(summarize(streamCues), null, 2))

  // 完整
  const full = await extractMkvSubtitleTrack(url, trackNumber)
  const fullCues = parseSubtitle(full.content, full.format)
  console.log('[完整]', JSON.stringify(summarize(fullCues), null, 2))
  // 诊断：分段解析定位问题
  const evIdx = full.content.indexOf('[Events]')
  console.log('--- [Events] 存在:', evIdx >= 0, '| content 长度:', full.content.length)
  // Events 段前 300 行逐行分类
  const segLines = full.content.slice(evIdx, evIdx + 200000).split('\n').slice(0, 300)
  const kinds: Record<string, number> = {}
  const oddLines: string[] = []
  for (const l of segLines) {
    const t = l.trim().toLowerCase()
    let kind = 'other'
    if (t.startsWith('dialogue:')) kind = 'dialogue'
    else if (t.startsWith('comment:')) kind = 'comment'
    else if (t.startsWith('format:')) kind = 'format'
    else if (t.startsWith('[')) kind = 'section'
    else if (t === '') kind = 'empty'
    else if (t.startsWith(';')) kind = 'comment-line'
    kinds[kind] = (kinds[kind] ?? 0) + 1
    if (kind === 'other' || kind === 'section') oddLines.push(JSON.stringify(l.slice(0, 80)))
  }
  console.log('  行类型统计:', JSON.stringify(kinds))
  console.log('  other/section 行样本:', oddLines.slice(0, 8))
  // 首个 Dialogue 的 start/end
  const d1 = segLines.find((l) => l.trim().toLowerCase().startsWith('dialogue:'))
  console.log('  首 Dialogue:', JSON.stringify(d1?.slice(0, 100)))

  // 逐条对比（时间戳与文本）
  let mismatch = 0
  if (streamCues.length === fullCues.length) {
    for (let i = 0; i < fullCues.length; i++) {
      const a = streamCues[i]!
      const b = fullCues[i]!
      if (
        Math.abs(a.start - b.start) > 0.011 ||
        Math.abs(a.end - b.end) > 0.011 ||
        a.text !== b.text
      ) {
        mismatch++
        if (mismatch <= 3) {
          console.log(`  diff@${i}: stream(${a.start}-${a.end}"${a.text.slice(0, 20)}") vs full(${b.start}-${b.end}"${b.text.slice(0, 20)}")`)
        }
      }
    }
  }
  console.log(
    `\n一致性: 数量${streamCues.length === fullCues.length ? '相同' : `不同(${streamCues.length} vs ${fullCues.length})`}，内容 mismatch=${mismatch}`
  )
} finally {
  closeSync(fd)
  server.close()
}
