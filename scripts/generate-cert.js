/**
 * 自签 SSL 证书生成脚本。
 *
 * 使用 node-forge 生成自签 X.509 证书，
 * 仅依赖 JavaScript，无需 openssl 或任何系统工具。
 *
 * 输出：
 *   config/ssl/cert.pem  - 证书文件
 *   config/ssl/key.pem   - 私钥文件
 *
 * 用法：node scripts/generate-cert.js [--force]
 *   --force  强制重新生成，不检查证书是否已存在
 */

const forge = require('node-forge');
const fs = require('node:fs');
const path = require('node:path');

const SSL_DIR = path.resolve(__dirname, '..', 'config', 'ssl');
const CERT_FILE = path.join(SSL_DIR, 'cert.pem');
const KEY_FILE = path.join(SSL_DIR, 'key.pem');

const force = process.argv.includes('--force');

// 检查是否已有证书
if (!force && fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
  console.log('  SSL 证书已存在，跳过生成（如需重新生成请加 --force）');
  process.exit(0);
}

// 确保目录存在
fs.mkdirSync(SSL_DIR, { recursive: true });

function generateSelfSignedCert() {
  console.log('  生成 RSA 2048 密钥对...');

  // 1. 生成 RSA 密钥对
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // 2. 创建证书
  const cert = forge.pki.createCertificate();

  // 3. 设置证书属性
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));

  // 有效期: 从前一天开始，10 年后结束
  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - 1);
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  // 颁发者 / 主体
  cert.setSubject([
    { name: 'countryName', value: 'CN' },
    { name: 'organizationName', value: 'ZViewer' },
    { name: 'commonName', value: 'localhost' },
  ]);
  cert.setIssuer([
    { name: 'countryName', value: 'CN' },
    { name: 'organizationName', value: 'ZViewer' },
    { name: 'commonName', value: 'localhost' },
  ]);

  // 扩展: SubjectAltName
  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },   // DNS
        { type: 7, ip: '127.0.0.1' },      // IP
      ],
    },
  ]);

  // 4. 自签
  console.log('  签名证书...');
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // 5. 导出 PEM
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // 6. 写入文件
  fs.writeFileSync(CERT_FILE, certPem, 'utf-8');
  fs.writeFileSync(KEY_FILE, keyPem, 'utf-8');

  console.log(`  证书已生成: ${CERT_FILE}`);
  console.log(`  私钥已生成: ${KEY_FILE}`);
  return true;
}

// ==================== 主流程 ====================

console.log('  生成 SSL 证书...');

try {
  generateSelfSignedCert();
  process.exit(0);
} catch (err) {
  console.error('  [错误] 证书生成失败:', err.message);
  console.error('');
  console.error('  请确保安装了 Node.js 18 或更高版本。');
  process.exit(1);
}