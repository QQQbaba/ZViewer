/**
 * SSL 证书生成脚本（自签 / 可信 CA 双模式）。
 *
 * 使用 node-forge 生成自签 X.509 证书，或通过内置 ACME 客户端
 * （acme-client.js）向 Let's Encrypt 申请可信 CA 证书。
 * 仅依赖 JavaScript，无需 openssl 或任何系统工具。
 *
 * 输出：
 *   config/ssl/cert.pem  - 证书文件（CA 模式为完整证书链 fullchain）
 *   config/ssl/key.pem   - 私钥文件
 *   config/ssl/acme-account.key - ACME 账号密钥（CA 模式，自动生成并复用）
 *
 * 用法：node scripts/generate-cert.js [host] [选项]
 *   host       域名、公网 IP 或 localhost。
 *              域名（DNS）和公网 IP 默认走 Let's Encrypt 申请可信 CA 证书；
 *              localhost / 内网 IP 使用自签证书。
 *   --force    强制重新生成，不检查证书是否已存在
 *   --selfsigned  强制使用自签证书（即使指定的是域名或公网 IP）
 *   --staging  使用 Let's Encrypt 测试环境（staging，无速率限制）
 *   --email <邮箱>  ACME 账号邮箱（可选）
 *   --directory <url> 自定义 ACME 目录 URL（高级选项）
 *
 * 示例：
 *   node scripts/generate-cert.js                     # localhost 自签
 *   node scripts/generate-cert.js example.com         # 域名 → Let's Encrypt 可信证书
 *   node scripts/generate-cert.js 1.2.3.4             # 公网 IP → Let's Encrypt 可信证书
 *   node scripts/generate-cert.js 192.168.1.1         # 内网 IP → 自签证书
 *   node scripts/generate-cert.js example.com --selfsigned  # 域名强制自签
 */

const forge = require('node-forge');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const acme = require('./acme-client');

// pkg 打包后 __dirname 为虚拟路径，改用当前工作目录（exe 所在目录）
const SSL_DIR = process.pkg
  ? path.resolve(process.cwd(), 'config', 'ssl')
  : path.resolve(__dirname, '..', 'config', 'ssl');
const CERT_FILE = path.join(SSL_DIR, 'cert.pem');
const KEY_FILE = path.join(SSL_DIR, 'key.pem');
const ACCOUNT_KEY_FILE = path.join(SSL_DIR, 'acme-account.key');

const DIRECTORY_LETSENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
const DIRECTORY_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

const args = process.argv.slice(2);

// ==================== 参数解析 ====================
function printUsage() {
  console.log('用法: zviewer-cert [host] [选项]');
  console.log('  host       域名、公网 IP 或 localhost');
  console.log('             域名和公网 IP 默认通过 Let\'s Encrypt 申请可信 CA 证书；');
  console.log('             localhost / 内网 IP 使用自签证书');
  console.log('  --force    强制重新生成，不检查证书是否已存在');
  console.log('  --selfsigned  强制使用自签证书（即使指定的是域名或公网 IP）');
  console.log('  --staging  使用 Let\'s Encrypt 测试环境');
  console.log('  --email <邮箱>  ACME 账号邮箱（可选）');
  console.log('  --directory <url> 自定义 ACME 目录 URL（高级选项）');
  console.log('示例:');
  console.log('  zviewer-cert                 # localhost 自签证书');
  console.log('  zviewer-cert example.com     # 域名 → Let\'s Encrypt 可信证书');
  console.log('  zviewer-cert 1.2.3.4         # 公网 IP → Let\'s Encrypt 可信证书');
  console.log('  zviewer-cert 192.168.1.1     # 内网 IP → 自签证书');
  console.log('  zviewer-cert example.com --selfsigned  # 域名强制自签');
}

if (args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

const force = args.includes('--force') || args.includes('-f');
const selfsigned = args.includes('--selfsigned');
const staging = args.includes('--staging');

// 带值参数：--email <v> / --directory <v>，也支持 --key=value 形式
function readValueArg(name) {
  const idx = args.indexOf(name);
  if (idx >= 0) {
    if (args[idx + 1] !== undefined && !args[idx + 1].startsWith('-')) return args[idx + 1];
    console.error(`  [错误] 参数 ${name} 缺少值`);
    process.exit(1);
  }
  for (const a of args) {
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return null;
}
const email = readValueArg('--email');
const directoryOverride = readValueArg('--directory');

// 提取 host：第一个非 -- 开头的参数
const knownFlags = new Set(['--force', '-f', '--help', '-h', '--selfsigned', '--staging', '--email', '--directory']);
let host = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (knownFlags.has(a)) {
    if (a === '--email' || a === '--directory') i++; // 跳过其值
    continue;
  }
  if (a.startsWith('--') && a.includes('=')) continue; // --key=value 形式
  if (a.startsWith('-')) {
    console.error(`  [错误] 无法识别的参数: ${a}`);
    console.error('');
    printUsage();
    process.exit(1);
  }
  if (host === null) {
    host = a;
  } else {
    console.error(`  [错误] 参数过多: ${a}`);
    process.exit(1);
  }
}

// 判断 host 是 IP 还是域名（net.isIP 严格校验 IPv4/IPv6）
let hostKind = null; // 'ip' | 'dns'
if (host && host.toLowerCase() !== 'localhost') {
  const ipv = net.isIP(host);
  if (ipv === 4 || ipv === 6) {
    hostKind = 'ip';
  } else if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    console.error(`  [错误] 非法 IPv4 地址: ${host}`);
    process.exit(1);
  } else if (host.includes(':')) {
    console.error(`  [错误] 非法 IPv6 地址: ${host}`);
    process.exit(1);
  } else if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host)) {
    hostKind = 'dns';
  } else {
    console.error(`  [错误] 无法识别的域名或 IP 地址: ${host}`);
    console.error('        请输入合法域名（如 example.com）或 IP 地址（如 1.2.3.4）');
    process.exit(1);
  }
}

