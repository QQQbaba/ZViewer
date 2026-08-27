import Database from 'better-sqlite3'
const db = new Database('../config/dev.sqlite')
console.log('room cols:', db.prepare('PRAGMA table_info(room)').all().map((c: { name: string }) => c.name).join(', '))
console.log('rooms:', JSON.stringify(db.prepare('SELECT * FROM room LIMIT 3').all()))
const movies = db.prepare('SELECT id, roomId, url, title, source, path, format, audioCodec, directLink FROM movie ORDER BY id DESC LIMIT 3').all()
console.log('movies:', JSON.stringify(movies, null, 1))
console.log('users:', JSON.stringify(db.prepare('SELECT id, username, role FROM user LIMIT 10').all()))
