/**
 * ZViewer 前端静态文件服务 + API 反向代理（零外部依赖）。
 *
 * 使用纯 Node.js 内置模块实现，无需任何 npm 包。
 * 将前端构建产物（frontend/dist/）作为静态文件提供，
 * 并将 /api、/socket.io、/live 请求代理到后端。
 *
 * 环境变量：
 *   PORT            - 监听端口（默认 4173）
 *   HOST            - 监听地址（默认 0.0.0.0）
 *   BACKEND_URL     - 后端地址（默认 http://localhost:3333）
 *   LIVE_URL        - NMS HTTP-FLV 地址（默认 http://localhost:3335）
 *   FRONTEND_DIST   - 前端构建产物目录（默认自动检测）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ==================== 路径解析 ====================

const EXE_DIR = process.pkg
  ? path.dirname(process.execPath)
  : path.resolve(__dirname, '..');

const CWD = process.cwd();

function findFrontendDist() {
  if (process.env.FRONTEND_DIST) {
    const d = path.resolve(process.env.FRONTEND_DIST);
    if (fs.existsSync(d)) return d;
    console.warn(`[frontend-server] 环境变量 FRONTEND_DIST 指定的路径不存在: ${d}`);
  }

  const candidates = [
    path.join(EXE_DIR, 'frontend', 'dist'),
    path.join(CWD, 'frontend', 'dist'),
    path.join(CWD, 'dist'),
  ];

  for (const c of candidates) {
    const resolved = path.resolve(c);
    if (fs.existsSync(resolved) && fs.existsSync(path.join(resolved, 'index.html'))) {
      return resolved;
    }
  }

  return null;
}

// ==================== 配置 ====================

const PORT = parseInt(process.env.PORT || '4173', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3333';
const LIVE_URL = process.env.LIVE_URL || 'http://localhost:3335';
const FRONTEND_DIST = findFrontendDist();

if (!FRONTEND_DIST) {
  console.error('[frontend-server] 错误：找不到前端构建产物（frontend/dist/）');
  console.error('[frontend-server] 请先构建前端：npm run build -w frontend');
  console.error('[frontend-server] 或设置 FRONTEND_DIST 环境变量指定路径');
  process.exit(1);
}

// ==================== 工具函数 ====================

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

/** 解析目标 URL 为主机 + 端口 + 路径 */
function parseTargetUrl(targetUrl) {
  const url = new URL(targetUrl);
  return {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    protocol: url.protocol,
  };
}

/** 创建 HTTP 代理请求 */
function proxyRequest(req, res, targetUrl, pathPrefix) {
  const target = parseTargetUrl(targetUrl);
  const targetPath = req.url;
  const options = {
    hostname: target.hostname,
    port: target.port,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${target.hostname}:${target.port}`,
    },
    timeout: 120_000,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[frontend-server] 代理错误 (${req.url}): ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Gateway Timeout');
    }
  });

  req.pipe(proxyReq);
}

// ==================== 静态文件服务 ====================

function serveStaticFile(req, res) {
  // 安全检查：防止路径穿越
  let requestedPath = decodeURIComponent(req.url).split('?')[0];
  // 如果是 / 或空路径，返回 index.html
  if (requestedPath === '/' || requestedPath === '') {
    requestedPath = '/index.html';
  }

  const filePath = path.join(FRONTEND_DIST, requestedPath);

  // 确保文件在 FRONTEND_DIST 目录内（防止路径穿越）
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(path.resolve(FRONTEND_DIST))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = fs.statSync(resolvedPath);
    if (stat.isFile()) {
      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      const headers = { 'Content-Type': contentType };

      // HTML 文件不缓存
      if (ext === '.html') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      } else {
        headers['Cache-Control'] = 'public, max-age=604800, immutable';
      }

      res.writeHead(200, headers);
      fs.createReadStream(resolvedPath).pipe(res);
      return true;
    }
  } catch {
    // 文件不存在，继续到 SPA 回退
  }
  return false;
}

// ==================== 创建服务器 ====================

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // API 代理
  if (url.startsWith('/api')) {
    return proxyRequest(req, res, BACKEND_URL, '/api');
  }

  // Socket.IO 代理
  if (url.startsWith('/socket.io')) {
    return proxyRequest(req, res, BACKEND_URL, '/socket.io');
  }

  // NMS 拉流代理
  if (url.startsWith('/live')) {
    return proxyRequest(req, res, LIVE_URL, '/live');
  }

  // 静态文件
  if (serveStaticFile(req, res)) {
    return;
  }

  // SPA 回退：返回 index.html
  const indexPath = path.join(FRONTEND_DIST, 'index.html');
  try {
    fs.statSync(indexPath);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    fs.createReadStream(indexPath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ==================== WebSocket 代理 ====================

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';

  // 只代理 /socket.io 的 WebSocket 连接
  if (!url.startsWith('/socket.io')) {
    socket.destroy();
    return;
  }

  const target = parseTargetUrl(BACKEND_URL);
  const proxySocket = http.request({
    hostname: target.hostname,
    port: parseInt(target.port, 10),
    path: url,
    method: 'CONNECT',
    headers: {
      ...req.headers,
      host: `${target.hostname}:${target.port}`,
    },
  });

  // 连接后端 WebSocket 服务器
  const net = require('net');
  const backendSocket = net.createConnection(
    { host: target.hostname, port: parseInt(target.port, 10) },
    () => {
      // 发送 HTTP Upgrade 请求
      const upgradeReq = [
        `GET ${url} HTTP/1.1`,
        `Host: ${target.hostname}:${target.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        ...Object.entries(req.headers)
          .filter(([k]) => !['host', 'connection', 'upgrade'].includes(k.toLowerCase()))
          .map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ].join('\r\n');

      backendSocket.write(upgradeReq);
    },
  );

  backendSocket.on('data', (data) => {
    const response = data.toString('utf8');
    if (response.includes('101 Switching Protocols')) {
      // WebSocket 握手成功，双向转发数据
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');

      backendSocket.pipe(socket);
      socket.pipe(backendSocket);
    }
  });

  backendSocket.on('error', () => {
    socket.destroy();
  });

  socket.on('error', () => {
    backendSocket.destroy();
  });
});

// ==================== 启动 ====================

server.listen(PORT, HOST, () => {
  console.log('========================================');
  console.log('  ZViewer 前端服务已启动');
  console.log('========================================');
  console.log(`  监听地址: http://${HOST}:${PORT}`);
  console.log(`  后端 API: ${BACKEND_URL}`);
  console.log(`  媒体拉流: ${LIVE_URL}`);
  console.log(`  前端目录: ${FRONTEND_DIST}`);
  console.log('========================================');
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n[frontend-server] 正在关闭...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});