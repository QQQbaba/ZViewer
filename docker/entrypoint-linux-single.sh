#!/bin/bash
set -e

echo "========================================"
echo "  ZViewer Docker 启动（HTTP 模式）"
echo "  统一端口：后端提供 API + 前端静态文件"
echo "========================================"

# 确保运行时目录存在
mkdir -p config/ssl config/uploads config/media log

# ==================== 端口配置 ====================
# 统一端口：前后端共用同一端口（默认 3333），由后端托管前端静态文件
PORT="${PORT:-3333}"
RTMP_PORT="${RTMP_PORT:-3334}"
HTTP_FLV_PORT="${HTTP_FLV_PORT:-3335}"

# 后端环境变量
export PORT="$PORT"
export NODE_ENV=production
export HOST="${HOST:-0.0.0.0}"
export RTMP_PORT="$RTMP_PORT"
export HTTP_FLV_PORT="$HTTP_FLV_PORT"

# ==================== 启动后端 ====================
echo "  启动后端 (统一端口: $PORT, RTMP: $RTMP_PORT, FLV: $HTTP_FLV_PORT)..."
./zviewer-backend &
BACKEND_PID=$!
# 记录后端 PID 到 pidfile，供 Docker 更新脚本终止后端进程以触发容器重启
echo "$BACKEND_PID" > /app/.backend.pid

echo ""
echo "========================================"
echo "  ZViewer 已启动"
echo "  访问页面 : http://localhost:$PORT"
echo "  RTMP 推流: rtmp://localhost:$RTMP_PORT/live"
echo "  HTTP-FLV : http://localhost:$PORT/live/ (通过后端 /live 代理)"
echo "========================================"

# ==================== 信号处理与进程监控 ====================

cleanup() {
  echo ""
  echo "  正在停止服务..."
  kill "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  echo "  服务已停止"
  exit 0
}

trap cleanup SIGTERM SIGINT

# 等待后端进程退出
while kill -0 "$BACKEND_PID" 2>/dev/null; do
  sleep 1
done

echo "  [警告] 后端进程已退出，正在停止服务..."
cleanup
