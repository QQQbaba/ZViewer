/**
 * 模拟观众：连入指定房间，打印收到的所有同步事件（带时间戳），
 * 用于定位"房主跳转后观众不跟随"是事件未到达还是前端执行问题。
 *
 * 用法：node mock_viewer.js <roomId>
 */
const { io } = require('socket.io-client')

const roomId = process.argv[2] || 'vdGrV6Kf'
const BASE = 'http://127.0.0.1:3333'

async function main() {
  // 1. 获取 guest token
  const res = await fetch(`${BASE}/api/auth/guest`, { method: 'POST' })
  const data = await res.json()
  if (!data.success && !data.accessToken) {
    console.error('获取 guest token 失败:', data)
    process.exit(1)
  }
  const token = data.accessToken
  console.log(`[mock-viewer] guest token 获取成功`)

  // 2. 连接 socket
  const socket = io(BASE, {
    transports: ['websocket', 'polling'],
    auth: { token },
  })

  const ts = () => new Date().toISOString().slice(11, 23)

  socket.on('connect', () => {
    console.log(`[${ts()}] connected: ${socket.id}`)
    // 3. 加入房间
    socket.emit(
      'request-join',
      { roomId, password: '' },
      (resp) => {
        console.log(`[${ts()}] request-join ack:`, JSON.stringify(resp).slice(0, 200))
      }
    )
  })

  socket.on('connect_error', (err) => {
    console.error(`[${ts()}] connect_error:`, err.message)
  })

  // 4. 监听同步事件
  socket.on('watch-together-state', (p) => {
    console.log(
      `[${ts()}] STATE seq=${p.seq ?? '-'} diff=${!!p.diff} sourceUrl=${(p.state?.sourceUrl || '').slice(0, 50)} currentTime=${p.state?.currentTime?.toFixed?.(2)} isPlaying=${p.state?.isPlaying}`
    )
  })

  socket.on('watch-together-control', (p) => {
    console.log(
      `[${ts()}] CONTROL action=${p.action} value=${typeof p.value === 'number' ? p.value.toFixed(2) : p.value}`
    )
  })

  socket.on('host-heartbeat', (p) => {
    console.log(
      `[${ts()}] HOST_HEARTBEAT t=${p.currentTime?.toFixed?.(2)} playing=${p.isPlaying} suppressed=${p.suppressed}`
    )
  })

  socket.on('sync-heartbeat', (p) => {
    if (p.source === 'host') return // 与上一条重复，不打印
    console.log(`[${ts()}] SYNC_HEARTBEAT source=${p.source}`)
  })

  socket.on('play-preview-source', (p) => {
    console.log(`[${ts()}] PREVIEW_SOURCE url=${(p.source?.url || '').slice(0, 50)}`)
  })

  socket.on('disconnect', (reason) => {
    console.log(`[${ts()}] disconnected: ${reason}`)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
