import jwt from 'jsonwebtoken'
import { readFileSync } from 'node:fs'

const secrets = JSON.parse(readFileSync('../config/jwt-secrets.json', 'utf-8')) as { access: string }
const token = jwt.sign({ userId: 1, role: 'root', username: 'root' }, secrets.access, { expiresIn: '10m' })
const base = `http://127.0.0.1:3333/api/openlist/stream?movieId=37&token=${token}`

for (const range of ['bytes=0-1048575', 'bytes=1000000-1001023', 'bytes=100000000-116777215']) {
  const t0 = performance.now()
  const res = await fetch(base, { headers: { Range: range } })
  const body = await res.arrayBuffer()
  const dt = performance.now() - t0
  const text = res.status !== 206 && res.status !== 200 ? new TextDecoder().decode(body).slice(0, 300) : `(${body.byteLength} bytes)`
  console.log(`Range ${range}: HTTP ${res.status} ${dt.toFixed(0)}ms ${text}`)
}
