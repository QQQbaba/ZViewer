/**
 * ACME v2 (RFC 8555) HTTP-01 客户端。
 *
 * 纯 Node.js 实现，仅依赖 node 内置模块与 node-forge，无外部工具依赖，
 * 可被 pkg 打包进 zviewer-cert，跨平台（Windows / Linux）使用。
 *
 * 流程：
 *   directory → newNonce → newAccount → newOrder → http-01 challenge
 *   → 本地 HTTP 服务器响应验证 → finalize(CSR) → 下载证书链
 *
 * 用法（由 generate-cert.js 调用）：
 *   const acme = require('./acme-client');
 *   const { fullchainPem, keyPem } = await acme.requestCertificate({
 *     domain: 'example.com',            // 域名或公网 IP
 *     directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory',
 *     accountKeyFile: '/path/to/acme-account.key',
 *     email: 'admin@example.com',      // 可选
 *     challengePort: 80,               // HTTP-01 验证端口（必须公网可访问）
 *     identifierType: 'dns',           // 'dns' 或 'ip'，默认自动检测
 *     log: (msg) => console.log(msg),  // 可选进度回调
 *   });
 */

'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const forge = require('node-forge');

const USER_AGENT = 'zviewer-cert/1.0';
const REQUEST_TIMEOUT_MS = 30000;
const ORDER_POLL_INTERVAL_MS = 3000;
const ORDER_TIMEOUT_MS = 120000; // 验证最长等待（CA 需访问本机 80 端口）

// ==================== 基础工具 ====================

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
}

function httpsRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.request(
      url,
      {
        method,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        agent: false,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error(`请求超时: ${url}`)),
    );
    if (body) req.write(body);
    req.end();
  });
}

async function apiRequest(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await httpsRequest(url, {
    method,
    body,
    headers: {
      'Content-Type': 'application/jose+json',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers,
    },
  });
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  if (res.status >= 400) {
    const detail = json && json.detail ? ` (${json.detail})` : '';
    throw new Error(`ACME 请求失败: ${res.status} ${url}${detail}`);
  }
  return { json, headers: res.headers, body: res.body };
}

// 账号公钥的 RFC 7638 JWK 指纹（thumbprint），用于 keyAuthorization
function jwkThumbprint(publicJwk) {
  const canonical = JSON.stringify({ e: publicJwk.e, kty: 'RSA', n: publicJwk.n });
  return crypto.createHash('sha256').update(canonical).digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ==================== JWS 签名 ====================

/**
 * 生成 ACME JWS。
 * 注册账号前使用 jwk 头；注册后使用 kid 头。
 */
function signJws({ accountKeyPem, url, nonce, payload, kid }) {
  const privateKey = crypto.createPrivateKey(accountKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });

  const header = { alg: 'RS256', nonce, url };
  if (kid) {
    header.kid = kid;
  } else {
    header.jwk = { kty: 'RSA', n: jwk.n, e: jwk.e };
  }

  const protectedB64 = b64urlJson(header);
  // RFC 8555 §6.3：POST-as-GET 的 payload 必须是 zero-length octet string（空字符串）
  // 而非 JSON 对象 {}——否则 Boulder 会将 authz 的 POST-as-GET 解析为停用请求而报错。
  const payloadB64 =
    payload === undefined || payload === ''
      ? ''
      : b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${protectedB64}.${payloadB64}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey);

  return { protected: protectedB64, payload: payloadB64, signature: b64url(signature) };
}

// ==================== 账号密钥管理 ====================

function loadOrCreateAccountKey(accountKeyFile) {
  if (fs.existsSync(accountKeyFile)) {
    return fs.readFileSync(accountKeyFile, 'utf8');
  }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  // 账号私钥仅当前用户可读写
  fs.writeFileSync(accountKeyFile, pem, { mode: 0o600, encoding: 'utf8' });
  return pem;
}

// ==================== CSR 生成（node-forge） ====================

/**
 * 生成 CSR（PKCS#10）。
 * @param {string} identifier   域名或 IP 地址
 * @param {string} privateKeyPem  私钥 PEM
 * @param {'dns'|'ip'} [identifierType='dns']  标识符类型
 */
