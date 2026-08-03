#!/bin/bash
set -e

echo "========================================"
echo "  ZViewer Docker 启动（HTTP 模式）"
echo "========================================"

# 确保运行时目录存在
mkdir -p config/ssl config/uploads config/media log

# ==================== 端口配置 ====================
BACKEND_PORT="${PORT:-3333}"
FRONTEND_PORT="${FRONTEND_PORT:-4173}"
RTMP_PORT="${RTMP_PORT:-3334}"
HTTP_FLV_PORT="${HTTP_FLV_PORT:-3335}"

# 后端环境变量
export PORT="$BACKEND_PORT"
export NODE_ENV=production
export HOST="${HOST:-0.0.0.0}"
export RTMP_PORT="$RTMP_PORT"
export HTTP_FLV_PORT="$HTTP_FLV_PORT"

# ==================== 工具函数 ====================

# 等待端口开始监听（后端初始化需要数秒，避免前端先就绪后页面请求被拒）
wait_for_port() {
  local port="$1"
  local timeout="${2:-30}"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if (echo > /dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# ==================== 启动后端 ====================
echo "  启动后端 (API: $BACKEND_PORT, RTMP: $RTMP_PORT, FLV: $HTTP_FLV_PORT)..."
./zviewer-backend &
BACKEND_PID=$!

echo "  等待后端就绪..."
if ! wait_for_port "$BACKEND_PORT" 30; then
  echo "  [错误] 后端在 30 秒内未就绪"
  kill "$BACKEND_PID" 2>/dev/null || true
  exit 1
fi
echo "  后端已就绪 (PID: $BACKEND_PID)"

# ==================== 启动前端 ====================
# 前端服务同时提供静态文件和反向代理：
#   /api        → 后端 (BACKEND_URL)
#   /socket.io  → 后端 (BACKEND_URL)
#   /live       → NMS HTTP-FLV (LIVE_URL)
echo "  启动前端 (端口: $FRONTEND_PORT)..."
PORT="$FRONTEND_PORT" HOST=0.0.0.0 \
  BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" \
  LIVE_URL="http://127.0.0.1:$HTTP_FLV_PORT" \
  ./zviewer-frontend &
FRONTEND_PID=$!

echo ""
echo "========================================"
echo "  ZViewer 已启动"
echo "  前端页面 : http://localhost:$FRONTEND_PORT"
echo "  后端 API : http://localhost:$BACKEND_PORT"
echo "  RTMP 推流: rtmp://localhost:$RTMP_PORT/live"
echo "  HTTP-FLV : http://localhost:$HTTP_FLV_PORT"
echo "========================================"

# ==================== 信号处理与进程监控 ====================

cleanup() {
  echo ""
  echo "  正在停止服务..."
  kill "$FRONTEND_PID" 2>/dev/null || true
  kill "$BACKEND_PID" 2>/dev/null || true
  wait "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  echo "  服务已停止"
  exit 0
}

trap cleanup SIGTERM SIGINT

# 等待任一进程退出
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done

echo "  [警告] 子进程已退出，正在停止所有服务..."
cleanup