/**
 * 判断 IP 地址是否为公网地址（非私有/环回/链路本地）。
 * Let's Encrypt 自 2025 年起支持为公网 IP 签发可信证书。
 */
function isPublicIP(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map(Number);
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
    // 169.254.0.0/16, 0.0.0.0/8, 100.64.0.0/10 (CGNAT)
    if (parts[0] === 10) return false;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    if (parts[0] === 192 && parts[1] === 168) return false;
    if (parts[0] === 127) return false;
    if (parts[0] === 169 && parts[1] === 254) return false;
    if (parts[0] === 0) return false;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false;
    return true;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    // ::1/128 (loopback), fc00::/7 (unique local), fe80::/10 (link-local)
    if (lower === '::1') return false;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return false;
    return true;
  }
  return false;
}

// 该次签发是否走 ACME 可信 CA
// - 域名（含点）→ Let's Encrypt
// - 公网 IP → Let's Encrypt（2025 年起支持）
// - localhost / 内网 IP / 单标签主机名 → 自签
const useAcme =
  host !== null && !selfsigned &&
  ((hostKind === 'dns' && host.includes('.')) ||
   (hostKind === 'ip' && isPublicIP(host)));

// ==================== 证书读取工具 ====================
function readCertSanHosts(certFile) {
  try {
    const pem = fs.readFileSync(certFile, 'utf-8');
    const cert = forge.pki.certificateFromPem(pem);
    const ext = cert.getExtension('subjectAltName');
    if (!ext || !ext.altNames) return [];
    return ext.altNames.map((a) => (a.ip !== undefined ? a.ip : a.value));
  } catch {
    return [];
  }
}

// 判断已有证书是否为自签（签发者主体哈希 == 证书主体哈希）
function isSelfSignedCert(certFile) {
  try {
    const pem = fs.readFileSync(certFile, 'utf-8');
    const cert = forge.pki.certificateFromPem(pem);
    return cert.issuer.hash === cert.subject.hash;
  } catch {
    return false;
  }
}

// 证书是否未过期
function isCertNotExpired(certFile) {
  try {
    const pem = fs.readFileSync(certFile, 'utf-8');
    const cert = forge.pki.certificateFromPem(pem);
    return cert.validity.notAfter > new Date();
  } catch {
    return false;
  }
}

// ==================== 检查是否已有证书 ====================
if (!force && fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
  const existingHosts = readCertSanHosts(CERT_FILE).map((h) => h.toLowerCase());
  const hostExists = host
    ? existingHosts.includes(host.toLowerCase())
    : existingHosts.includes('localhost');
  const notExpired = isCertNotExpired(CERT_FILE);
  const selfSigned = isSelfSignedCert(CERT_FILE);

  if (useAcme) {
    // CA 模式：要求已有证书是 CA 签发的、含该主机且未过期
    if (hostExists && notExpired && !selfSigned) {
      console.log(`  可信证书已存在（已包含 ${host}），跳过申请（如需重新申请请加 --force）`);
      process.exit(0);
    }
    if (hostExists && notExpired && selfSigned) {
      console.log(`  现有证书为自签证书，将重新申请 Let's Encrypt 可信证书...`);
    } else if (hostExists && !notExpired) {
      console.log('  现有证书已过期，自动重新申请...');
    } else if (hostExists) {
      console.log(`  现有证书未包含 ${host}，自动重新申请...`);
    }
  } else {
    // 自签模式
    const displayHost = host || 'localhost';
    if (hostExists && notExpired) {
      console.log(`  SSL 证书已存在（已包含 ${displayHost}），跳过生成（如需重新生成请加 --force）`);
      process.exit(0);
    }
    if (hostExists && !notExpired) {
      console.log('  现有证书已过期，自动重新生成...');
    }
  }
}

// 确保目录存在
fs.mkdirSync(SSL_DIR, { recursive: true });

