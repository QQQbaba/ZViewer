#!/bin/sh
# ZViewer 一键启动 (Linux)
# 用法: ./start.sh   （如无执行权限可改用: sh start.sh 或 bash start.sh）
cd "$(dirname "$0")" || exit 1

echo "========================================"
echo "  ZViewer 一键启动 (Linux)"
echo "========================================"

# ---------- 配置区（可在此手动覆盖） ----------
DEFAULT_PORT=3333
PORT_OVERRIDE="${PORT_OVERRIDE:-}"
BACKEND_URL_OVERRIDE="${BACKEND_URL_OVERRIDE:-}"
# ---------------------------------------------

[ -f ./zviewer-backend ] || { echo "[ERROR] 未找到 zviewer-backend"; exit 1; }
[ -f ./zviewer-frontend ] || { echo "[ERROR] 未找到 zviewer-frontend"; exit 1; }
[ -x ./zviewer-backend ] || { echo "[ERROR] zviewer-backend 无执行权限，请先执行: chmod +x zviewer-backend zviewer-frontend"; exit 1; }
[ -x ./zviewer-frontend ] || { echo "[ERROR] zviewer-frontend 无执行权限，请先执行: chmod +x zviewer-backend zviewer-frontend"; exit 1; }

# 从 .env 读取 PORT（若存在）
CFG_PORT=""
if [ -f .env ]; then
  CFG_PORT=$(grep -E '^PORT=' .env | head -n 1 | cut -d= -f2- | tr -d '"' | xargs)
fi

PORT="$DEFAULT_PORT"
if [ -n "$PORT_OVERRIDE" ]; then
  PORT="$PORT_OVERRIDE"
elif [ -n "$CFG_PORT" ]; then
  PORT="$CFG_PORT"
fi

BACKEND_URL="http://localhost:$PORT"
if [ -n "$BACKEND_URL_OVERRIDE" ]; then
  BACKEND_URL="$BACKEND_URL_OVERRIDE"
fi

# 导出给子进程
export PORT BACKEND_URL

mkdir -p log

echo "启动后端..."
nohup ./zviewer-backend >> log/backend-console.log 2>&1 &
BACKEND_PID=$!

echo "启动前端..."
nohup ./zviewer-frontend >> log/frontend-console.log 2>&1 &
FRONTEND_PID=$!

sleep 1
echo ""
echo "  ZViewer 已启动"
echo "  后端  : http://localhost:$PORT"
echo "  前端  : $BACKEND_URL"
echo "  日志  : $(pwd)/log/"
echo "  停止  : kill $BACKEND_PID $FRONTEND_PID"
echo ""
