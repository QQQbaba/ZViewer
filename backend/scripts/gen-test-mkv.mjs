/**
 * 在 Node 中加载 @ffmpeg/core（UMD），生成 wasm-engine 测试样本：
 *   H.264(annexB in MKV) + FLAC 音轨（worker 转码路径与 DTS 完全一致）
 * 产物：frontend/public/test/wasmtest.mkv
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const coreJs = 'f:/Code/ZViewer/ZViewer/frontend/public/ffmpeg/ffmpeg-core.js'
const coreWasm = 'f:/Code/ZViewer/ZViewer/frontend/public/ffmpeg/ffmpeg-core.wasm'

// 与 transcode-worker 相同的加载方式：文本追加 export default 后经临时 ESM 文件导入
// polyfill：core.js 引用浏览器全局 self / location
globalThis.self = globalThis
if (!globalThis.location) {
  globalThis.location = { href: 'http://localhost/' }
}
const coreText = readFileSync(coreJs, 'utf8')
const tmpEsm = path.resolve('scripts/.ffmpeg-core-esm.mjs')
writeFileSync(tmpEsm, coreText + '\nexport default createFFmpegCore;\n')
const mod = await import('file:///' + tmpEsm.replace(/\\/g, '/'))
const factory = mod.default ?? mod.createFFmpegCore
if (typeof factory !== 'function') throw new Error('factory not found')
const wasmBinary = readFileSync(coreWasm)
let inst
try {
  inst = await factory({
    wasmBinary,
    printErr: (s) => { if (!String(s).startsWith('Aborted')) console.debug('[ff]', s) },
  })
} catch (err) {
  console.error('FACTORY FAILED:', err && err.message ? err.message : err)
  throw err
}

function run(args) {
  const code = inst.exec(...args)
  console.log('[ffmpeg exit]', code, args.join(' '))
  return code
}

const outDir = 'f:/Code/ZViewer/ZViewer/frontend/public/test'
mkdirSync(outDir, { recursive: true })
const out = 'wasmtest.mkv'

// 60s：24fps 640x360 H.264 + AC3 48k 立体声
// AC3 与 DTS 同走 needsWasmAudioTranscode 非白名单路径，且帧自包含（同步字），
// 裸流喂 ffmpeg 可探测；FLAC 帧依赖 CodecPrivate 中的 STREAMINFO，不适合作 DTS 替身。
const code = run([
  '-f', 'lavfi', '-i', 'testsrc=duration=60:size=640x360:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=60',
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline', '-g', '48', '-keyint_min', '48',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'ac3', '-b:a', '192k',
  '-f', 'matroska', out,
])
if (code !== 0) throw new Error('ffmpeg failed: ' + code)
const data = inst.FS.readFile(out)
writeFileSync(path.join(outDir, out), data)
console.log('written:', path.join(outDir, out), data.length, 'bytes')
