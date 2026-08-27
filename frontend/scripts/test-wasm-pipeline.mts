/**
 * wasm-engine 转码管线离线端到端验证（无需浏览器）。
 *
 * 复用真实模块，逐环节镜像 player.ts / transcode-worker.ts 的行为：
 *   1. MatroskaDemuxer 分块喂入（真实解复用器）
 *   2. 音频按 ≈6s 批拼接 → ffmpeg.wasm exec（与 worker 完全相同的命令）
 *   3. ADTS 解析剥头（镜像 onAdtsDecoded，含 ASC 构造与全局单调时钟）
 *   4. annexBToAvcc（真实导出函数）+ mp4-muxer（与 ensureMuxerAttached 相同配置）
 *   5. 产物 out.mp4 再用 ffmpeg.wasm 全量解码，校验视频/音频两轨均可解
 *
 * 运行：cd frontend && npx tsx scripts/test-wasm-pipeline.mts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MatroskaDemuxer, type DemuxedFrame, type DemuxedTrack } from '../src/modules/player/wasm-engine/demuxer/matroska-demuxer'
import { annexBToAvcc } from '../src/modules/player/wasm-engine/player'
import { Muxer, StreamTarget } from 'mp4-muxer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 支持命令行传入真实片源：npx tsx scripts/test-wasm-pipeline.mts C:\path\to\file.mkv
const mkvPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../public/test/wasmtest.mkv')
const coreJs = path.resolve(__dirname, '../public/ffmpeg/ffmpeg-core.js')
const coreWasm = path.resolve(__dirname, '../public/ffmpeg/ffmpeg-core.wasm')
const outDir = path.resolve(__dirname, '../public/test')

const BATCH_DURATION_MS = 6000
const BATCH_MAX_BYTES = 8 * 1024 * 1024
// 可选第 3 参数：只处理前 N 秒（大文件快速复现用）
const LIMIT_SEC = process.argv[3] ? parseFloat(process.argv[3]) : Infinity
const LIMIT_MS = LIMIT_SEC * 1000

// ---------- 1. 解复用 ----------
interface CollectResult {
  tracks: DemuxedTrack[]
  videoFrames: DemuxedFrame[]
  audioFrames: DemuxedFrame[]
}

function demuxAll(bytes: Uint8Array): CollectResult {
  const res: CollectResult = { tracks: [], videoFrames: [], audioFrames: [] }
  const clusterHeads: [number, number][] = []
  const demuxer = new MatroskaDemuxer({
    onTracks: (t) => {
      res.tracks = t
    },
    onInfo: (info) => {
      console.log(
        `MKV Info: timestampScale=${info.timestampScaleNs}ns duration=${info.durationSec}s`
      )
    },
    onClusterIndexed: (tsMs, off) => {
      if (res.videoFrames.length < 400) {
        clusterHeads.push([tsMs, off])
      }
    },
    onFrame: (f) => {
      // 轨道号在 Tracks 元素完成后才可知；onTracks 先于首 Cluster 触发
      const track = res.tracks.find((t) => t.trackNumber === f.trackNumber)
      if (track?.trackType === 1) res.videoFrames.push(f)
      else if (track?.trackType === 2) res.audioFrames.push(f)
    },
  })
  // 256KB 分块喂入，模拟流式到达
  for (let off = 0; off < bytes.length; off += 256 * 1024) {
    demuxer.append(bytes.subarray(off, Math.min(off + 256 * 1024, bytes.length)))
  }
  console.log(
    'Cluster 时间码(前12):',
    clusterHeads.slice(0, 12).map(([ts]) => `${ts}ms`).join(' ')
  )
  return res
}

// ---------- 2. ffmpeg.wasm core 加载（与 gen-test-mkv 相同方式） ----------
globalThis.self = globalThis
if (!globalThis.location) {
  globalThis.location = { href: 'http://localhost/' }
}
const coreText = readFileSync(coreJs, 'utf8')
const tmpEsm = path.resolve(__dirname, '.ffmpeg-core-esm.mjs')
writeFileSync(tmpEsm, coreText + '\nexport default createFFmpegCore;\n')
const mod = await import('file:///' + tmpEsm.replace(/\\/g, '/'))
const factory = mod.default ?? mod.createFFmpegCore
if (typeof factory !== 'function') throw new Error('factory not found')
const logs: string[] = []
const inst = await factory({
  wasmBinary: readFileSync(coreWasm),
  printErr: (s: string) => {
    logs.push(String(s))
  },
})
inst.setLogger?.((d: { type: string; message: string }) => {
  if (d.type === 'stderr') logs.push(d.message)
})

function ffExec(args: string[]): number {
  logs.length = 0
  const code = inst.exec(...args)
  if (code !== 0) {
    console.error('[ffmpeg stderr]', logs.join('\n'))
  }
  return code
}

// ---------- 3. 执行 ----------
const mkv = readFileSync(mkvPath)
console.log(`MKV: ${(mkv.length / 1024 / 1024).toFixed(2)}MB`)

const { tracks, videoFrames: allVideoFrames, audioFrames } = demuxAll(new Uint8Array(mkv))
// 时长限制：只保留前 LIMIT_MS 的帧（大文件快速复现）
const videoFrames = allVideoFrames.filter((f) => f.timestampMs <= LIMIT_MS)
console.log(
  'tracks:',
  tracks.map(
    (t) =>
      `#${t.trackNumber} type=${t.trackType} ${t.codecId} ch=${t.channels} rate=${t.samplingRate} priv=${t.codecPrivate?.length ?? 0}B`
  )
)
if (videoFrames.length === 0 || audioFrames.length === 0) {
  throw new Error(`解复用结果异常：video=${videoFrames.length} audio=${audioFrames.length}`)
}

const videoTrack = tracks.find((t) => t.trackType === 1)!
const audioTrack = tracks.find((t) => t.trackType === 2)!

// 时间戳单调性检查（解复用层）
let lastVideoTs = -1
let videoTsBack = 0
for (const f of videoFrames) {
  if (f.timestampMs <= lastVideoTs) videoTsBack++
  lastVideoTs = f.timestampMs
}
console.log(
  `video=${videoFrames.length} 帧（时间戳回退 ${videoTsBack} 次），audio=${audioFrames.length} 帧，时长 ≈ ${(lastVideoTs / 1000).toFixed(1)}s`
)
// 负 pts / 大幅回退探查（Matroska B 帧跨 Cluster 负相对时间戳）
{
  const negPts = videoFrames.filter((f) => f.timestampMs < 0)
  const deepBack: string[] = []
  let prevTs = videoFrames[0]?.timestampMs ?? 0
  for (const f of videoFrames.slice(1)) {
    if (prevTs - f.timestampMs > 200) {
      deepBack.push(`${f.timestampMs}ms(前 ${prevTs}ms)`)
      if (deepBack.length >= 10) break
    }
    prevTs = Math.max(prevTs, f.timestampMs)
  }
  console.log(
    `负 pts 帧: ${negPts.length} 个；深回退(>200ms): ${deepBack.length} 处 → ${deepBack.join(' | ')}`
  )
}

// ---------- 4. 音频分批转码（镜像 pushToAudioBatch/dispatchAudioBatch + worker exec） ----------
interface AudioBatch {
  frames: Uint8Array[]
  bytes: number
  startMs: number
}
const batches: AudioBatch[] = []
let cur: AudioBatch | null = null
for (const f of audioFrames) {
  if (f.timestampMs > LIMIT_MS) break
  if (!cur) cur = { frames: [], bytes: 0, startMs: f.timestampMs }
  cur.frames.push(f.data)
  cur.bytes += f.data.byteLength
  if (f.timestampMs - cur.startMs >= BATCH_DURATION_MS || cur.bytes >= BATCH_MAX_BYTES) {
    batches.push(cur)
    cur = null
  }
}
if (cur) batches.push(cur)
console.log(`音频分批：${batches.length} 批`)

// ---------- 5. ADTS 解析（镜像 onAdtsDecoded） ----------
const ADTS_FREQ_TABLE: Record<number, number> = {
  0: 96000, 1: 88200, 2: 64000, 3: 48000, 4: 44100, 5: 32000, 6: 24000,
  7: 22050, 8: 16000, 9: 12000, 10: 11025, 11: 8000, 12: 7350,
}
let ascDescription: Uint8Array | null = null
let ascSampleRate: number | null = null
let lastAudioPtsUs: number | null = null
const decodedAudio: { ptsUs: number; durUs: number; data: Uint8Array }[] = []

for (let bi = 0; bi < batches.length; bi++) {
  const batch = batches[bi]!
  const total = batch.frames.reduce((n, f) => n + f.byteLength, 0)
  const merged = new Uint8Array(total)
  let off = 0
  for (const f of batch.frames) {
    merged.set(f, off)
    off += f.byteLength
  }
  // 与 transcode-worker.ts 完全相同的命令
  inst.FS.writeFile('in.audio', merged)
  const code = ffExec([
    '-i', 'in.audio', '-map', '0:a:0?', '-ac', '2', '-c:a', 'aac',
    '-b:a', '192k', '-f', 'adts', 'out.aac',
  ])
  if (code !== 0) throw new Error(`批次 ${bi} 转码失败：exit ${code}`)
  const adts = inst.FS.readFile('out.aac')
  try { inst.FS.unlink('out.aac') } catch { /* ignore */ }
  try { inst.FS.unlink('in.audio') } catch { /* ignore */ }
  if (adts.byteLength === 0) throw new Error(`批次 ${bi} 转码无输出`)

  // ADTS 帧遍历
  let p = 0
  let frameIdx = 0
  while (p + 7 <= adts.length) {
    if (adts[p] !== 0xff || (adts[p + 1]! & 0xf0) !== 0xf0) {
      throw new Error(`批次 ${bi} ADTS 同步字丢失 @${p}`)
    }
    const hdr = (adts[p + 1]! & 0x01) === 0 ? 9 : 7
    const profileBits = (adts[p + 2]! >> 6) & 0x3
    const freqIdx = (adts[p + 2]! >> 2) & 0xf
    const chanCfg = ((adts[p + 2]! & 0x1) << 2) | ((adts[p + 3]! >> 6) & 0x3)
    const frameLen =
      ((adts[p + 3]! & 0x3) << 11) | (adts[p + 4]! << 3) | ((adts[p + 5]! >> 5) & 0x7)
    if (frameLen < hdr || p + frameLen > adts.length) {
      throw new Error(`批次 ${bi} ADTS 帧长度异常 @${p}`)
    }
    if (!ascDescription) {
      const aot = profileBits + 1
      ascDescription = new Uint8Array([
        ((aot & 0x1f) << 3) | ((freqIdx & 0xf) >> 1),
        (((freqIdx & 0x1) << 7) | ((chanCfg & 0xf) << 3)) & 0xff,
      ])
      ascSampleRate = ADTS_FREQ_TABLE[freqIdx] ?? 48000
      console.log(`ASC 构造: AOT=${aot} freq=${ascSampleRate} ch=${chanCfg}`)
    }
    const sampleRate = ADTS_FREQ_TABLE[freqIdx] ?? 48000
    const frameDurUs = Math.round((1024 / sampleRate) * 1e6)
    let ptsUs = batch.startMs * 1000 + frameIdx * frameDurUs
    if (lastAudioPtsUs !== null && ptsUs <= lastAudioPtsUs) {
      ptsUs = lastAudioPtsUs + frameDurUs
    }
    lastAudioPtsUs = ptsUs
    const payload = new Uint8Array(frameLen - hdr)
    payload.set(adts.subarray(p + hdr, p + frameLen))
    decodedAudio.push({ ptsUs, durUs: frameDurUs, data: payload })
    frameIdx++
    p += frameLen
  }
}
console.log(`AAC 解码样本：${decodedAudio.length} 帧（末帧 pts ≈ ${((lastAudioPtsUs ?? 0) / 1e6).toFixed(1)}s）`)
if (decodedAudio.length === 0) throw new Error('无 AAC 样本产出')

