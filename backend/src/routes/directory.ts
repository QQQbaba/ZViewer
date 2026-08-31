/**
 * 房间目录路由（v11.3，方案 C：公告栏地址可配置）。
 *
 * 让房主可以把房间「公开」到中央公告栏（directory），
 * 其他用户即可在「发现公开房间」页面搜索到房间并直接加入。
 * 公告栏地址通过环境变量 DIRECTORY_URL 配置：
 *   - 为空 → 功能关闭（前端显示「公告栏未配置」）
 *   - 填 Cloudflare Worker 地址 → 全网公开可搜
 *
 * 接口：
 *   GET  /api/directory/config        → 公告栏地址与启用状态
 *   GET  /api/directory/rooms?search= → 搜索公开房间（转发公告栏）
 *   GET  /api/directory/rooms/:id     → 按房间号查房主最新地址
 *   POST /api/directory/publish       → 上报 { roomId, name }（地址取 TUNNEL_URL）
 *   POST /api/directory/unpublish     → 下架 { roomId }
 */
import { Router } from 'express'

const router = Router()

function directoryUrl(): string {
  return (process.env.DIRECTORY_URL || '').replace(/\/+$/, '')
}
function directorySecret(): string {
  return process.env.DIRECTORY_SECRET || ''
}

interface PublishedRoom {
  roomId: string
  name: string
}
let publishedRoom: PublishedRoom | null = null

export function getPublishedRoom(): PublishedRoom | null {
  return publishedRoom
}
export function setPublishedRoom(r: PublishedRoom | null): void {
  publishedRoom = r
}

export function publishNow(roomId: string, name: string): { ok: boolean; message: string } {
  const base = directoryUrl()
  if (!base) return { ok: false, message: '公告栏未配置（设置 DIRECTORY_URL 后可用）' }
  const url = process.env.TUNNEL_URL || ''
  if (!url) return { ok: false, message: '隧道未就绪' }
  const body: Record<string, unknown> = { roomId, name: name || roomId, url, ttlHours: 4 }
  if (directorySecret()) body.secret = directorySecret()
  fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .then(() => {
      console.log('[directory] 上报成功 room=' + roomId)
    })
    .catch((e: Error) => {
      console.error('[directory] 上报失败: ' + e.message)
    })
  return { ok: true, message: '已提交上报' }
}

export function unpublishNow(roomId: string): void {
  const base = directoryUrl()
  if (!base) return
  fetch(base + '/api/rooms/' + encodeURIComponent(roomId), { method: 'DELETE' }).catch(() => {
    /* ignore */
  })
}

router.get('/config', (_req, res) => {
  res.json({ success: true, url: directoryUrl(), enabled: !!directoryUrl() })
})

router.get('/rooms', (req, res) => {
  const base = directoryUrl()
  if (!base) return res.json({ success: false, message: '公告栏未配置', rooms: [] })
  const search = req.query.search || ''
  fetch(base + '/api/rooms?search=' + encodeURIComponent(String(search)) + '&limit=50')
    .then((r) => r.json())
    .then((j) => {
      res.json({ success: true, rooms: (j && j.rooms) || [] })
    })
    .catch((e: Error) => {
      res.json({ success: false, message: e.message, rooms: [] })
    })
})

router.get('/rooms/:roomId', (req, res) => {
  const base = directoryUrl()
  if (!base) return res.json({ success: false, message: '公告栏未配置' })
  fetch(base + '/api/rooms/' + encodeURIComponent(req.params.roomId))
    .then((r) => r.json())
    .then((j) => res.json(j))
    .catch((e: Error) => {
      res.json({ success: false, message: e.message })
    })
})

router.post('/publish', (req, res) => {
  const roomId: string | undefined = req.body && req.body.roomId
  const name: string = (req.body && req.body.name) || roomId
  if (!roomId) return res.json({ success: false, message: '缺少 roomId' })
  const base = directoryUrl()
  if (!base) return res.json({ success: false, message: '公告栏未配置（设置 DIRECTORY_URL 后可用）' })
  const url = process.env.TUNNEL_URL || ''
  if (!url) return res.json({ success: false, message: '隧道未就绪，请先开启公网通道' })
  setPublishedRoom({ roomId, name })
  publishNow(roomId, name)
  res.json({ success: true, message: '已发布到公告栏' })
})

router.post('/unpublish', (req, res) => {
  const roomId: string | undefined = req.body && req.body.roomId
  if (roomId) {
    unpublishNow(roomId)
    if (publishedRoom && publishedRoom.roomId === roomId) setPublishedRoom(null)
  }
  res.json({ success: true, message: '已下架' })
})

export default router
