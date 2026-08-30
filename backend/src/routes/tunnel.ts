/**
 * 公网邀请通道（隧道）管理路由。
 *
 * 在 App/本机环境（内置 cloudflared + proot）下，允许管理员
 * 一键开启/关闭公网邀请链接，让朋友通过链接加入房间一起看。
 * 非 App 环境（无组件）时返回“不可用”。
 *
 * 依赖环境变量（由壳注入）：
 *   PROOT_BIN        proot 可执行文件路径
 *   PROOT_LOADER     proot loader 路径
 *   CLOUDFLARED_BIN  cloudflared 可执行文件路径
 *   CLOUDKIT_DIR     cloudkit 目录（含 rootfs/ 与 lib/）
 */
import { Router } from 'express'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const router = Router()

let proc: ChildProcess | null = null
let tunnelUrl: string | null = null
let logBuf = ''

function envBin(name: string): string | null {
  const v = process.env[name]
  return v && fs.existsSync(v) ? v : null
}

function extractUrl() {
  const m = logBuf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)
  if (m) {
    const u = m.find((x) => !x.includes('api.'))
    if (u) tunnelUrl = u
  }
}

function startCloudflared(): { ok: boolean; message: string } {
  if (proc) return { ok: false, message: '通道已在运行中' }
  const proot = envBin('PROOT_BIN')
  const cfd = envBin('CLOUDFLARED_BIN')
  const loader = envBin('PROOT_LOADER')
  const kit = process.env.CLOUDKIT_DIR
  if (!proot || !cfd || !loader || !kit || !fs.existsSync(path.join(kit, 'rootfs'))) {
    return { ok: false, message: '隧道组件不可用（当前环境未内置 proot/cloudflared）' }
  }
  const rootfs = path.join(kit, 'rootfs')
  const port = process.env.PORT || '3333'
  const args = [
    '-0', '-r', rootfs,
    '-b', '/proc', '-b', '/sys', '-b', '/dev',
    '-b', `${cfd}:/cloudflared`,
    '/cloudflared', 'tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate',
  ]
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: path.join(kit, 'lib'),
    PROOT_TMP_DIR: path.join(kit, 'rootfs', 'tmp'),
    PROOT_LOADER: loader,
  }
  logBuf = ''
  tunnelUrl = null
  proc = spawn(proot, args, { env })
  proc.stdout?.on('data', (d: Buffer) => { logBuf += d.toString(); extractUrl() })
  proc.stderr?.on('data', (d: Buffer) => { logBuf += d.toString(); extractUrl() })
  proc.on('exit', (code) => {
    proc = null
    tunnelUrl = null // 进程退出（主动关闭或崩溃）都清空链接，避免残留死链接
    if (code !== 0) logBuf += `\n[通道进程退出 code=${code}]`
  })
  return { ok: true, message: '通道启动中，约 10~30 秒就绪' }
}

function stopCloudflared(): { ok: boolean; message: string } {
  if (!proc) return { ok: false, message: '通道未在运行' }
  try { proc.kill('SIGKILL') } catch { /* 忽略 */ }
  proc = null
  tunnelUrl = null // 修复：关闭后清空链接，避免前端残留显示
  return { ok: true, message: '已停止，邀请链接已失效' }
}

/** GET /api/tunnel/status */
router.get('/status', (_req, res) => {
  res.json({ success: true, running: !!proc, url: tunnelUrl })
})

/** POST /api/tunnel/start */
router.post('/start', (_req, res) => {
  const r = startCloudflared()
  res.json({ success: r.ok, message: r.message })
})

/** POST /api/tunnel/stop */
router.post('/stop', (_req, res) => {
  const r = stopCloudflared()
  res.json({ success: r.ok, message: r.message })
})

export default router
