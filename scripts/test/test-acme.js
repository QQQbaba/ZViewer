/**
 * ACME 客户端端到端测试（本地 mock 服务器）。
 *
 * 用法：node scripts/test/test-acme.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const forge = require('node-forge');
const acme = require('../acme-client');
const { startMockAcmeServer } = require('./mock-acme-server');

const MOCK_PORT = 14000;
const CHALLENGE_PORT = 18888;
const ACCOUNT_KEY = path.join(__dirname, '.test-account.key');

async function main() {
  const { base, close } = await startMockAcmeServer(MOCK_PORT, CHALLENGE_PORT);
  console.log('mock ACME 服务器就绪');

  try {
    // 第一次申请（创建账号）
    console.log('\n===== 第一次申请（新建账号） =====');
    const r1 = await acme.requestCertificate({
      domain: 'test.example.com',
      directoryUrl: `${base}/directory`,
      accountKeyFile: ACCOUNT_KEY,
      email: 'admin@example.com',
      challengePort: CHALLENGE_PORT,
      log: (m) => console.log('  ' + m),
    });

    const certCount = (r1.fullchainPem.match(/BEGIN CERTIFICATE/g) || []).length;
    console.log(`\n[通过] fullchain 包含证书段数: ${certCount}（应为 2：叶证书 + CA）`);
    if (certCount !== 2) throw new Error('fullchain 应包含 2 段证书');

    const leaf = forge.pki.certificateFromPem(r1.fullchainPem);
    const cn = leaf.subject.getField('CN').value;
    const issuer = leaf.issuer.getField('CN').value;
    const san = leaf.getExtension('subjectAltName').altNames.map((a) => a.value);
    console.log(`[信息] 叶证书 CN=${cn}, 签发者=${issuer}, SAN=${san.join(',')}`);
    if (cn !== 'test.example.com') throw new Error('CN 应为 test.example.com');
    if (issuer !== 'Mock Test CA') throw new Error('签发者应为 Mock Test CA（非自签）');
    if (!san.includes('test.example.com')) throw new Error('SAN 应包含域名');
    if (!r1.keyPem.includes('BEGIN PRIVATE KEY')) throw new Error('keyPem 无效');
    console.log('[通过] 证书由 mock CA 签发（非自签），SAN 正确');

    // 第二次申请（复用账号密钥）
    console.log('\n===== 第二次申请（复用账号） =====');
    const r2 = await acme.requestCertificate({
      domain: 'test.example.com',
      directoryUrl: `${base}/directory`,
      accountKeyFile: ACCOUNT_KEY,
      challengePort: CHALLENGE_PORT,
      log: (m) => console.log('  ' + m),
    });
    console.log('[通过] 账号密钥复用成功');

    console.log('\n全部通过 ✔');
  } finally {
    await close();
    fs.rmSync(ACCOUNT_KEY, { force: true });
  }
}

main().catch((e) => {
  console.error('\n[失败]', e.message);
  process.exit(1);
});