// ---------- 5.5 丢帧定位诊断 ----------
// 基准 1：原始 MKV 直接解码（ffmpeg 自己的解复用器）；限时模式跳过（全片太慢）
if (!Number.isFinite(LIMIT_SEC)) {
  inst.FS.writeFile('orig.mkv', mkv)
  const code0 = ffExec(['-i', 'orig.mkv', '-map', '0:v:0', '-f', 'null', '-'])
  try { inst.FS.unlink('orig.mkv') } catch { /* ignore */ }
  const m = logs.join('\n').match(/frame=\s*(\d+)/g) ?? []
  const last = m[m.length - 1]?.match(/(\d+)/)?.[1] ?? '?'
  console.log(`基准：原始 MKV 视频解码 frame=${last} exit=${code0}`)
}
// 基准 2：解出的视频帧逐个扫 NALU 类型，找无 VCL(slice) 的帧
{
  // 帧格式探查：前 16 字节 hex（判断 Annex-B 起始码 vs AVCC 长度前缀）
  for (const i of [0, 1, 2, 48, 49]) {
    const d = videoFrames[i]!.data
    console.log(
      `帧#${i} @${videoFrames[i]!.timestampMs}ms ${d.byteLength}B 前16B:`,
      [...d.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    )
  }
  const vclTypes = new Set([1, 5])
  const bad: { idx: number; ts: number; bytes: number; types: number[] }[] = []
  for (let i = 0; i < videoFrames.length; i++) {
    const f = videoFrames[i]!
    const types: number[] = []
    let p = 0
    const d = f.data
    while (p + 3 < d.length) {
      if (d[p] === 0 && d[p + 1] === 0 && d[p + 2] === 1) {
        if (p + 4 <= d.length) types.push(d[p + 3]! & 0x1f)
        p += 3
      } else {
        p++
      }
    }
    if (!types.some((t) => vclTypes.has(t))) {
      bad.push({ idx: i, ts: f.timestampMs, bytes: d.byteLength, types })
    }
  }
  console.log(
    `无 VCL NALU 的视频帧: ${bad.length} 个`,
    bad.slice(0, 10).map((b) => `#${b.idx}@${b.ts}ms ${b.bytes}B nal=[${b.types.join(',')}]`).join(' | ')
  )
}

// ---------- 6. mp4-muxer 封装（镜像 ensureMuxerAttached + runSequencer 写入逻辑） ----------
const chunks: Uint8Array[] = []
const muxer = new Muxer({
  target: new StreamTarget({
    onData: (data: Uint8Array, _position: number) => {
      void _position
      if (data.byteLength > 0) chunks.push(data)
    },
    chunked: false,
  }),
  fastStart: 'fragmented',
  minFragmentDuration: 2,
  firstTimestampBehavior: 'cross-track-offset',
  video: {
    codec: 'avc',
    width: videoTrack.pixelWidth ?? 640,
    height: videoTrack.pixelHeight ?? 360,
  },
  audio: {
    codec: 'aac',
    // 镜像 player 修复：转码路径 worker 固定 -ac 2 输出立体声
    numberOfChannels: 2,
    sampleRate: ascSampleRate ?? audioTrack.samplingRate ?? 48000,
  },
})

const videoMeta = () => ({
  decoderConfig: {
    codec: 'avc1.640029',
    description: videoTrack.codecPrivate!,
  },
})
const audioMeta = () => ({
  decoderConfig: {
    codec: 'mp4a.40.2',
    numberOfChannels: 2,
    sampleRate: ascSampleRate ?? 48000,
    description: ascDescription!,
  },
})

// 音视频写入：镜像 player.ts runSequencer 的 GOP 时窗交错（mp4-muxer 按
// chunk 到达顺序切 fragment，必须与真实写入顺序一致才有效）
//
// B 帧关键约束（真实片源实测）：
// - Matroska 的 Block 顺序 = 解码顺序（DTS 序），Block 时间戳 = PTS（显示序）
// - 写入必须保持块序（解码序），按 PTS 排序会把 B 帧放到其参考帧之前
//   → 参考帧错序 → 解码器崩溃（Chrome PIPELINE_ERROR_DECODE 根因）
// - DTS 由 GOP 内回推算法推断：dts[n-1]=pts[n-1]，dts[i]=min(pts[i],
//   dts[i+1]-1ms)，保证 DTS 严格递增且 cto=pts-dts ≥ 0
let gopCtoCount = 0
{
  // 视频按关键帧切 GOP（含尾段）——保持块序（解码序），不排序！
  const gops: DemuxedFrame[][] = []
  let curGop: DemuxedFrame[] = []
  for (const f of videoFrames) {
    if (f.keyframe && curGop.length > 0) {
      gops.push(curGop)
      curGop = []
    }
    curGop.push(f)
  }
  if (curGop.length > 0) gops.push(curGop)

  const gopEndUs = (g: DemuxedFrame[]) =>
    Math.max(...g.map((f) => f.timestampMs)) * 1000 + 60_000

  // GOP 内回推 DTS：从末帧（pts 一般最大）向前，dts[i] = min(pts[i],
  // dts[i+1] - 1ms)；跨 GOP 边界再与全局 lastVideoDtsMs 对齐
  function computeDtsMs(gop: DemuxedFrame[], floorMs: number): number[] {
    const n = gop.length
    const dts: number[] = new Array(n)
    dts[n - 1] = gop[n - 1]!.timestampMs
    for (let i = n - 2; i >= 0; i--) {
      dts[i] = Math.min(gop[i]!.timestampMs, dts[i + 1]! - 1)
    }
    // 与上一 GOP 末尾 dts 衔接：若 GOP 首帧 dts ≤ floor，整体仍需递增
    if (floorMs > -Infinity && dts[0]! <= floorMs) {
      // 首帧钳制到 floor+1，其余帧保证 > 前帧且 ≤ pts
      dts[0] = floorMs + 1
      for (let i = 1; i < n; i++) {
        if (dts[i]! <= dts[i - 1]!) dts[i] = dts[i - 1]! + 1
      }
    }
    return dts
  }

  let lastVideoDtsMs: number | null = null
  let audioIdx = 0
  let gopIdx = 0
  for (const gop of gops) {
    const endUs = gopEndUs(gop)
    // 先写音频：≤ GOP 末端+50ms 的样本（与 runSequencer 一致）
    while (audioIdx < decodedAudio.length) {
      const a = decodedAudio[audioIdx]!
      if (a.ptsUs + a.durUs > endUs + 50_000) break
      audioIdx++
      muxer.addAudioChunkRaw(a.data, 'key', a.ptsUs, a.durUs, audioMeta())
    }
    // 视频帧：块序 + 回推 DTS
    const dtsArr = computeDtsMs(gop, lastVideoDtsMs ?? -Infinity)
    // 诊断：GOP 内 pts 序与回推结果异常时打印
    if (dtsArr[0]! < 0 || (lastVideoDtsMs !== null && dtsArr[0]! <= lastVideoDtsMs)) {
      console.log(
        `GOP#${gopIdx} 异常: n=${gop.length} 首帧pts=${gop[0]!.timestampMs} 末帧pts=${gop[gop.length - 1]!.timestampMs} dts[0]=${dtsArr[0]} floor=${lastVideoDtsMs}`,
        '帧pts序:', gop.slice(0, 12).map((f) => f.timestampMs).join(',')
      )
    }
    gopIdx++
    for (let gi = 0; gi < gop.length; gi++) {
      const f = gop[gi]!
      const dts = dtsArr[gi]!
      lastVideoDtsMs = dts
      if (gopIdx <= 2 && gi < 8) {
        console.log(`  GOP#${gopIdx} 帧${gi}: pts=${f.timestampMs}ms dts=${dts}ms kf=${f.keyframe}`)
      }
      // mp4-muxer 语义：第三参 = PTS（µs），内部 DTS = timestamp - cto。
      // 必须传 ptsUs + cto=pts-dts；若传 dtsUs + cto，内部 DTS 会变成
      // 2*dts-pts，B 帧场景（cto>0）直接产生负 DTS → 单调性断言崩溃
      const ptsUs = f.timestampMs * 1000
      const cto = Math.max(0, Math.round(ptsUs - dts * 1000))
      if (cto > 0) gopCtoCount++
      // duration 必须传真实值：mp4-muxer 的 sample duration 以「下一样本
      // dts 差」精化，但 fragment 末 sample 永远等不到下一样本——传 0
      // 会让该 sample duration=0 被解码器丢弃
      const next = gop[gi + 1]
      const durUs = next
        ? Math.max(1000, (dtsArr[gi + 1]! - dts) * 1000)
        : Math.max(1000, (f.timestampMs - (gop[gi - 1]?.timestampMs ?? f.timestampMs - 42)) * 1000)
      const avccFrame = annexBToAvcc(f.data)
      muxer.addVideoChunkRaw(
        avccFrame, f.keyframe ? 'key' : 'delta', ptsUs, durUs, videoMeta(), cto
      )
    }
  }
  // 尾部残余音频（与 handleEof 冲刷一致）
  while (audioIdx < decodedAudio.length) {
    const a = decodedAudio[audioIdx++]!
    muxer.addAudioChunkRaw(a.data, 'key', a.ptsUs, a.durUs, audioMeta())
  }
}
muxer.finalize()

const totalBytes = chunks.reduce((n, c) => n + c.byteLength, 0)
const outMp4 = new Uint8Array(totalBytes)
let woff = 0
for (const c of chunks) {
  outMp4.set(c, woff)
  woff += c.byteLength
}
mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'wasmtest-out.mp4')
writeFileSync(outPath, outMp4)
console.log(`封装完成: ${outPath} ${(totalBytes / 1024 / 1024).toFixed(2)}MB（cto>0 的帧 ${gopCtoCount} 个）`)