// ==================== 自签证书 ====================
function generateSelfSignedCert() {
  console.log('  生成 RSA 2048 密钥对...');

  // 1. 生成 RSA 密钥对
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // 2. 创建证书
  const cert = forge.pki.createCertificate();

  // 3. 设置证书属性
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));

  // 有效期：从前一天开始，10 年后结束
  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - 1);
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  // 主体 CN：指定了 host 则用 host，否则 localhost
  const cn = host && hostKind ? host : 'localhost';

  // 颁发者 / 主体（自签证书二者一致）
  cert.setSubject([
    { name: 'countryName', value: 'CN' },
    { name: 'organizationName', value: 'ZViewer' },
    { name: 'commonName', value: cn },
  ]);
  cert.setIssuer([
    { name: 'countryName', value: 'CN' },
    { name: 'organizationName', value: 'ZViewer' },
    { name: 'commonName', value: cn },
  ]);

  // 扩展: SubjectAltName（始终包含本机地址，便于本机调试；host 与之重复时不重复添加）
  const baseHosts = ['localhost', '127.0.0.1', '::1'];
  const altNames = [];
  if (host && hostKind && !baseHosts.includes(host.toLowerCase())) {
    if (hostKind === 'ip') {
      altNames.push({ type: 7, ip: host });         // 指定 IP
    } else {
      altNames.push({ type: 2, value: host });      // 指定域名
    }
  }
  altNames.push({ type: 2, value: 'localhost' });   // DNS
  altNames.push({ type: 7, ip: '127.0.0.1' });      // IPv4
  altNames.push({ type: 7, ip: '::1' });            // IPv6

  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames,
    },
  ]);

  // 4. 自签
  console.log('  签名证书...');
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // 5. 导出 PEM
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // 6. 写入文件（私钥仅当前用户可读写）
  fs.writeFileSync(CERT_FILE, certPem, 'utf-8');
  fs.writeFileSync(KEY_FILE, keyPem, { mode: 0o600, encoding: 'utf-8' });

  const sanText = altNames
    .map((a) => (a.value !== undefined ? `DNS:${a.value}` : `IP:${a.ip}`))
    .join(', ');

  console.log(`  证书主体: CN=${cn}`);
  console.log(`  证书 SAN : ${sanText}`);
  console.log(`  证书已生成: ${CERT_FILE}`);
  console.log(`  私钥已生成: ${KEY_FILE}`);
  return true;
}

// ==================== ACME 可信 CA 证书 ====================
async function requestCaCert() {
  const directoryUrl =
    directoryOverride || (staging ? DIRECTORY_STAGING : DIRECTORY_LETSENCRYPT);
  const envName = staging ? 'Let\'s Encrypt 测试环境(staging)' : 'Let\'s Encrypt';
  const idType = hostKind === 'ip' ? 'ip' : 'dns';
  const idLabel = idType === 'ip' ? 'IP 地址' : '域名';

  console.log(`  通过 ${envName} 申请可信 CA 证书（${idLabel}: ${host}）...`);
  console.log('  提示: 需满足以下条件才能成功：');
  console.log(`        1) ${idLabel}已指向本机且公网可达`);
  console.log('        2) 80 端口空闲且防火墙/安全组已放行（HTTP-01 验证）');

  const { fullchainPem, keyPem } = await acme.requestCertificate({
    domain: host,
    directoryUrl,
    accountKeyFile: ACCOUNT_KEY_FILE,
    email: email || undefined,
    identifierType: idType,
    challengePort: Number(process.env.ZVIEWER_CERT_CHALLENGE_PORT) || 80,
    log: (msg) => console.log(msg),
  });

  fs.writeFileSync(CERT_FILE, fullchainPem, 'utf-8');
  fs.writeFileSync(KEY_FILE, keyPem, { mode: 0o600, encoding: 'utf-8' });

  console.log(`  可信证书已生成: ${CERT_FILE}（完整证书链）`);
  console.log(`  私钥已生成: ${KEY_FILE}`);
  console.log('  证书有效期约 90 天，到期前请重新运行本命令续期');
  return true;
}

// ==================== 主流程 ====================
async function main() {
  if (useAcme) {
    const idLabel = hostKind === 'ip' ? 'IP 地址' : '域名';
    console.log(`  生成 SSL 证书（类型: ${idLabel} ${host}，Let's Encrypt 可信 CA）...`);
    await requestCaCert();
  } else if (host && hostKind) {
    const idLabel = hostKind === 'ip' ? '内网 IP' : '域名';
    console.log(`  生成 SSL 证书（类型: ${idLabel} ${host}，自签）...`);
    generateSelfSignedCert();
  } else {
    console.log('  生成 SSL 证书（类型: localhost，自签）...');
    generateSelfSignedCert();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('  [错误] 证书生成失败:', err.message);
    console.error('');
    if (useAcme) {
      const idLabel = hostKind === 'ip' ? 'IP 地址' : '域名';
      console.error('  常见原因：');
      console.error(`    1. ${idLabel}未指向本机或公网不可达`);
      console.error('    2. 80 端口被占用或防火墙/安全组未放行');
      console.error('    3. 申请过于频繁（Let\'s Encrypt 有速率限制，可用 --staging 测试）');
      console.error('  如需继续使用自签证书，请加 --selfsigned 参数');
    } else {
      console.error('  请确保安装了 Node.js 18 或更高版本');
    }
    process.exit(1);
  });
