// 决定性实验：webdav-client getProperties 对 AList 的不同 URL 编码形态
const { Connection, BasicAuthenticator } = require('./node_modules/webdav-client');
const { promisify } = require('util');

const serverUrl = 'http://openlist.zero251.xyz/dav';
const username = 'Zero';
const password = 'Zero365602';

const RAW = '/139Cloud/share/[ANi] BanG Dream！YUME∞MITA - 05 [1080P][Baha][WEB-DL][AAC AVC][CHT].mp4';

// 形态1：normalizePath 输出（每段 encodeURIComponent）
const ENC_SEG = RAW.split('/').map(s => s ? encodeURIComponent(s) : s).join('/');
// 形态2：整体 encodeURI（空格→%20，非ASCII→%XX，[]保留）
const ENC_URI = encodeURI(RAW).replace(/\[/g, '%5B').replace(/\]/g, '%5D');
// 形态3：原始未编码
const RAW_PATH = RAW;

function makeConn() {
  return new Connection({
    url: serverUrl,
    username, password,
    authenticator: new BasicAuthenticator(),
  });
}

async function tryGetProps(label, path) {
  const conn = makeConn();
  const getProperties = promisify(conn.getProperties.bind(conn));
  try {
    const props = await getProperties(path);
    const len = props['DAV:getcontentlength'];
    console.log(`[${label}] OK  content-length=${Array.isArray(len?.content) ? '?' : len?.content}`);
  } catch (err) {
    console.log(`[${label}] FAIL  ${err.message}`);
  }
}

async function tryReaddir(label, path) {
  const conn = makeConn();
  const readdir = promisify(conn.readdir.bind(conn));
  try {
    const entries = await readdir(path, { properties: false, extraProperties: [] });
    console.log(`[${label}] OK  entries=${entries.length}`);
  } catch (err) {
    console.log(`[${label}] FAIL  ${err.message}`);
  }
}

(async () => {
  console.log('== getProperties（resolve/proxy 用，depth 0）==');
  await tryGetProps('1.enc-seg ', ENC_SEG);
  await tryGetProps('2.enc-uri ', ENC_URI);
  await tryGetProps('3.raw     ', RAW_PATH);

  console.log('== readdir（browse 用，depth 1，列目录）==');
  await tryReaddir('4.dir-enc ', '/139Cloud/share');

  // 对照：纯 ASCII 文件 getProperties
  await tryGetProps('5.ascii   ', '/139Cloud/share/Board.zip'.split('/').map(s => s ? encodeURIComponent(s) : s).join('/'));
})();