// ---------- 7. 全量解码验证 ----------
inst.FS.writeFile('check.mp4', outMp4)

// trun 直读：解析每个 fragment 的 sample 表，定位异常 sample
// 布局对齐 mp4-muxer trun 实现：flags 0x1=data-offset, 0x4=first-sample-flags
// （data-offset 之后、per-sample 字段之前）, 0x100=dur, 0x200=size,
// 0x400=per-sample flags, 0x800=cto
function dumpTruns(file: Uint8Array): void {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const boxType = (o: number) =>
    String.fromCharCode(file[o + 4]!, file[o + 5]!, file[o + 6]!, file[o + 7]!)
  let p = 0
  let moofIdx = 0
  const trackSampleTotal = new Map<number, number>()
  const anomalies: string[] = []
  const ctoNonZero = new Map<number, number>()
  while (p + 8 <= file.length) {
    const size = dv.getUint32(p)
    if (size < 8) break
    if (boxType(p) === 'moof') {
      moofIdx++
      let q = p + 8
      while (q + 8 <= p + size) {
        const tsize = dv.getUint32(q)
        if (tsize < 8) break
        if (boxType(q) === 'traf') {
          let trackId = -1
          let r = q + 8
          while (r + 8 <= q + tsize) {
            const ssize = dv.getUint32(r)
            if (ssize < 8) break
            const stype = boxType(r)
            if (stype === 'tfhd') {
              trackId = dv.getUint32(r + 12)
            } else if (stype === 'trun') {
              const fullFlags = dv.getUint32(r + 8) & 0xffffff
              const sampleCount = dv.getUint32(r + 12)
              let off = r + 16
              if (fullFlags & 0x1) off += 4 // data offset
              if (fullFlags & 0x4) off += 4 // first sample flags
              const durP = !!(fullFlags & 0x100)
              const sizeP = !!(fullFlags & 0x200)
              const flagsP = !!(fullFlags & 0x400)
              const ctoP = !!(fullFlags & 0x800)
              trackSampleTotal.set(trackId, (trackSampleTotal.get(trackId) ?? 0) + sampleCount)
              for (let s = 0; s < sampleCount; s++) {
                let dur = -1
                let sz = -1
                let cto = 0
                if (durP) { dur = dv.getUint32(off); off += 4 }
                if (sizeP) { sz = dv.getUint32(off); off += 4 }
                if (flagsP) off += 4
                if (ctoP) { cto = dv.getInt32(off); off += 4 }
                if (cto !== 0) {
                  ctoNonZero.set(trackId, (ctoNonZero.get(trackId) ?? 0) + 1)
                }
                if (dur === 0 || sz === 0) {
                  anomalies.push(`moof#${moofIdx} track=${trackId} sample#${s} dur=${dur} size=${sz}`)
                }
              }
            }
            r += ssize
          }
        }
        q += tsize
      }
    }
    p += size
  }
  console.log(
    `trun 解析: ${moofIdx} 个 moof，各轨道 sample 总数:`,
    [...trackSampleTotal.entries()].map(([id, n]) => `track${id}=${n}`).join(' '),
    `（源 video=${videoFrames.length} audio=${decodedAudio.length}）`
  )
  console.log(
    [...ctoNonZero.entries()].length > 0
      ? `cto≠0 样本: ${[...ctoNonZero.entries()].map(([id, n]) => `track${id}=${n}`).join(' ')}`
      : 'cto 全为 0'
  )
  console.log(anomalies.length > 0
    ? `异常 sample（dur=0 或 size=0）: ${anomalies.length} 个 → ${anomalies.slice(0, 8).join(' | ')}`
    : 'trun 无异常 sample（dur/size 均非 0）')
}
dumpTruns(outMp4)

