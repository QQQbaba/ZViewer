/**
 * 结构分析 v2：找首 Cluster（越过 Attachments）、检查 Cues、采样块结构。
 */
import { openSync, readSync, statSync, closeSync } from 'node:fs'

const file = process.argv[2]
const st = statSync(file)
const fd = openSync(file, 'r')
const read = (pos: number, len: number): Buffer => {
  const b = Buffer.alloc(len)
  readSync(fd, b, 0, len, pos)
  return b
}
function readVint(buf: Buffer, off: number): { value: number; next: number; len: number } {
  const first = buf[off]!
  if (first === 0) throw new Error('vint 0')
  let len = 0
  for (let i = 7; i >= 0; i--) {
    if (first & (1 << i)) { len = 8 - i; break }
  }
  let value = first & (len === 8 ? 0xff : ((1 << (8 - len)) - 1))
  for (let i = 1; i < len; i++) value = value * 256 + buf[off + i]!
  return { value, next: off + len, len }
}
function readId(buf: Buffer, off: number): { value: number; next: number } {
  const first = buf[off]!
  let len = 1
  for (let i = 7; i >= 0; i--) {
    if (first & (1 << i)) { len = 8 - i; break }
  }
  let value = 0
  for (let i = 0; i < len; i++) value = value * 256 + buf[off + i]!
  return { value, next: off + len }
}
const UNKNOWN = 0xffffffffffffff

// Segment size 是否 unknown
const head = read(0, 128 * 1024)
let pos = readVint(head, 0).next
pos = readVint(head, pos).next + readVint(head, pos).value
const segId = readId(head, pos)
pos = segId.next
const segSizeRaw = readVint(head, pos)
const segUnknown = segSizeRaw.value >= UNKNOWN
console.log(`Segment size=${segUnknown ? 'UNKNOWN(流式)' : segSizeRaw.value} dataStart=${pos + segSizeRaw.len}`)

// 尾部元素枚举（从尾往前不好枚举，从 Segment 末段顺序解析不可行——
// 改为：在尾部 8MB 中找所有顶层元素 ID 模式）
const tailLen = Math.min(8 * 1024 * 1024, st.size)
const tail = read(st.size - tailLen, tailLen)
const CUES_ID = Buffer.from([0x1c, 0x53, 0xbb, 0x6b])
let found = -1
for (let i = 0; i < tail.length - 12; i++) {
  if (tail[i] === 0x1c && tail[i + 1] === 0x53 && tail[i + 2] === 0xbb && tail[i + 3] === 0x6b) {
    const sz = readVint(tail, i + 4)
    if (sz.value > 0 && sz.value < tail.length - i) { found = i; break }
  }
}
console.log(`Cues in last 8MB: ${found >= 0 ? `YES @abs ${st.size - tailLen + found}` : 'NO'}`)

// 顶层枚举到首 Cluster（越过 Attachments）
const bigHead = read(0, Math.min(16 * 1024 * 1024, st.size))
let p = pos + segSizeRaw.len
let clusterOff = -1
let guard = 0
while (p < bigHead.length - 8 && guard++ < 100) {
  const id = readId(bigHead, p)
  const sz = readVint(bigHead, id.next)
  const names: Record<number, string> = {
    0x114d9b74: 'SeekHead', 0xec: 'Void', 0x1549a966: 'Info', 0x1654ae6b: 'Tracks',
    0x1f43b675: 'Cluster', 0x1941a469: 'Attachments', 0x1c53bb6b: 'Cues',
    0x1043a770: 'Chapters', 0x1254c367: 'Tags',
  }
  console.log(`  ${names[id.value] ?? `0x${id.value.toString(16)}`} @${p} size=${sz.value >= UNKNOWN ? '?' : sz.value}`)
  if (id.value === 0x1f43b675) { clusterOff = p; break }
  if (sz.value >= UNKNOWN || sz.value < 0) break
  p = sz.next + sz.value
}
console.log(`首 Cluster @${clusterOff}`)

// 块结构采样（首 Cluster 全量，1.5MB）
if (clusterOff >= 0) {
  const win = read(clusterOff, 2 * 1024 * 1024)
  // Cluster ID 4 字节，size vint 从 offset 4 开始
  const sz = readVint(win, 4)
  let q = sz.next
  let blocks = 0, videoBlocks = 0, audioBlocks = 0
  let videoBytes = 0, audioBytes = 0
  const subPositions: number[] = [] // 字幕块在 Cluster 内的偏移
  const subSamples: string[] = []
  const blockOffsets: number[] = [] // 视频块起始偏移（看分布密度）
  while (q < win.length - 16) {
    const id = readId(win, q)
    if (id.value === 0xa3) {
      const bsz = readVint(win, id.next)
      const dataStart = bsz.next
      const track = readVint(win, dataStart)
      const flags = win[track.next + 2]
      const lacing = (flags & 0x06) >> 1
      const hdr = track.next + 3
      const payload = bsz.value - (hdr - dataStart)
      if (track.value === 1) { videoBlocks++; videoBytes += bsz.value; blockOffsets.push(q) }
      else if (track.value === 2 || track.value === 3) { audioBlocks++; audioBytes += bsz.value }
      else {
        subPositions.push(q - sz.next)
        if (subSamples.length < 3) subSamples.push(win.subarray(hdr, hdr + Math.min(100, payload)).toString('utf-8').replace(/\n/g, '\\n'))
      }
      blocks++
      q = bsz.next + bsz.value
    } else if (id.value === 0xa0) {
      const gsz = readVint(win, id.next)
      q = gsz.next + gsz.value
    } else {
      const esz = readVint(win, id.next)
      if (esz.value < 0 || esz.value > 1e9) break
      q = esz.next + esz.value
    }
  }
  console.log(`Cluster ${clusterOff} size=${sz.value}: 块=${blocks} video=${videoBlocks}(avg ${(videoBytes / Math.max(1, videoBlocks)).toFixed(0)}B) audio=${audioBlocks}(avg ${(audioBytes / Math.max(1, audioBlocks)).toFixed(0)}B) sub=${subPositions.length}`)
  console.log(`字幕块 Cluster 内偏移:`, subPositions, `Cluster 内容长 ${(sz.value / 1024).toFixed(0)}KB → 字幕块位置比例: ${subPositions.map((s) => ((s / sz.value) * 100).toFixed(0) + '%').join(', ')}`)
  console.log(`前 20 块起始偏移:`, blockOffsets.slice(0, 20).join(','))
  console.log(`字幕样本:`, subSamples)
}
closeSync(fd)
