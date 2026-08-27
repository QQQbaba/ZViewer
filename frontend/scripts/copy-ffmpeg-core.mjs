/**
 * 将 @ffmpeg/core 的 UMD 产物复制到 public/ffmpeg/。
 * postinstall 阶段执行，保证 CI / 全新安装后 wasm 资产随前端构建分发。
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// @ffmpeg/core 的 exports 未暴露 package.json，直接定位 node_modules 内路径
const coreDist = path.resolve(here, '../../node_modules/@ffmpeg/core/dist/umd')
const outDir = path.resolve(here, '../public/ffmpeg')

mkdirSync(outDir, { recursive: true })
copyFileSync(path.join(coreDist, 'ffmpeg-core.js'), path.join(outDir, 'ffmpeg-core.js'))
copyFileSync(path.join(coreDist, 'ffmpeg-core.wasm'), path.join(outDir, 'ffmpeg-core.wasm'))
console.log('[copy-ffmpeg-core] copied to public/ffmpeg/')
