/**
 * 临时排查：用真实片源镜像 probeMkvSubtitleTracks 逻辑。
 */
import { openSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { MatroskaDemuxer, type DemuxedTrack } from '../src/modules/player/wasm-engine/demuxer/matroska-demuxer'

const file = process.argv[2]
if (!file) {
  console.error('usage: npx tsx scripts/test-probe-real.ts <mkv>')
  process.exit(1)
}
const st = statSync(path.resolve(file))
console.log(`文件: ${file} (${(st.size / 1024 / 1024 / 1024).toFixed(2)} GB)`)

const HEAD = 4 * 1024 * 1024
const head = Buffer.alloc(Math.min(HEAD, st.size))
const fd = openSync(path.resolve(file), 'r')
let got = 0
while (got < head.length) {
  const n = readSync(fd, head, got, head.length - got, got)
  if (n <= 0) break
  got += n
}
console.log(`读取头部 ${got} 字节`)
let tracks: DemuxedTrack[] | null = null
let sawTracks = false
const demuxer = new MatroskaDemuxer({
  onTracks: (t) => {
    sawTracks = true
    tracks = t
    console.log(`onTracks: ${t.length} 轨`)
    for (const tr of t) {
      console.log(
        `  #${tr.trackNumber} type=${tr.trackType} codec=${tr.codecId} lang=${tr.language ?? '-'} name=${tr.name ?? '-'} comp=${tr.contentCompAlgo ?? 0}`
      )
    }
  },
})
// 模拟网络分块
for (let off = 0; off < head.length; off += 256 * 1024) {
  demuxer.append(head.subarray(off, Math.min(off + 256 * 1024, head.length)))
}
console.log(`4MB 头内解析到 Tracks: ${sawTracks}`)
if (!tracks) {
  console.log('=> 未解析到 Tracks：检查头部是否含 Attachments/超大元素')
  // 粗扫 EBML 顶层元素，找 Tracks 实际偏移
  const { readVint } = await import('../src/modules/player/wasm-engine/demuxer/ebml')
  let pos = 0
  let segPos = -1
  // 跳过 EBML header
  const id0 = readVint(head, 0)
  pos = id0.next
  const size0 = readVint(head, pos)
  pos = size0.next + size0.value
  console.log(`EBML header 结束于 ${pos}`)
  const IDS: Record<number, string> = {
    0x18538067: 'Segment',
    0x114d9b74: 'SeekHead',
    0x1549a966: 'Info',
    0x1654ae6b: 'Tracks',
    0x1a45dfa3: 'EBML',
    0x1f43b675: 'Cluster',
    0x1941a469: 'Attachments',
    0x1c53bb6b: 'Cues',
    0x1043a770: 'Chapters',
  }
  const segSize = readVint(head, pos + 1)
  console.log(`Segment size=${segSize.value}`)
  pos = segSize.next
  let guard = 0
  while (pos < head.length && guard++ < 50) {
    const id = readVint(head, pos)
    const size = readVint(head, id.next)
    const name = IDS[id.value] ?? `0x${id.value.toString(16)}`
    console.log(`  ${name} @${pos} size=${size.value}`)
    if (name === 'Tracks') {
      console.log(`=> Tracks 位于偏移 ${pos}（4MB 头内）`)
      break
    }
    if (name === 'Cluster' || size.value > head.length - pos) {
      console.log(`=> Tracks 未出现在 Cluster 前：头部结构异常`)
      break
    }
    pos = size.next + size.value
  }
}