const code = ffExec(['-i', 'check.mp4', '-f', 'null', '-'])
try { inst.FS.unlink('check.mp4') } catch { /* ignore */ }
const stderrText = logs.join('\n')
// 取最后一次进度行：ffmpeg 增量打印 frame=，首次匹配只是中间值
const frameMatches = stderrText.match(/frame=\s*(\d+)/g) ?? []
const mp4FrameLine = frameMatches[frameMatches.length - 1]?.match(/(\d+)/)
const mp4NoFrame = (stderrText.match(/no frame!/g) ?? []).length
const mp4NoFrameExpected = videoFrames.length - parseInt(mp4FrameLine?.[1] ?? '0', 10)
console.log(
  `MP4 解码统计: frame=${mp4FrameLine?.[1] ?? '?'}（源 ${videoFrames.length}，缺失 ${mp4NoFrameExpected}），no frame! ${mp4NoFrame} 次`
)
console.log('--- ffmpeg 解码校验 stderr（尾部）---')
console.log(stderrText.split('\n').slice(-8).join('\n'))
if (code !== 0) throw new Error('输出 MP4 解码失败')

// 总结行："video:xxxkB audio:xxxkB ..."——两轨都必须有数据
const summary = stderrText.match(/video:(\d+)kB audio:(\d+)kB/)
if (!summary) throw new Error('未找到 ffmpeg 解码总结行')
const videoKb = parseInt(summary[1]!, 10)
const audioKb = parseInt(summary[2]!, 10)
console.log(`\n校验通过：video=${videoKb}kB audio=${audioKb}kB 均成功解码`)
if (videoKb === 0) throw new Error('视频轨解码数据为 0')
if (audioKb === 0) throw new Error('音频轨解码数据为 0')

