/**
 * 前端 MKV 内嵌字幕提取验证（一次性）。
 *
 * 1. ffmpeg.wasm 把 wasmtest.mkv + SRT 合成 subtest.mkv（双字幕轨：srt + ass）
 * 2. probeMkvSubtitleTracks / extractMkvSubtitleTrack 全链路验证（fetch dev server）
 * 3. parseSubtitle 解析提取产物校验 cue 数量与时间戳
 *
 * 运行：cd frontend && npx tsx scripts/test-mkv-subtitle.mts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mkvPath = path.resolve(__dirname, '../public/test/wasmtest.mkv')
const coreJs = path.resolve(__dirname, '../public/ffmpeg/ffmpeg-core.js')
const coreWasm = path.resolve(__dirname, '../public/ffmpeg/ffmpeg-core.wasm')
const outMkv = path.resolve(__dirname, '../public/test/subtest.mkv')
const baseUrl = 'http://localhost:5174'

// ---------- ffmpeg.wasm core 加载 ----------
globalThis.self = globalThis
if (!globalThis.location) {
  globalThis.location = { href: 'http://localhost/' }
}
const coreText = readFileSync(coreJs, 'utf8')
const tmpEsm = path.resolve(__dirname, '.ffmpeg-core-esm.mjs')
writeFileSync(tmpEsm, coreText + '\nexport default createFFmpegCore;\n')
const mod = await import('file:///' + tmpEsm.replace(/\\/g, '/'))
const factory = mod.default ?? mod.createFFmpegCore
const logs: string[] = []
const inst = await factory({
  wasmBinary: readFileSync(coreWasm),
  printErr: (s: string) => logs.push(String(s)),
})

// ---------- 1. 合成测试文件 ----------
const srt = Array.from({ length: 30 }, (_, i) => {
  const s = i * 3
  return `${i + 1}\n${ms2srt(s * 1000)} --> ${ms2srt((s + 2) * 1000)}\n测试字幕 ${i + 1}：前端提取验证\n`
}).join('\n')
writeFileSync(path.resolve(__dirname, '../public/test/subtest.srt'), srt)

inst.FS.writeFile('orig.mkv', new Uint8Array(readFileSync(mkvPath)))
inst.FS.writeFile('in.srt', new TextEncoder().encode(srt))
let code = inst.exec(
  '-i', 'orig.mkv', '-i', 'in.srt',
  '-map', '0', '-map', '1',
  '-c', 'copy', '-c:s', 'srt',
  '-metadata:s:s:0', 'language=chi',
  '-metadata:s:s:0', 'title=中文字幕',
  '-disposition:s:0', 'default',
  'sub1.mkv'
)
if (code !== 0) throw new Error('srt 合成失败: ' + logs.join('\n'))
// 第二条 ASS 轨（ffmpeg 把 srt 转 ass 需重封装 s 轨，仍 copy 音视频）
code = inst.exec(
  '-i', 'sub1.mkv', '-i', 'in.srt',
  '-map', '0', '-map', '1',
  '-c', 'copy', '-c:s', 'copy',
  '-c:s:1', 'ass',
  '-metadata:s:s:1', 'language=eng',
  '-metadata:s:s:1', 'title=ASS track',
  'sub2.mkv'
)
if (code !== 0) throw new Error('ass 合成失败: ' + logs.join('\n'))
const out = inst.FS.readFile('sub2.mkv')
writeFileSync(outMkv, Buffer.from(out))
console.log(`合成 subtest.mkv: ${(out.length / 1024 / 1024).toFixed(2)}MB`)

// ---------- 2. 前端探测 / 提取 ----------
const { probeMkvSubtitleTracks, extractMkvSubtitleTrack } = await import(
  '../src/modules/subtitles/mkv-embedded'
)
const url = `${baseUrl}/test/subtest.mkv`
const tracks = await probeMkvSubtitleTracks(url)
console.log('探测结果:', tracks.map((t) =>
  `#${t.trackNumber} ${t.codecId} lang=${t.language} title=${t.title} supported=${t.supported}`))
if (tracks.length !== 2) throw new Error(`预期 2 条字幕轨，实际 ${tracks.length}`)

const srtTrack = tracks.find((t) => t.codecId === 'S_TEXT/UTF8')!
const assTrack = tracks.find((t) => t.codecId === 'S_TEXT/ASS')!

const srtOut = await extractMkvSubtitleTrack(url, srtTrack.trackNumber)
console.log(`SRT 提取: ${srtOut.content.length} 字节, 前 120 字:\n${srtOut.content.slice(0, 120)}`)
const assOut = await extractMkvSubtitleTrack(url, assTrack.trackNumber)
console.log(`ASS 提取: ${assOut.content.length} 字节, 含 [Events]: ${assOut.content.includes('[Events]')}`)
console.log(`ASS Dialogue 行数: ${(assOut.content.match(/^Dialogue:/gm) ?? []).length}`)

// ---------- 3. parseSubtitle 校验 ----------
const { parseSubtitle } = await import('../src/lib/subtitleParser')
const srtCues = parseSubtitle(srtOut.content, 'srt')
console.log(`SRT 解析: ${srtCues.length} cues（预期 30）`)
const assCues = parseSubtitle(assOut.content, 'ass')
console.log(`ASS 解析: ${assCues.length} cues（预期 30）`)
if (srtCues.length !== 30) throw new Error(`SRT cue 数量异常: ${srtCues.length}`)
if (assCues.length !== 30) throw new Error(`ASS cue 数量异常: ${assCues.length}`)
// 时间轴抽查：第 5 条 cue 应在 12s~14s
const c = srtCues[4]!
const fmt = (t: number) => `${t}s`
console.log(`cue#5: [${fmt(c.start)} → ${fmt(c.end)}] "${c.text}"`)
if (Math.abs(c.start - 12) > 0.5) throw new Error('cue#5 起始时间异常: ' + c.start)
if (!c.text.includes('前端提取验证')) throw new Error('cue 文本异常: ' + c.text)

console.log('\n✅ 前端 MKV 内嵌字幕提取验证通过（探测 / SRT / ASS / 时间轴）')

function ms2srt(ms: number): string {
  const cs = Math.floor(ms / 10) % 100
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 60000) % 60
  const h = Math.floor(ms / 3600000)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(cs).padStart(2, '0')}`
}
