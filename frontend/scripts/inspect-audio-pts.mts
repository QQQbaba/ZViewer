/**
 * 音频帧 pts 体检：统计 lacing 重复 pts、pts 间距分布、PCM 时长推算，
 * 验证 AAC 输出帧数是否超出容器时间轴（时长膨胀根因）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MatroskaDemuxer, type DemuxedFrame, type DemuxedTrack } from '../src/modules/player/wasm-engine/demuxer/matroska-demuxer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mkvPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../public/test/wasmtest.mkv')

const bytes = new Uint8Array(readFileSync(mkvPath))
let tracks: DemuxedTrack[] = []
const audio: DemuxedFrame[] = []
const demuxer = new MatroskaDemuxer({
  onTracks: (t) => {
    tracks = t
  },
  onFrame: (f) => {
    const track = tracks.find((t) => t.trackNumber === f.trackNumber)
    if (track?.trackType === 2) audio.push(f)
  },
})
for (let off = 0; off < bytes.length; off += 256 * 1024) {
  demuxer.append(bytes.subarray(off, Math.min(off + 256 * 1024, bytes.length)))
}

console.log(`音频帧总数: ${audio.length}`)
// 重复 pts（lacing 拆分帧共享块 pts）
let dupPts = 0
const ptsCounts = new Map<number, number>()
for (const f of audio) ptsCounts.set(f.timestampMs, (ptsCounts.get(f.timestampMs) ?? 0) + 1)
for (const [, c] of ptsCounts) if (c > 1) dupPts += c - 1
console.log(`唯一 pts 数: ${ptsCounts.size}，重复帧（lacing 拆分）: ${dupPts}`)

// pts 间距分布
const uniqPts = [...ptsCounts.keys()].sort((a, b) => a - b)
const deltas = new Map<number, number>()
for (let i = 1; i < uniqPts.length; i++) {
  const d = uniqPts[i]! - uniqPts[i - 1]!
  deltas.set(d, (deltas.get(d) ?? 0) + 1)
}
console.log(
  '唯一 pts 间距分布:',
  [...deltas.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, n]) => `${d}ms×${n}`)
    .join(' ')
)
// 每帧平均字节
const totalBytes = audio.reduce((n, f) => n + f.data.byteLength, 0)
console.log(
  `音频总字节: ${(totalBytes / 1024 / 1024).toFixed(2)}MB，均 ${(totalBytes / audio.length).toFixed(0)}B/帧`
)
// 按每帧 4096 样本@48k（85.33ms）推算 PCM 时长
const pcmSec = (audio.length * 4096) / 48000
console.log(
  `PCM 推算（4096 样本/帧）: ${pcmSec.toFixed(2)}s vs 容器时间轴 ${(uniqPts[uniqPts.length - 1]! / 1000).toFixed(2)}s`
)
// 分段帧率：每 10s 窗口帧数
console.log('分段帧数（每10s）:')
for (let w = 0; w < uniqPts[uniqPts.length - 1]! / 1000; w += 10) {
  const n = audio.filter((f) => f.timestampMs >= w * 1000 && f.timestampMs < (w + 10) * 1000).length
  console.log(`  ${w}-${w + 10}s: ${n} 帧（${(n / 10).toFixed(1)} 帧/s，PCM ${(n * 85.333).toFixed(0)}ms/10s）`)
}
