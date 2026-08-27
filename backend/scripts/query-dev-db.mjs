import Database from 'better-sqlite3'
const db = new Database('f:/Code/ZViewer/ZViewer/backend/test-dev.sqlite', { readonly: true })
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log('tables:', tables.map((t) => t.name).join(', '))
for (const name of ['movie', 'server_folder', 'serverFolder', 'room', 'system_settings']) {
  try {
    const rows = db.prepare(`SELECT * FROM ${name} LIMIT 20`).all()
    console.log(`\n== ${name} (${rows.length}) ==`)
    for (const r of rows) console.log(JSON.stringify(r))
  } catch (e) {
    console.log(`\n== ${name}: ${e.message}`)
  }
}