// ---------- 8. 隔离诊断：avcc chunk 转回 Annex-B 裸流直接解码 ----------
// 裸流需注入 avcC 中的 SPS/PPS（MP4 场景由 avcC box 提供，裸流没有）
// 若裸流同样失败 → annexBToAvcc/写入逻辑问题；若裸流全过 → muxer 问题
{
  // 解析 avcC：[ver profile compat level lenbits] [nSPS] [len SPS]... [nPPS] [len PPS]...
  const avcc = videoTrack.codecPrivate!
  const paramSets: number[][] = []
  let q = 5
  if (avcc[0] === 1 && avcc.length > 8) {
    const nSPS = avcc[q]! & 0x1f
    q++
    for (let i = 0; i < nSPS; i++) {
      const len = (avcc[q]! << 8) | avcc[q + 1]!
      paramSets.push([...avcc.subarray(q + 2, q + 2 + len)])
      q += 2 + len
    }
    const nPPS = avcc[q]!
    q++
    for (let i = 0; i < nPPS; i++) {
      const len = (avcc[q]! << 8) | avcc[q + 1]!
      paramSets.push([...avcc.subarray(q + 2, q + 2 + len)])
      q += 2 + len
    }
  }
  console.log(`avcC 参数集数量: ${paramSets.length}（SPS+PPS）`)

  const annexb: number[] = []
  let first = true
  let kf = 0
  let nf = 0
  for (const f of videoFrames) {
    const avccFrame = annexBToAvcc(f.data)
    // 每个关键帧前注入 SPS/PPS
    if (first || f.keyframe) {
      for (const ps of paramSets) {
        annexb.push(0, 0, 0, 1, ...ps)
        nf++
      }
    }
    first = false
    // 逐 NALU 加回起始码
    let p = 0
    while (p + 4 <= avccFrame.length) {
      const len =
        (avccFrame[p]! << 24) | (avccFrame[p + 1]! << 16) | (avccFrame[p + 2]! << 8) | avccFrame[p + 3]!
      if (len < 1 || p + 4 + len > avccFrame.length) break
      annexb.push(0, 0, 0, 1)
      for (let i = 0; i < len; i++) annexb.push(avccFrame[p + 4 + i]!)
      p += 4 + len
      nf++
    }
    if (f.keyframe) kf++
  }
  const raw = new Uint8Array(annexb)
  inst.FS.writeFile('check.h264', raw)
  const code2 = ffExec(['-i', 'check.h264', '-f', 'null', '-'])
  try { inst.FS.unlink('check.h264') } catch { /* ignore */ }
  const rawText = logs.join('\n')
  const rawNoFrame = (rawText.match(/no frame!/g) ?? []).length
  const rawFrameMatches = rawText.match(/frame=\s*(\d+)/g) ?? []
  const frameLine = rawFrameMatches[rawFrameMatches.length - 1]?.match(/(\d+)/)
  console.log(
    `裸流隔离诊断: 关键帧 ${kf}，annexb NALU 总数 ${nf}，解码 frame=${frameLine?.[1] ?? '?'}，no frame! ${rawNoFrame} 次，exit=${code2}`
  )
}