function generateCsrPem(identifier, privateKeyPem, identifierType = 'dns') {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  csr.setSubject([{ name: 'commonName', value: identifier }]);
  // SAN: DNS → type 2, IP → type 7
  const sanEntry = identifierType === 'ip'
    ? { type: 7, ip: identifier }
    : { type: 2, value: identifier };
  csr.setAttributes([
    {
      name: 'extensionRequest',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [sanEntry],
        },
      ],
    },
  ]);
  csr.sign(privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

// ==================== HTTP-01 验证服务器 ====================

/**
 * 启动本地 HTTP 服务器处理 HTTP-01 验证请求。
 * 注意：challengePort 默认 80，需确保端口空闲且公网可访问。
 */
function startChallengeServer(challengePort) {
  const challenges = new Map(); // token -> keyAuthorization

  const server = http.createServer((req, res) => {
    const match = (req.url || '').match(/^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/);
    const token = match ? match[1] : null;
    if (token && challenges.has(token)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(challenges.get(token));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(challengePort, '0.0.0.0', () => resolve(server));
  }).then((srv) => ({
    server: srv,
    set: (token, keyAuthorization) => challenges.set(token, keyAuthorization),
    close: () =>
      new Promise((r) => srv.close(() => r())),
  }));
}

// ==================== ACME 主流程 ====================

/**
 * 通过 ACME HTTP-01 申请域名或 IP 证书。
 *
 * @param {object} opts
 * @param {string} opts.domain            需要申请证书的域名或 IP 地址
 * @param {string} opts.directoryUrl      ACME 目录 URL（正式/测试环境）
 * @param {string} opts.accountKeyFile    账号密钥文件路径（不存在则自动生成）
 * @param {string} [opts.email]           账号邮箱（可选）
 * @param {number} [opts.challengePort]   HTTP-01 验证端口，默认 80
 * @param {'dns'|'ip'} [opts.identifierType]  标识符类型，默认自动检测
 * @param {(msg: string) => void} [opts.log] 进度日志回调
 * @returns {Promise<{fullchainPem: string, keyPem: string}>}
 */
async function requestCertificate({
  domain,
  directoryUrl,
  accountKeyFile,
  email,
  challengePort = 80,
  identifierType,
  log = () => {},
}) {
  const accountKeyPem = loadOrCreateAccountKey(accountKeyFile);

  // 1. 获取目录
  log('  获取 ACME 目录...');
  const { json: directory } = await apiRequest(directoryUrl);

  // 2. 获取 nonce
  const nonceRes = await apiRequest(directory.newNonce, { method: 'HEAD' });
  let nonce = nonceRes.headers['replay-nonce'];
  if (!nonce) {
    throw new Error('ACME 服务器未返回 nonce');
  }

  // 3. 注册账号
  log('  注册 ACME 账号...');
  const accountPayload = { termsOfServiceAgreed: true };
  if (email) accountPayload.contact = [`mailto:${email}`];
  const accountSigned = signJws({
    accountKeyPem,
    url: directory.newAccount,
    nonce,
    payload: accountPayload,
  });
  let accRes = await apiRequest(directory.newAccount, {
    method: 'POST',
    body: JSON.stringify(accountSigned),
  });
  nonce = accRes.headers['replay-nonce'];
  if (!nonce) {
    // 部分服务器可能不返回 nonce，重新获取
    const n2 = await apiRequest(directory.newNonce, { method: 'HEAD' });
    nonce = n2.headers['replay-nonce'];
  }
  const kid = accRes.headers.location;
  if (!kid) throw new Error('ACME 账号注册失败（无 location）');

  // 4. 创建订单
  // 自动检测标识符类型（IP 或 DNS），支持 Let's Encrypt IP 证书
  const acmeIdType = identifierType || (net.isIP(domain) ? 'ip' : 'dns');
  const idLabel = acmeIdType === 'ip' ? 'IP 地址' : '域名';
  log(`  为 ${domain}（${idLabel}）创建订单...`);
  const orderSigned = signJws({
    accountKeyPem,
    url: directory.newOrder,
    nonce,
    payload: {
      identifiers: [{ type: acmeIdType, value: domain }],
      // Let's Encrypt IP 证书（2026-01 GA）强制要求 shortlived profile
      // （ACME Profiles 扩展 draft-aaron-acme-profiles），否则订单被拒。
      // 有效期 160 小时（约 6.6 天），到期需重新签发。
      ...(acmeIdType === 'ip' ? { profile: 'shortlived' } : {}),
    },
    kid,
  });
  const orderRes = await apiRequest(directory.newOrder, {
    method: 'POST',
    body: JSON.stringify(orderSigned),
  });
  nonce = orderRes.headers['replay-nonce'];
  const order = orderRes.json;
  const orderUrl = orderRes.headers.location;
  if (!orderUrl) throw new Error('ACME 订单创建失败（无 location）');

  // 订单可能直接返回 finalize/certificate（如授权被 Let's Encrypt 复用）
  let finalizeUrl = order.finalize || null;
  let certificateUrl = order.certificate || null;

  // 5. 处理每个授权（HTTP-01）
  log('  启动 HTTP-01 验证服务器...');
  const challengeServer = await startChallengeServer(challengePort);
  const keyAuths = new Map(); // token -> keyAuthorization

  try {
    const publicKey = crypto.createPublicKey(crypto.createPrivateKey(accountKeyPem));
    const thumbprint = jwkThumbprint(publicKey.export({ format: 'jwk' }));

    for (const authzUrl of order.authorizations || []) {
      const authzSigned = signJws({
        accountKeyPem,
        url: authzUrl,
        nonce,
        payload: '',
        kid,
      });
      const authzRes = await apiRequest(authzUrl, {
        method: 'POST',
        body: JSON.stringify(authzSigned),
      });
      nonce = authzRes.headers['replay-nonce'];
      const authz = authzRes.json;

      const challenge = (authz.challenges || []).find((c) => c.type === 'http-01');
      if (!challenge) {
        throw new Error(`${idLabel} ${domain} 的授权不支持 http-01 验证`);
      }
      if (authz.status === 'valid') continue; // 已通过验证

      const keyAuthorization = `${challenge.token}.${thumbprint}`;
      challengeServer.set(challenge.token, keyAuthorization);
      log(`  响应验证: http://${domain}/.well-known/acme-challenge/${challenge.token}`);

      // 通知 CA 验证就绪
      const chalSigned = signJws({
        accountKeyPem,
        url: challenge.url,
        nonce,
        payload: '',
        kid,
      });
      const chalRes = await apiRequest(challenge.url, {
        method: 'POST',
        body: JSON.stringify(chalSigned),
      });
      nonce = chalRes.headers['replay-nonce'];
    }

    // 6. 轮询订单状态直到 ready/valid / invalid / 超时
    log(`  等待 CA 验证${idLabel}所有权...`);
    const deadline = Date.now() + ORDER_TIMEOUT_MS;
    let status = order.status;

    while (status === 'pending' || status === 'processing') {
      if (Date.now() > deadline) {
        throw new Error(
          `验证超时（120 秒）。请检查：${idLabel}是否指向本机且公网可达、防火墙/安全组是否放行 80 端口`,
        );
      }
      await new Promise((r) => setTimeout(r, ORDER_POLL_INTERVAL_MS));
      const pollSigned = signJws({
        accountKeyPem,
        url: orderUrl,
        nonce,
        payload: '',
        kid,
      });
      const pollRes = await apiRequest(orderUrl, {
        method: 'POST',
        body: JSON.stringify(pollSigned),
      });
      nonce = pollRes.headers['replay-nonce'];
      const ord = pollRes.json;
      status = ord.status;
      if (ord.finalize) finalizeUrl = ord.finalize;
      if (ord.certificate) certificateUrl = ord.certificate;
      log(`  订单状态: ${status}`);
      if (status === 'ready') break; // 所有权验证通过，进入 finalize
    }

    if (status === 'invalid') {
      throw new Error(`${idLabel}所有权验证失败。请检查${idLabel}解析与 80 端口可达性`);
    }
    if (status !== 'valid' && status !== 'ready') {
      throw new Error(`ACME 订单异常状态: ${status}`);
    }
    if (!finalizeUrl) {
      throw new Error('ACME 订单缺少 finalize URL');
    }

    // 7. 生成密钥 + CSR，finalize
    log(`  生成${idLabel}密钥与 CSR...`);
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const domainKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const csrPem = generateCsrPem(domain, domainKeyPem, acmeIdType);
    const csrDerB64 = csrPem
      .replace(/-----[^-]+-----/g, '')
      .replace(/\s+/g, '');

    log('  提交 CSR（finalize）...');
    const finSigned = signJws({
      accountKeyPem,
      url: finalizeUrl,
      nonce,
      payload: { csr: csrDerB64 },
      kid,
    });
    const finRes = await apiRequest(finalizeUrl, {
      method: 'POST',
      body: JSON.stringify(finSigned),
    });
    nonce = finRes.headers['replay-nonce'];

    // 8. 轮询直到证书可用
    status = finRes.json.status;
    certificateUrl = finRes.json.certificate || certificateUrl;
    const finDeadline = Date.now() + 60000;
    while (status === 'processing') {
      if (Date.now() > finDeadline) {
        throw new Error('finalize 处理超时');
      }
      await new Promise((r) => setTimeout(r, ORDER_POLL_INTERVAL_MS));
      const pollSigned = signJws({
        accountKeyPem,
        url: orderUrl,
        nonce,
        payload: '',
        kid,
      });
      const pollRes = await apiRequest(orderUrl, {
        method: 'POST',
        body: JSON.stringify(pollSigned),
      });
      nonce = pollRes.headers['replay-nonce'];
      status = pollRes.json.status;
      certificateUrl = pollRes.json.certificate || certificateUrl;
    }
    if (status !== 'valid' || !certificateUrl) {
      throw new Error(`ACME finalize 失败: ${status}`);
    }

    // 9. 下载证书链（fullchain）
    log('  下载证书链...');
    const certSigned = signJws({
      accountKeyPem,
      url: certificateUrl,
      nonce,
      payload: '',
      kid,
    });
    const certRes = await apiRequest(certificateUrl, {
      method: 'POST',
      body: JSON.stringify(certSigned),
    });
    const fullchainPem = certRes.body;

    return { fullchainPem, keyPem: domainKeyPem };
  } finally {
    await challengeServer.close();
  }
}

module.exports = { requestCertificate, jwkThumbprint, generateCsrPem, b64url };
