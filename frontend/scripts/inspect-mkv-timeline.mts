/**
 * MKV 时间轴体检：全量解复用，输出容器 Info 时长、末帧块时间戳、
 * 各轨块数，并解析 SPS VUI 帧率（num_units_in_tick / time_scale），
 * 用于判断块时间戳与真实内容时长的比例关系。
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
let infoDuration: number | null = null
let infoScale = 1_000_000
const video: DemuxedFrame[] = []
const audio: DemuxedFrame[] = []
let tracks: DemuxedTrack[] = []

const demuxer = new MatroskaDemuxer({
  onTracks: (t) => {
    tracks = t
  },
  onInfo: (info) => {
    infoDuration = info.durationSec
    infoScale = info.timestampScaleNs
  },
  onFrame: (f) => {
    const track = tracks.find((t) => t.trackNumber === f.trackNumber)
    if (track?.trackType === 1) video.push(f)
    else if (track?.trackType === 2) audio.push(f)
  },
})
for (let off = 0; off < bytes.length; off += 256 * 1024) {
  demuxer.append(bytes.subarray(off, Math.min(off + 256 * 1024, bytes.length)))
}

console.log(`文件: ${mkvPath}`)
console.log(
  `Info: timestampScale=${infoScale}ns duration=${infoDuration?.toFixed(3) ?? 'null'}s`
)
console.log(
  `视频块: ${video.length} 个，首 pts=${video[0]?.timestampMs}ms 末 pts=${video[video.length - 1]?.timestampMs}ms`
)
console.log(
  `音频帧: ${audio.length} 个，首 pts=${audio[0]?.timestampMs}ms 末 pts=${audio[audio.length - 1]?.timestampMs}ms`
)
if (video.length > 1) {
  const span = (video[video.length - 1]!.timestampMs - video[0]!.timestampMs) / 1000
  console.log(
    `视频块时间轴跨度: ${span.toFixed(3)}s → 块速率 = ${(video.length / span).toFixed(2)} 块/s`
  )
}

// ---------- SPS VUI 帧率解析 ----------
// avcC: [version][profile][compat][level][0xff len-1][nSPS][len16 SPS]...
const avcC = tracks.find((t) => t.trackType === 1)?.codecPrivate
if (!avcC) throw new Error('无视频 codecPrivate')
let q = 6
const nSPS = avcC[q]!
q++
let sps: Uint8Array | null = null
for (let i = 0; i < nSPS; i++) {
  const len = (avcC[q]! << 8) | avcC[q + 1]!
  if (i === 0) sps = avcC.subarray(q + 2, q + 2 + len)
  q += 2 + len
}

class BitReader {
  private bit = 0
  constructor(private d: Uint8Array, private byte = 0) {}
  u(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      const b = this.d[this.byte]!
      v = (v << 1) | ((b >> (7 - this.bit)) & 1)
      this.bit++
      if (this.bit === 8) {
        this.bit = 0
        this.byte++
      }
    }
    return v
  }
  ue(): number {
    let zeros = 0
    while (this.u(1) === 0) zeros++
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.u(zeros)
  }
  se(): number {
    const c = this.ue()
    return c % 2 === 0 ? -(c / 2) : (c + 1) / 2
  }
}

function parseSpsTiming(sps: Uint8Array): string {
  // 去 emulation prevention
  const out: number[] = []
  for (let i = 0; i < sps.length; i++) {
    if (i >= 2 && sps[i - 2] === 0 && sps[i - 1] === 0 && sps[i] === 3) continue
    out.push(sps[i]!)
  }
  const r = new BitReader(new Uint8Array(out))
  r.u(8) // NALU header
  r.u(8) // profile_idc... 实际按 exp-golomb 读
  // 重新来：profile_idc u(8) 已含在上一行？SPS 载荷从 NALU 头后开始：
  const r2 = new BitReader(new Uint8Array(out))
  r2.u(8) // forbidden+type (NALU header)
  const profile = r2.u(8)
  r2.u(8) // constraint flags + reserved
  r2.u(8) // level_idc
  r2.ue() // seq_parameter_set_id
  const chroma = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]
  if (chroma.includes(profile)) {
    r2.ue() // chroma_format_idc
    if (r2.ue() === 3) r2.u(1)
    r2.ue() // bit_depth_luma
    r2.ue() // bit_depth_chroma
    r2.u(1) // qpprime
    if (r2.u(1)) {
      // seq_scaling_matrix
      const cnt = profile === 100 || profile === 110 || profile === 122 || profile === 244 ? 8 : 12
      for (let i = 0; i < cnt; i++) {
        if (r2.u(1)) {
          const sl = i < 6 ? 16 : 64
          let next = 8
          let skip = 8
          for (let j = 0; j < sl; j++) {
            if (next !== 0 && skip !== 0) {
              const d = r2.se()
              if (d === 0) break
              skip--
            }
          }
        }
      }
    }
  }
  r2.ue() // log2_max_frame_num
  const pocType = r2.ue()
  if (pocType === 0) r2.ue()
  else if (pocType === 1) {
    r2.u(1)
    r2.se()
    r2.se()
    for (let i = 0; i < 8; i++) {
      if (r2.u(1)) r2.se()
    }
  }
  r2.ue() // log2_max_poc
  r2.u(1) // delta_pic_order_always_zero
  r2.se() // offset_for_non_ref
  r2.se() // offset_for_top_to_bottom
  const nRef = r2.ue()
  for (let i = 0; i < nRef; i++) r2.se()
  r2.ue() // num_ref_frames
  r2.u(1) // gaps_in_frame_num
  r2.ue() // pic_width_in_mbs
  r2.ue() // pic_height_in_map_units
  r2.u(1) // frame_mbs_only
  if (!0) { /* frame_mbs_only handled below */ }
  return `profile=${profile}（VUI 解析见下）`
}

