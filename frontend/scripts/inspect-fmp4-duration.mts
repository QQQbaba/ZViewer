/**
 * 解析分片 MP4（fMP4）的真实时长：遍历 moof，按轨累加
 * tfdt.baseMediaDecodeTime + trun sample durations，输出各轨时间轴末端。
 *
 * 用途：诊断 wasm 引擎 muxer 产物时长与 MKV 容器时长的偏差。
 *
 * 运行：npx tsx scripts/inspect-fmp4-duration.mts [path/to/out.mp4]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mp4Path = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../public/test/wasmtest-out.mp4')

const buf = readFileSync(mp4Path)
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

function type(off: number): string {
  return String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!)
}
function boxSize(off: number): number {
  return view.getUint32(off)
}

// 遍历顶层 box，收集 moof 偏移与 mfhd 序号
const moofs: number[] = []
{
  let off = 0
  while (off + 8 <= buf.length) {
    const size = boxSize(off)
    if (size < 8) break
    const t = type(off)
    if (t === 'moof') moofs.push(off)
    off += size
  }
}

interface TrackEnd {
  trackId: number
  lastEndUs: number
  firstDtsUs: number | null
  sampleCount: number
  durations: number[] // 前若干 fragment 末 sample duration 异常记录
}
const tracks = new Map<number, TrackEnd>()

for (const moofOff of moofs) {
  // 遍历 moof 内的 traf
  const moofEnd = moofOff + boxSize(moofOff)
  let off = moofOff + 8
  while (off < moofEnd) {
    const size = boxSize(off)
    const t = type(off)
    if (t === 'traf') {
      const trafEnd = off + size
      let trafOff = off + 8
      let trackId = -1
      let baseMediaDecodeTime: number | null = null
      let defaultDurationUs = 0
      // 先扫 tfhd/tfdt
      while (trafOff + 8 <= trafEnd) {
        const ssize = boxSize(trafOff)
        const st = type(trafOff)
        if (st === 'tfhd') {
          const flags = view.getUint32(trafOff + 8) & 0xffffff
          let p = trafOff + 12
          trackId = view.getUint32(p)
          p += 4
          if (flags & 0x01) p += 8 // base-data-offset
          if (flags & 0x02) p += 4 // sample-description-index
          if (flags & 0x08) {
            defaultDurationUs = view.getUint32(p)
            p += 4
          }
          if (flags & 0x10) p += 4
          if (flags & 0x20) p += 4
        } else if (st === 'tfdt') {
          const version = buf[trafOff + 8]!
          if (version === 1) {
            baseMediaDecodeTime = Number(view.getBigUint64(trafOff + 12))
          } else {
            baseMediaDecodeTime = view.getUint32(trafOff + 12)
          }
        }
        trafOff += ssize
      }
      // 再扫 trun 求累计 duration
      let cumDurUs = 0
      let sampleCount = 0
      trafOff = off + 8
      while (trafOff + 8 <= trafEnd) {
        const ssize = boxSize(trafOff)
        const st = type(trafOff)
        if (st === 'trun') {
          const flags = view.getUint32(trafOff + 8) & 0xffffff
          let p = trafOff + 12
          const count = view.getUint32(p)
          p += 4
          if (flags & 0x01) p += 4 // data-offset
          if (flags & 0x04) p += 4 // first-sample-flags
          const hasDur = !!(flags & 0x100)
          const hasSize = !!(flags & 0x200)
          const hasFlags = !!(flags & 0x400)
          const hasCts = !!(flags & 0x800)
          const fieldLen = (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCts ? 4 : 0)
          for (let i = 0; i < count; i++) {
            if (hasDur) {
              cumDurUs += view.getUint32(p)
              p += 4
            } else {
              cumDurUs += defaultDurationUs
            }
            p += fieldLen - (hasDur ? 4 : 0)
            sampleCount++
          }
        }
        trafOff += ssize
      }
      if (baseMediaDecodeTime !== null && trackId >= 0) {
        const endUs = baseMediaDecodeTime + cumDurUs
        if (process.env.DEBUG_MOOF) {
          console.log(
            `moof@${moofOff}: trackId=${trackId} tfdt=${(baseMediaDecodeTime / 1e6).toFixed(3)}s ` +
              `cumDur=${(cumDurUs / 1e6).toFixed(3)}s samples=${sampleCount} end=${(endUs / 1e6).toFixed(3)}s`
          )
        }
        const tr = tracks.get(trackId) ?? {
          trackId,
          lastEndUs: 0,
          firstDtsUs: baseMediaDecodeTime,
          sampleCount: 0,
          durations: [],
        }
        tr.lastEndUs = Math.max(tr.lastEndUs, endUs)
        tr.sampleCount += sampleCount
        tracks.set(trackId, tr)
      } else {
        console.log(
          `moof@${moofOff}: traf 解析失败 trackId=${trackId} tfdt=${baseMediaDecodeTime}`
        )
      }
    }
    off += size
  }
}

console.log(`文件: ${mp4Path}`)
console.log(`moof 数: ${moofs.length}`)
for (const [id, tr] of [...tracks.entries()].sort((a, b) => a[0] - b[0])) {
  const role = id === 1 ? '视频' : id === 2 ? '音频' : `轨#${id}`
  console.log(
    `${role}(trackId=${id}): 起始DTS=${(tr.firstDtsUs! / 1e6).toFixed(3)}s ` +
      `末端DTS+dur=${(tr.lastEndUs / 1e6).toFixed(3)}s 样本数=${tr.sampleCount}`
  )
}