console.log('\n✅ wasm-engine 转码管线端到端验证通过（解复用→转码→封装→解码）')

// ---------- 8. showinfo 帧类型分析：解出的 1798 帧里 I/P/B 分布 ----------
{
  // 8.1 原始 MKV 直接解前 3 秒（ffmpeg 自己的 demuxer，作为黄金基准）
  inst.FS.writeFile('orig2.mkv', mkv)
  const codeM = ffExec(['-i', 'orig2.mkv', '-t', '3', '-map', '0:v:0', '-vf', 'showinfo', '-f', 'null', '-'])
  try { inst.FS.unlink('orig2.mkv') } catch { /* ignore */ }
  const mkvText = logs.join('\n')
  const mkvTypes: Record<string, number> = {}
  for (const m of mkvText.matchAll(/type:([IPB])/g)) {
    mkvTypes[m[1]!] = (mkvTypes[m[1]!] ?? 0) + 1
  }
  const mkvLines = mkvText.split('\n').filter((l) => l.includes('type:'))
  console.log(
    `原始MKV前3s: I=${mkvTypes['I'] ?? 0} P=${mkvTypes['P'] ?? 0} B=${mkvTypes['B'] ?? 0} 共${mkvLines.length}帧 exit=${codeM}`,
    '显示序前10帧:',
    mkvLines.slice(0, 10).map((l) => {
      const t = l.match(/pts_time:([\d.]+)/)?.[1] ?? '?'
      const ty = l.match(/type:(\w)/)?.[1] ?? '?'
      return `${t}s:${ty}`
    }).join(' ')
  )

  inst.FS.writeFile('check2.mp4', outMp4)
  const codeS = ffExec(['-i', 'check2.mp4', '-vf', 'showinfo', '-f', 'null', '-'])
  try { inst.FS.unlink('check2.mp4') } catch { /* ignore */ }
  const infoText = logs.join('\n')
  try { inst.FS.unlink('check.mp4') } catch { /* ignore */ }
  const typeCounts: Record<string, number> = {}
  for (const m of infoText.matchAll(/type:([IPB])/g)) {
    typeCounts[m[1]!] = (typeCounts[m[1]!] ?? 0) + 1
  }
  console.log(
    `showinfo 帧类型分布: I=${typeCounts['I'] ?? 0} P=${typeCounts['P'] ?? 0} B=${typeCounts['B'] ?? 0} exit=${codeS}`
  )
  // 头 12 帧的显示序（pts_time + type）
  const lines = infoText.split('\n').filter((l) => l.includes('type:'))
  console.log(
    '显示序前12帧:',
    lines.slice(0, 12).map((l) => {
      const t = l.match(/pts_time:([\d.]+)/)?.[1] ?? '?'
      const ty = l.match(/type:(\w)/)?.[1] ?? '?'
      return `${t}s:${ty}`
    }).join(' ')
  )
}
