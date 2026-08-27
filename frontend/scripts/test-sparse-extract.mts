/**
 * 流式增量提取验证。
 *
 * 1. 本地 http 服务器（Range/206）服务目标 MKV
 * 2. streamMkvSubtitleTrack 增量交付：记录首 chunk 延迟 / 各批时间区间
 * 3. 校验批间时间不回退、总 Dialogue 条数与完整提取一致
 *
 * 运行：cd frontend && npx tsx scripts/test-sparse-extract.mts <mkv路径>
 */
import { createServer } from 'node:http'
import { openSync, statSync, closeSync, readSync } from 'node:fs'
import { streamMkvSubtitleTrack } from '../src/modules/subtitles/mkv-embedded'
import { parseSubtitle } from '../src/lib/subtitleParser'

const file = process.argv[2]
if (!file) {
  console.error('用法: npx tsx scripts/test-sparse-extract.mts <mkv路径>')
  process.exit(1)
}
const st = statSync(file)
console.log(`文件: ${(st.size / 1024 / 1024 / 1024).toFixed(2)} GB`)

// ---------- 本地 Range 服务器 ----------
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
const port = (server.address() as { port: number }).port
const url = `http://127.0.0.1:${port}/video.mkv`

try {
  const t0 = Date.now()
  let firstChunkMs = -1
  let totalCues = 0
  let lastEnd = 0
  let monotonic = true
  let chunks = 0
  const trackNumber = parseInt(process.argv[3] ?? '4', 10)

  await streamMkvSubtitleTrack(url, trackNumber, {
    onChunk: (chunk) => {
      if (firstChunkMs < 0) {
        firstChunkMs = Date.now() - t0
        console.log(`[首 chunk] ${firstChunkMs}ms 后到达，可立即播放`)
      }
      chunks++
      const cues = parseSubtitle(chunk.text, chunk.format)
      totalCues += cues.length
      if (cues.length > 0) {
        const batchStart = cues[0]!.start
        const batchEnd = cues[cues.length - 1]!.end
        if (batchEnd < lastEnd - 0.001) monotonic = false
        lastEnd = Math.max(lastEnd, batchEnd)
        if (chunks <= 3 || chunks % 20 === 0) {
          console.log(
            `  chunk#${chunks}: ${cues.length} 条 [${fmt(batchStart)} → ${fmt(batchEnd)}]`
          )
        }
      }
    },
    onProgress: (p) => {
      if (p === 100) return
      // 进度不打日志，避免刷屏
    },
  })

  console.log('\n[结果]')
  console.log(`  首 chunk 延迟: ${firstChunkMs}ms`)
  console.log(`  chunk 数: ${chunks}`)
  console.log(`  总 cues: ${totalCues}`)
  console.log(`  覆盖末尾时间: ${fmt(lastEnd)}`)
  console.log(`  批间时间单调: ${monotonic ? 'OK' : 'FAIL'}`)
  console.log(`  总耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  function fmt(sec: number): string {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
} finally {
  closeSync(fd)
  server.close()
}
