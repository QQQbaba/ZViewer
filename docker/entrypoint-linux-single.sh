#!/bin/sh
set -e

echo "========================================"
echo "  ZViewer Docker 启动"
echo "========================================"

# 如果证书不存在，自动签发 localhost 自签证书
if [ ! -f config/ssl/cert.pem ]; then
  echo "  生成 SSL 证书（localhost）..."
  ./zviewer-cert localhost
fi

# 设置后端环境变量（HTTPS 模式，后端同时 serve 前端静态页面）
export PORT=3333
export HTTPS=true
export NODE_ENV=production
export HOST='::'
export SSL_CERT_PATH=/app/config/ssl/cert.pem
export SSL_KEY_PATH=/app/config/ssl/key.pem

echo "  启动后端（HTTPS，已包含前端页面）..."
echo "  访问  : https://localhost:3333"
echo "========================================"

exec ./zviewer-backend