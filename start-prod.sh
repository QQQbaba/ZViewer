#!/usr/bin/env bash
set -euo pipefail

# ZViewer 一键启动脚本
# 命令：start | stop | restart | status | logs | build | help

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
LOG_DIR="$ROOT_DIR/log"
PIDS_FILE="$ROOT_DIR/.prod.pids.json"
PORTS_FILE="$ROOT_DIR/.prod.ports.json"

BACKEND_PORT=3333
FRONTEND_PORT=4173
DO_BUILD=0

# ==================== 工具函数 ====================

read_ports() {
  if [[ -f "$PORTS_FILE" ]]; then
    BACKEND_PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PORTS_FILE','utf8')).backend||$BACKEND_PORT)}catch{console.log($BACKEND_PORT)}" 2>/dev/null || echo "$BACKEND_PORT")
    FRONTEND_PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PORTS_FILE','utf8')).frontend||$FRONTEND_PORT)}catch{console.log($FRONTEND_PORT)}" 2>/dev/null || echo "$FRONTEND_PORT")
  fi
}

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -i:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -lnt "sport = :$port" 2>/dev/null | grep -q LISTEN
  else
    return 1
  fi
}

deps_ok() {
  [[ -d "$ROOT_DIR/node_modules" ]] \
    && [[ -d "$ROOT_DIR/node_modules/express" ]] \
    && [[ -d "$ROOT_DIR/node_modules/better-sqlite3" ]] \
    && [[ -d "$ROOT_DIR/node_modules/typeorm" ]]
}

install_deps() {
  if deps_ok; then
    echo "  依赖已安装"
    return
  fi
  echo "  安装依赖..."
  (cd "$ROOT_DIR" && npm ci --no-audit --no-fund --prefer-offline --include=dev) || \
  (cd "$ROOT_DIR" && npm install --no-audit --no-fund --include=dev)
}

sqlite_ok() {
  local node_file
  node_file=$(find "$ROOT_DIR/node_modules/better-sqlite3" -name "*.node" -type f -print -quit 2>/dev/null || true)
  [[ -n "$node_file" ]]
}

rebuild_sqlite() {
  if sqlite_ok; then
    return
  fi
  echo "  better-sqlite3 原生模块缺失，重建中..."
  (cd "$ROOT_DIR" && npm rebuild better-sqlite3)
}

build() {
  echo "  构建后端..."
  (cd "$BACKEND_DIR" && npm run build)
  echo "  构建前端..."
  (cd "$FRONTEND_DIR" && npm run build)
  echo "  构建完成"
}

# ==================== 命令 ====================

cmd_start() {
  read_ports

  echo "========================================"
  echo "  ZViewer 启动"
  echo "  后端端口: $BACKEND_PORT"
  echo "  前端端口: $FRONTEND_PORT"
  echo "========================================"

  if port_in_use "$BACKEND_PORT"; then
    echo "  错误：后端端口 $BACKEND_PORT 已被占用" >&2
    exit 1
  fi
  if port_in_use "$FRONTEND_PORT"; then
    echo "  错误：前端端口 $FRONTEND_PORT 已被占用" >&2
    exit 1
  fi

  install_deps
  rebuild_sqlite

  if [[ "$DO_BUILD" -eq 1 ]]; then
    build
  else
    echo "  跳过构建（如需构建请加 --build）"
  fi

  mkdir -p "$LOG_DIR"

  # 启动前清空旧日志，避免混叠
  : > "$LOG_DIR/backend.log"
  : > "$LOG_DIR/frontend.log"

  echo "  启动后端..."
  pushd "$BACKEND_DIR" >/dev/null
  PORT="$BACKEND_PORT" nohup node dist/index.js > "$LOG_DIR/backend.log" 2>&1 &
  local backend_pid=$!
  popd >/dev/null

  echo "  启动前端..."
  pushd "$FRONTEND_DIR" >/dev/null
  nohup npx vite preview --port "$FRONTEND_PORT" --host > "$LOG_DIR/frontend.log" 2>&1 &
  local frontend_pid=$!
  popd >/dev/null

  node -e "
    const fs = require('fs');
    fs.writeFileSync('$PIDS_FILE', JSON.stringify({
      backend: { pid: $backend_pid },
      frontend: { pid: $frontend_pid },
      ports: { backend: $BACKEND_PORT, frontend: $FRONTEND_PORT }
    }, null, 2));
  "

  echo "  后端 PID: $backend_pid"
  echo "  前端 PID: $frontend_pid"
  echo "  日志: $LOG_DIR/"
}

cmd_build() {
  install_deps
  rebuild_sqlite
  build
}

cmd_stop() {
  if [[ -f "$PIDS_FILE" ]]; then
    local backend_pid frontend_pid
    backend_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIDS_FILE','utf8')).backend.pid||'')}catch{}" 2>/dev/null || true)
    frontend_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIDS_FILE','utf8')).frontend.pid||'')}catch{}" 2>/dev/null || true)
    [[ -n "$backend_pid" ]] && kill "$backend_pid" 2>/dev/null || true
    [[ -n "$frontend_pid" ]] && kill "$frontend_pid" 2>/dev/null || true
    rm -f "$PIDS_FILE"
  fi
  pkill -f "node.*backend/dist" 2>/dev/null || true
  pkill -f "vite preview" 2>/dev/null || true
  echo "  已停止"
}

cmd_restart() {
  cmd_stop || true
  cmd_start
}

cmd_status() {
  if [[ -f "$PIDS_FILE" ]]; then
    node -e "
      const fs = require('fs');
      try {
        const d = JSON.parse(fs.readFileSync('$PIDS_FILE','utf8'));
        console.log('  后端 PID: ' + d.backend.pid + ' (端口 ' + d.ports.backend + ')');
        console.log('  前端 PID: ' + d.frontend.pid + ' (端口 ' + d.ports.frontend + ')');
      } catch {
        console.log('  PID 文件损坏');
      }
    "
  else
    echo "  未运行"
  fi
}

cmd_logs() {
  local target="${1:-backend}"
  if [[ "$target" == "frontend" ]]; then
    tail -f "$LOG_DIR/frontend.log"
  else
    tail -f "$LOG_DIR/backend.log"
  fi
}

usage() {
  cat <<EOF
用法: $0 {start|stop|restart|status|logs|build|help} [选项]

命令:
  start              安装依赖后直接启动（默认不构建）
  build              单独构建前后端
  stop               停止服务
  restart            重启服务
  status             查看运行状态
  logs [backend|frontend]  查看日志（默认 backend）
  help               显示此帮助

start/restart 选项:
  -p, --port PORT         指定后端端口（默认 3333）
  -f, --frontend-port PORT 指定前端端口（默认 4173）
      --build             启动前执行构建
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -p|--port) BACKEND_PORT="$2"; shift 2 ;;
      -f|--frontend-port) FRONTEND_PORT="$2"; shift 2 ;;
      --build) DO_BUILD=1; shift ;;
      *) echo "  未知参数: $1" >&2; usage; exit 1 ;;
    esac
  done
}

# ==================== 入口 ====================

main() {
  local cmd="${1:-help}"
  shift || true

  case "$cmd" in
    start)
      parse_args "$@"
      cmd_start
      ;;
    build)
      cmd_build
      ;;
    stop)
      cmd_stop
      ;;
    restart)
      parse_args "$@"
      cmd_restart
      ;;
    status)
      cmd_status
      ;;
    logs)
      cmd_logs "$1"
      ;;
    help|--help|-h|*)
      usage
      ;;
  esac
}

main "$@"