// 简化：只关心 VUI 的 timing_info。重新实现一个精确的跳读。
function parseVui(sps: Uint8Array): { fps: number | null; width: number; height: number } | null {
  const out: number[] = []
  for (let i = 0; i < sps.length; i++) {
    if (i >= 2 && sps[i - 2] === 0 && sps[i - 1] === 0 && sps[i] === 3) continue
    out.push(sps[i]!)
  }
  const r = new BitReader(new Uint8Array(out))
  r.u(8) // NALU header
  const profile = r.u(8)
  r.u(8)
  r.u(8) // level
  r.ue()
  const highProfiles = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]
  if (highProfiles.includes(profile)) {
    const chroma = r.ue()
    if (chroma === 3) r.u(1)
    r.ue()
    r.ue()
    r.u(1)
    if (r.u(1)) {
      const cnt = chroma === 3 ? 12 : 8
      for (let i = 0; i < cnt; i++) {
        if (r.u(1)) {
          const sl = i < 6 ? 16 : 64
          let skip = 8
          for (let j = 0; j < sl; j++) {
            if (skip > 0) {
              if (r.se() !== 0) skip--
              else break
            }
          }
        }
      }
    }
  }
  r.ue() // log2_max_frame_num_minus4
  const pocType = r.ue()
  if (pocType === 0) r.ue()
  else if (pocType === 1) {
    r.u(1)
    r.se()
    r.se()
    const n = r.ue()
    for (let i = 0; i < n; i++) r.se()
  }
  r.ue() // log2_max_poc
  r.u(1)
  r.se()
  r.se()
  const nRefsInPicOrder = r.ue()
  for (let i = 0; i < nRefsInPicOrder; i++) r.se()
  r.ue() // max_num_ref_frames
  r.u(1) // gaps
  const picW = r.ue()
  const picH = r.ue()
  const frameMbsOnly = r.u(1)
  if (!frameMbsOnly) r.u(1) // mb_adaptive
  r.u(1) // direct_8x8
  r.u(1) // frame_cropping
  // cropping 跳过
  if (r.u(1)) {
    r.ue(); r.ue(); r.ue(); r.ue()
  }
  const vuiPresent = r.u(1)
  if (!vuiPresent) return null
  const aspectInfo = r.u(1)
  if (aspectInfo) {
    const aspectIdc = r.u(8)
    if (aspectIdc === 255) { r.u(16); r.u(16) }
  }
  if (r.u(1)) r.u(8) // overscan
  if (r.u(1)) {
    if (r.u(1)) r.ue()
  }
  if (r.u(1)) {
    r.ue(); r.ue()
    r.u(1); r.u(1)
  }
  if (r.u(1)) {
    const n = r.ue()
    for (let i = 0; i < n; i++) r.u(8)
  }
  const timingInfoPresent = r.u(1)
  if (!timingInfoPresent) return null
  const numUnitsInTick = r.u(32)
  const timeScale = r.u(32)
  const fixed = r.u(1)
  const fps = timeScale / (2 * numUnitsInTick)
  return {
    fps,
    width: (picW + 1) * 16,
    height: (picH + 1) * 16 * (2 - frameMbsOnly),
  }
}

if (sps) {
  const vui = parseVui(sps)
  if (vui) {
    console.log(
      `SPS VUI: ${vui.width}x${vui.height}，num_units_in_tick/time_scale → fps = ${vui.fps.toFixed(3)}`
    )
  } else {
    console.log('SPS VUI: 不存在或无 timing_info（帧率未声明）')
  }
}
