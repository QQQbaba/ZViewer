/**
 * 本地 mock ACME v2 服务器（测试用）。
 *
 * 模拟 Let's Encrypt 的 HTTP-01 流程：
 *   directory → newNonce → newAccount → newOrder → authz → challenge
 *   → 向客户端 challenge 服务器发起 HTTP-01 验证 → order ready → finalize(CSR)
 *   → 用内置 mock CA 签发证书 → 返回 fullchain。
 *
 * 用法：node test/mock-acme-server.js <port> <challengePort>
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const forge = require('node-forge');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function newNonce() {
  return b64url(crypto.randomBytes(16));
}

function verifyJws(body, accountJwk) {
  // 宽松校验：仅验证签名结构与 nonce 存在；若提供 accountJwk 则验签
  const obj = JSON.parse(body);
  const protectedHeader = JSON.parse(b64urlDecode(obj.protected).toString('utf8'));
  if (!protectedHeader.nonce) throw new Error('missing nonce');
  if (!protectedHeader.url) throw new Error('missing url');
  const signingInput = `${obj.protected}.${obj.payload}`;
  if (accountJwk) {
    const pub = crypto.createPublicKey({ key: { kty: 'RSA', n: accountJwk.n, e: accountJwk.e }, format: 'jwk' });
    const ok = crypto.verify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), pub, b64urlDecode(obj.signature));
    if (!ok) throw new Error('JWS signature invalid');
  }
  return { protectedHeader, payload: obj.payload ? JSON.parse(b64urlDecode(obj.payload).toString('utf8')) : {} };
}

// 生成 mock CA（自签）与域名证书
function makeMockCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - 1);
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  cert.setSubject([{ name: 'commonName', value: 'Mock Test CA' }]);
  cert.setIssuer([{ name: 'commonName', value: 'Mock Test CA' }]);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), privateKey: keys.privateKey };
}

function issueDomainCert(ca, domain, csrDerB64) {
  const csrDer = b64urlDecode(csrDerB64);
  const csr = forge.pki.certificationRequestFromAsn1(
    forge.asn1.fromDer(forge.util.createBuffer(csrDer)),
  );
  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - 1);
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + 30);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  cert.setSubject([{ name: 'commonName', value: domain }]);
  cert.setIssuer(ca.certPem ? forge.pki.certificateFromPem(ca.certPem).subject.attributes : [{ name: 'commonName', value: 'Mock Test CA' }]);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
  ]);
  cert.sign(ca.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert) + ca.certPem;
}

function startMockAcmeServer(port, challengePort) {
  const ca = makeMockCa();
  const state = {
    nonce: newNonce(),
    account: null, // { kid, jwk }
    order: null, // { url, domain, authzUrl, challengeUrl, finalizeUrl, certUrl, status }
  };

  const server = http.createServer(async (req, res) => {
    const sendJson = (code, obj, headers = {}) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Replay-Nonce': state.nonce,
        ...headers,
      });
      res.end(body);
    };

    try {
      const url = req.url.split('?')[0];

      if (req.method === 'GET' && url === '/directory') {
        return sendJson(200, {
          newNonce: `${serverBase}/new-nonce`,
          newAccount: `${serverBase}/new-account`,
          newOrder: `${serverBase}/new-order`,
        });
      }

      if (req.method === 'HEAD' && url === '/new-nonce') {
        res.writeHead(200, { 'Replay-Nonce': state.nonce });
        return res.end();
      }

      if (req.method === 'POST') {
        const body = await readBody(req);

        if (url === '/new-account') {
          const { protectedHeader } = verifyJws(body, null);
          const jwk = protectedHeader.jwk;
          state.account = { kid: `${serverBase}/acct/1`, jwk };
          return sendJson(200, { status: 'valid' }, { Location: state.account.kid });
        }

        if (url === '/new-order') {
          verifyJws(body, state.account && state.account.jwk);
          const payload = JSON.parse(b64urlDecode(JSON.parse(body).payload).toString('utf8'));
          const domain = payload.identifiers[0].value;
          state.order = {
            url: `${serverBase}/order/1`,
            domain,
            authzUrl: `${serverBase}/authz/1`,
            challengeUrl: `${serverBase}/challenge/1`,
            finalizeUrl: `${serverBase}/finalize/1`,
            certUrl: `${serverBase}/cert/1`,
            authzValid: false,
            finalized: false,
          };
          return sendJson(201, {
            status: 'pending',
            identifiers: [{ type: 'dns', value: domain }],
            authorizations: [state.order.authzUrl],
            finalize: state.order.finalizeUrl,
          }, { Location: state.order.url });
        }

        if (url === '/authz/1') {
          verifyJws(body, state.account.jwk);
          return sendJson(200, {
            status: state.order.authzValid ? 'valid' : 'pending',
            identifier: { type: 'dns', value: state.order.domain },
            challenges: [
              {
                type: 'http-01',
                url: state.order.challengeUrl,
                token: 'mocktoken123',
                status: state.order.authzValid ? 'valid' : 'pending',
              },
            ],
          });
        }

        if (url === '/challenge/1') {
          verifyJws(body, state.account.jwk);
          // 模拟 CA 进行 HTTP-01 验证：访问客户端的 challenge 服务器
          const http01Url = `http://127.0.0.1:${challengePort}/.well-known/acme-challenge/mocktoken123`;
          const verifyRes = await new Promise((resolve) => {
            const req2 = http.get(http01Url, (r) => {
              let d = '';
              r.on('data', (c) => (d += c));
              r.on('end', () => resolve({ status: r.statusCode, body: d }));
            });
            req2.on('error', () => resolve({ status: 0, body: '' }));
            req2.setTimeout(5000, () => { req2.destroy(); resolve({ status: 0, body: '' }); });
          });
          if (verifyRes.status === 200 && verifyRes.body.length > 0) {
            state.order.authzValid = true;
            return sendJson(200, { status: 'valid' });
          }
          return sendJson(403, { status: 'invalid', detail: 'HTTP-01 verification failed' });
        }

        if (url === '/order/1') {
          verifyJws(body, state.account.jwk);
          const status = state.order.finalized
            ? 'valid'
            : state.order.authzValid
              ? 'ready'
              : 'pending';
          return sendJson(200, {
            status,
            identifiers: [{ type: 'dns', value: state.order.domain }],
            authorizations: [state.order.authzUrl],
            finalize: state.order.finalizeUrl,
            certificate: status === 'valid' ? state.order.certUrl : undefined,
          });
        }

        if (url === '/finalize/1') {
          verifyJws(body, state.account.jwk);
          const payload = JSON.parse(b64urlDecode(JSON.parse(body).payload).toString('utf8'));
          state.order.csr = payload.csr;
          state.order.finalized = true;
          return sendJson(200, {
            status: 'processing',
            identifiers: [{ type: 'dns', value: state.order.domain }],
            finalize: state.order.finalizeUrl,
          });
        }

        if (url === '/cert/1') {
          verifyJws(body, state.account.jwk);
          const fullchain = issueDomainCert(ca, state.order.domain, state.order.csr);
          res.writeHead(200, { 'Content-Type': 'application/pem-certificate-chain', 'Replay-Nonce': state.nonce });
          return res.end(fullchain);
        }
      }

      res.writeHead(404);
      res.end('Not Found');
    } catch (e) {
      sendJson(400, { type: 'urn:ietf:params:acme:error:malformed', detail: e.message });
    }
  });

  const serverBase = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, base: serverBase, close: () => new Promise((r) => server.close(r)) }));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

module.exports = { startMockAcmeServer };

if (require.main === module) {
  const port = Number(process.argv[2]) || 14000;
  const challengePort = Number(process.argv[3]) || 80;
  startMockAcmeServer(port, challengePort).then(({ base }) => {
    console.log(`mock ACME 服务器已启动: ${base}/directory`);
  });
}
