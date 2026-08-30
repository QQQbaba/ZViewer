/**
 * B 站大会员高画质代理（ZViewerCLI）管理路由。
 *
 * 在 App 环境（内置 zviewer-cli + proot）下，允许用户一键开启/关闭
 * 本地 B 站高画质代理：CLI 使用用户自己的 Cookie 解析大会员画质，
 * 再代理给浏览器播放。
 *
 * 依赖环境变量（由壳注入）：
 *   ZCLI_BIN       zviewer-cli 可执行文件路径
 *   CLOUDKIT_DIR   cloudkit 目录（含 rootfs/ 与 lib/）
 *   PROOT_BIN / PROOT_LOADER  proot 组件
 */
import { Router } from 'express'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const router = Router()
const CLI_PORT = 9333

let proc: ChildProcess | null = null

function startCli(): { ok: boolean; message: string } {
  if (proc) return { ok: false, message: '代理已在运行中' }
  const proot = process.env.PROOT_BIN
  const loader = process.env.PROOT_LOADER
  const zcli = process.env.ZCLI_BIN
  const kit = process.env.CLOUDKIT_DIR
  if (!proot || !loader || !zcli || !kit || !fs.existsSync(path.join(kit, 'rootfs'))) {
    return { ok: false, message: '代理组件不可用（当前环境未内置 zviewer-cli）' }
  }
  const rootfs = path.join(kit, 'rootfs')
  const args = [
    '-0', '-r', rootfs,
    '-b', '/proc', '-b', '/sys', '-b', '/dev',
    '-b', `${zcli}:/zviewer-cli`,
    '/zviewer-cli', '-port', String(CLI_PORT), '-no-open',
  ]
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: path.join(kit, 'lib'),
    PROOT_TMP_DIR: path.join(kit, 'rootfs', 'tmp'),
    PROOT_LOADER: loader,
  }
  proc = spawn(proot, args, { env })
  proc.stdout?.on('data', () => {})
  proc.stderr?.on('data', () => {})
  proc.on('exit', () => {
    proc = null
  })
  return { ok: true, message: `代理启动中，配置页 http://127.0.0.1:${CLI_PORT}` }
}

function stopCli(): { ok: boolean; message: string } {
  if (!proc) return { ok: false, message: '代理未在运行' }
  try { proc.kill('SIGKILL') } catch { /* 忽略 */ }
  proc = null
  return { ok: true, message: '代理已停止' }
}

/** GET /api/zcli/status */
router.get('/status', (_req, res) => {
  res.json({ success: true, running: !!proc, port: CLI_PORT })
})

/** POST /api/zcli/start */
router.post('/start', (_req, res) => {
  const r = startCli()
  res.json({ success: r.ok, message: r.message })
})

/** POST /api/zcli/stop */
router.post('/stop', (_req, res) => {
  const r = stopCli()
  res.json({ success: r.ok, message: r.message })
})

export default router
