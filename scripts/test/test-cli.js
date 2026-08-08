/**
 * generate-cert.js CLI 集成测试（本地 mock ACME + 自签回归）。
 *
 * 用法：node scripts/test/test-cli.js
 * 注意：会临时写入 config/ssl（测试后恢复原文件）。
 */

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const forge = require('node-forge');

const ROOT = path.resolve(__dirname, '..', '..');
const SSL_DIR = path.join(ROOT, 'config', 'ssl');
const CERT_FILE = path.join(SSL_DIR, 'cert.pem');
const KEY_FILE = path.join(SSL_DIR, 'key.pem');
const GEN = path.join(ROOT, 'scripts', 'generate-cert.js');
const MOCK_SERVER = path.join(__dirname, 'mock-acme-server.js');

const MOCK_PORT = 14001;
const CHALLENGE_PORT = 18889;

function runCli(args, env) {
  const res = spawnSync(process.execPath, [GEN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function waitForServer(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        if (Date.now() > deadline) reject(new Error('mock 服务器启动超时'));
        else setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

function readLeafInfo() {
  const pem = fs.readFileSync(CERT_FILE, 'utf8');
  const leaf = forge.pki.certificateFromPem(pem);
  return {
    cn: leaf.subject.getField('CN').value,
    issuer: leaf.issuer.getField('CN').value,
    sans: (leaf.getExtension('subjectAltName') || { altNames: [] }).altNames.map((a) => a.ip || a.value),
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  [通过] ${msg}`);
}

async function main() {
  // 备份现有证书
  const hadCert = fs.existsSync(CERT_FILE);
  const backup = hadCert
    ? { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }
    : null;

  const mockProc = spawn(process.execPath, [MOCK_SERVER, String(MOCK_PORT), String(CHALLENGE_PORT)], {
    stdio: 'ignore',
  });
  await waitForServer(MOCK_PORT);

  try {
    // ---- 1. localhost 自签 ----
    console.log('\n===== CLI: localhost 自签 =====');
    let r = runCli(['localhost', '--force']);
    assert(r.code === 0, `退出码 0 (实际 ${r.code})`);
    let info = readLeafInfo();
    assert(info.cn === 'localhost', `CN=localhost (实际 ${info.cn})`);
    assert(info.issuer === 'localhost', `自签 (issuer=localhost)`);
    assert(info.sans.includes('127.0.0.1'), 'SAN 含 127.0.0.1');
    console.log('  输出片段:', r.stdout.split('\n').slice(0, 2).join(' | '));

    // ---- 2. 内网 IP 自签 ----（公网 IP 现走 Let's Encrypt，用内网 IP 测试自签）
    console.log('\n===== CLI: 内网 IP 自签 =====');
    r = runCli(['192.168.1.1', '--force']);
    assert(r.code === 0, `退出码 0 (实际 ${r.code})`);
    info = readLeafInfo();
    assert(info.cn === '192.168.1.1', `CN=192.168.1.1`);
    assert(info.sans.includes('192.168.1.1'), 'SAN 含 192.168.1.1');

    // ---- 3. 域名 --selfsigned 强制自签 ----
    console.log('\n===== CLI: 域名 --selfsigned 自签 =====');
    r = runCli(['test.example.com', '--selfsigned', '--force']);
    assert(r.code === 0, `退出码 0 (实际 ${r.code})`);
    info = readLeafInfo();
    const leaf3 = forge.pki.certificateFromPem(fs.readFileSync(CERT_FILE, 'utf8'));
    assert(leaf3.issuer.hash === leaf3.subject.hash, '自签（issuer.hash === subject.hash）');

    // ---- 4. 域名 → ACME 可信 CA（mock）----
    console.log('\n===== CLI: 域名 → ACME 可信 CA（mock） =====');
    r = runCli(
      ['test.example.com', '--directory', `http://127.0.0.1:${MOCK_PORT}/directory`, '--force'],
      { ZVIEWER_CERT_CHALLENGE_PORT: String(CHALLENGE_PORT) },
    );
    assert(r.code === 0, `退出码 0 (实际 ${r.code})`);
    info = readLeafInfo();
    assert(info.cn === 'test.example.com', `CN=test.example.com`);
    assert(info.issuer === 'Mock Test CA', `CA 签发 (issuer=Mock Test CA, 实际 ${info.issuer})`);
    assert(!info.sans.includes('localhost'), 'CA 证书不含 localhost SAN（真实 CA 只签域名）');
    console.log('  输出片段:', r.stdout.split('\n').filter((l) => l.includes('可信')).join(' | '));

    // ---- 5. CA 证书已存在 → 跳过 ----
    console.log('\n===== CLI: CA 证书已存在 → 跳过 =====');
    r = runCli(['test.example.com', '--directory', `http://127.0.0.1:${MOCK_PORT}/directory`]);
    assert(r.code === 0, `退出码 0`);
    assert(r.stdout.includes('跳过'), '提示跳过申请');

    // ---- 6. 非法参数 ----
    console.log('\n===== CLI: 非法参数 =====');
    r = runCli(['-bad']);
    assert(r.code === 1, `非法参数退出码 1 (实际 ${r.code})`);

    console.log('\nCLI 集成测试全部通过 ✔');
  } finally {
    mockProc.kill();
    // 恢复原证书
    if (backup) {
      fs.writeFileSync(CERT_FILE, backup.cert);
      fs.writeFileSync(KEY_FILE, backup.key);
      console.log('\n[清理] 已恢复原 config/ssl 证书');
    } else {
      fs.rmSync(CERT_FILE, { force: true });
      fs.rmSync(KEY_FILE, { force: true });
      fs.rmSync(path.join(SSL_DIR, 'acme-account.key'), { force: true });
      console.log('\n[清理] 已删除测试证书');
    }
    fs.rmSync(path.join(SSL_DIR, 'acme-account.key'), { force: true });
  }
}

main().catch((e) => {
  console.error('\n[失败]', e.message);
  process.exit(1);
});
