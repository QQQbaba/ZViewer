/**
 * 视频块 VCL 扫描：按 AVCC 长度前缀逐 NALU 解析（修正此前按起始码扫描
 * 的错误），统计含 slice（type 1/5）的块数，判断真实内容帧率。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MatroskaDemuxer, type DemuxedFrame, type DemuxedTrack } from '../src/modules/player/wasm-engine/demuxer/matroska-demuxer'
import { annexBToAvcc } from '../src/modules/player/wasm-engine/player'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mkvPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../public/test/wasmtest.mkv')

const bytes = new Uint8Array(readFileSync(mkvPath))
let tracks: DemuxedTrack[] = []
const video: DemuxedFrame[] = []
const demuxer = new MatroskaDemuxer({
  onTracks: (t) => {
    tracks = t
  },
  onFrame: (f) => {
    const track = tracks.find((t) => t.trackNumber === f.trackNumber)
    if (track?.trackType === 1) video.push(f)
  },
})
for (let off = 0; off < bytes.length; off += 256 * 1024) {
  demuxer.append(bytes.subarray(off, Math.min(off + 256 * 1024, bytes.length)))
}

// 逐块统计 NALU 类型（先经 annexBToAvcc 归一为长度前缀格式）
let withVcl = 0
let vclTotal = 0
let seiOnly = 0
let noNal = 0
const typeHisto = new Map<number, number>()
const badExamples: string[] = []
for (let i = 0; i < video.length; i++) {
  const f = video[i]!
  const avcc = annexBToAvcc(f.data)
  let hasVcl = false
  let nals = 0
  let p = 0
  while (p + 4 <= avcc.length) {
    const len = ((avcc[p]! << 24) | (avcc[p + 1]! << 16) | (avcc[p + 2]! << 8) | avcc[p + 3]!) >>> 0
    if (len < 1 || p + 4 + len > avcc.length) break
    const t = avcc[p + 4]! & 0x1f
    typeHisto.set(t, (typeHisto.get(t) ?? 0) + 1)
    if (t === 1 || t === 5) {
      hasVcl = true
      vclTotal++
    }
    nals++
    p += 4 + len
  }
  if (hasVcl) withVcl++
  else if (nals > 0) {
    seiOnly++
    if (badExamples.length < 6) {
      badExamples.push(
        `#${i}@${f.timestampMs}ms ${f.data.byteLength}B nalTypes=[${[...typeHisto.keys()].join(',')}]`
      )
    }
  } else noNal++
}

console.log(`视频块总数: ${video.length}`)
console.log(
  `含 VCL(slice) 的块: ${withVcl}（VCL NALU 共 ${vclTotal} 个）`
)
console.log(`仅 SEI 等非 VCL 的块: ${seiOnly}，完全无 NALU: ${noNal}`)
console.log(
  'NALU 类型分布:',
  [...typeHisto.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `type${t}=${n}`)
    .join(' ')
)
if (badExamples.length > 0) console.log('非 VCL 块示例:', badExamples.join(' | '))
const spanSec = (video[video.length - 1]!.timestampMs - video[0]!.timestampMs) / 1000
console.log(
  `时间轴跨度 ${spanSec.toFixed(2)}s：含VCL帧率 = ${(withVcl / spanSec).toFixed(2)}fps，块密度 = ${(video.length / spanSec).toFixed(2)}块/s`
)
