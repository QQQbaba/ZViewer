const initSqlJs = require('./node_modules/sql.js');
const fs = require('fs');
initSqlJs().then((SQL) => {
  const db = new SQL.Database(fs.readFileSync('config/dev.sqlite'));
  const r = db.exec('SELECT id,title,url,source,serverUrl,path,directLink FROM movie ORDER BY id DESC LIMIT 5');
  if (r.length) {
    console.log('cols:', r[0].columns.join(' | '));
    r[0].values.forEach(v => console.log(v.join(' | ')));
  }
});
