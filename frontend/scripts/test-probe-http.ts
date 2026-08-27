/**
 * 临时排查：自签 token 后对 openlist stream 端点复现前端探测。
 */
import jwt from 'jsonwebtoken'
import { readFileSync } from 'node:fs'
import { MatroskaDemuxer, type DemuxedTrack } from '../src/modules/player/wasm-engine/demuxer/matroska-demuxer'

const secrets = JSON.parse(readFileSync('../config/jwt-secrets.json', 'utf-8')) as {
  access: string
}
const token = jwt.sign({ userId: 1, role: 'root', username: 'root' }, secrets.access, {
  expiresIn: '10m',
})

const movieId = process.argv[2] ?? '37'
const url = `http://127.0.0.1:3333/api/openlist/stream?movieId=${movieId}&token=${token}`
console.log(`GET /api/openlist/stream?movieId=${movieId}`)

const res = await fetch(url, { headers: { Range: `bytes=0-${4 * 1024 * 1024 - 1}` } })
console.log(`HTTP ${res.status} ${res.statusText}`)
console.log(
  'headers:',
  Object.fromEntries([...res.headers.entries()].filter(([k]) => /content|accept|range/i.test(k)))
)
if (!res.ok && res.status !== 206) {
  console.log('body:', (await res.text()).slice(0, 500))
  process.exit(1)
}
const reader = res.body!.getReader()
let tracks: DemuxedTrack[] | null = null
const demuxer = new MatroskaDemuxer({
  onTracks: (t) => {
    tracks = t
    console.log(`onTracks: ${t.length} 轨`)
    for (const tr of t) {
      console.log(
        `  #${tr.trackNumber} type=${tr.trackType} codec=${tr.codecId} lang=${tr.language ?? '-'} name=${tr.name ?? '-'} comp=${tr.contentCompAlgo ?? 0}`
      )
    }
  },
})
const t0 = Date.now()
for (;;) {
  const { done, value } = await reader.read()
  if (done) {
    console.log(`流结束（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    break
  }
  demuxer.append(value)
  if (tracks) {
    await reader.cancel().catch(() => undefined)
    console.log(`Tracks 已收齐，取消读取（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    break
  }
}
if (!tracks) console.log('=> 未解析到 Tracks')
process.exit(0)
