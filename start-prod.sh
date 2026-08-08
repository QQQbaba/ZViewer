#!/usr/bin/env bash
set -euo pipefail

# ZViewer 一键启动脚本
# 命令：start | backend | stop | restart | status | logs | build | help

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
LOG_DIR="$ROOT_DIR/log"
PIDS_FILE="$ROOT_DIR/.prod.pids.json"

BACKEND_PORT=""
FRONTEND_PORT=""
BACKEND_ONLY=0
DO_BUILD=0
HTTPS_MODE=0

# ==================== 工具函数 ====================

# 端口固定：后端 = .env 的 PORT 或默认 3333；前端 = 4173
set_ports() {
  if [[ -z "$BACKEND_PORT" ]]; then
    local env_port
    env_port=""
    if [[ -f "$ROOT_DIR/.env" ]]; then
      env_port=$(grep -E '^PORT=' "$ROOT_DIR/.env" | head -n 1 | cut -d= -f2- | tr -d '"' | xargs)
    fi
    if [[ -n "$env_port" ]]; then BACKEND_PORT="$env_port"; else BACKEND_PORT=3333; fi
  fi
  if [[ -z "$FRONTEND_PORT" ]]; then
    FRONTEND_PORT=4173
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

kill_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    [[ -n "$pids" ]] && kill $pids 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    local pids
    pids=$(ss -lptn "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
    [[ -n "$pids" ]] && kill $pids 2>/dev/null || true
  fi
}

# 等待端口开始监听（后端初始化需要数秒，避免前端先就绪后页面请求被拒）
wait_port_ready() {
  local port="$1"
  local timeout="${2:-30}"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if port_in_use "$port"; then
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

deps_ok() {
  [[ -d "$ROOT_DIR/node_modules" ]] \
    && [[ -d "$ROOT_DIR/node_modules/express" ]] \
    && [[ -d "$ROOT_DIR/node_modules/sql.js" ]] \
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

build() {
  echo "  构建后端..."
  (cd "$BACKEND_DIR" && npm run build)
  echo "  构建前端..."
  (cd "$FRONTEND_DIR" && npm run build)
  echo "  构建完成"
}

# ==================== 命令 ====================

cmd_start() {
  set_ports

  echo "========================================"
  echo "  ZViewer 启动"
  echo "  后端端口: $BACKEND_PORT"
  if [[ "$HTTPS_MODE" -eq 1 ]]; then
    echo "  模式: HTTPS（自签/可信证书）"
    echo "  前端端口: $FRONTEND_PORT"
  elif [[ "$BACKEND_ONLY" -eq 1 ]]; then
    echo "  模式: 仅后端（HTTP）"
  else
    echo "  前端端口: $FRONTEND_PORT"
  fi
  echo "========================================"

  if port_in_use "$BACKEND_PORT"; then
    echo "  错误：后端端口 $BACKEND_PORT 已被占用" >&2
    exit 1
  fi
  if [[ "$BACKEND_ONLY" -eq 0 ]] && port_in_use "$FRONTEND_PORT"; then
    echo "  错误：前端端口 $FRONTEND_PORT 已被占用" >&2
    exit 1
  fi

  install_deps

  if [[ "$DO_BUILD" -eq 1 ]]; then
    build
  else
    echo "  跳过构建（如需构建请加 --build）"
  fi

  local backend_artifact="$BACKEND_DIR/dist/index.js"
  local frontend_artifact="$FRONTEND_DIR/dist/index.html"
  if [[ ! -f "$backend_artifact" ]]; then
    echo "  错误：后端构建产物缺失: $backend_artifact" >&2
    exit 1
  fi
  if [[ "$BACKEND_ONLY" -eq 0 ]]; then
    if [[ ! -f "$frontend_artifact" ]]; then
      echo "  错误：前端构建产物缺失: $frontend_artifact" >&2
      exit 1
    fi
  fi

  # HTTPS 模式：生成自签证书
  if [[ "$HTTPS_MODE" -eq 1 ]]; then
    echo "  生成自签 SSL 证书..."
    node "$ROOT_DIR/scripts/generate-cert.js"
    if [[ $? -ne 0 ]]; then
      echo "  SSL 证书生成失败" >&2
      exit 1
    fi
  fi

  mkdir -p "$LOG_DIR"

  # 启动前清空旧日志，避免混叠
  : > "$LOG_DIR/backend.log"
  if [[ "$BACKEND_ONLY" -eq 0 ]]; then
    : > "$LOG_DIR/frontend.log"
  fi

  echo "  启动后端..."
  pushd "$BACKEND_DIR" >/dev/null
  PORT="$BACKEND_PORT" \
    NODE_ENV="production" \
    HTTPS="$([[ "$HTTPS_MODE" -eq 1 ]] && echo "true" || echo "")" \
    nohup node dist/index.js > "$LOG_DIR/backend.log" 2>&1 &
  local backend_pid=$!
  popd >/dev/null

  # 等待后端就绪（TypeORM 初始化 + NMS 启动需要数秒），
  # 避免前端先就绪时页面请求被 ECONNREFUSED
  echo "  等待后端就绪..."
  if ! wait_port_ready "$BACKEND_PORT"; then
    echo "  错误：后端在 30 秒内未就绪，请检查日志: $LOG_DIR/backend.log" >&2
    kill "$backend_pid" 2>/dev/null || true
    return 1
  fi

  if [[ "$HTTPS_MODE" -eq 1 ]]; then
    # HTTPS 模式：后端使用 HTTPS，前端单独启动在 4173 端口
    # Vite preview 代理通过 VITE_API_TARGET 指向 HTTPS 后端
    echo "  启动前端..."
    pushd "$FRONTEND_DIR" >/dev/null
    VITE_API_TARGET="https://localhost:$BACKEND_PORT" \
      nohup npx vite preview --port "$FRONTEND_PORT" --host > "$LOG_DIR/frontend.log" 2>&1 &
    local frontend_pid=$!
    popd >/dev/null

    node -e "
      const fs = require('fs');
      fs.writeFileSync('$PIDS_FILE', JSON.stringify({
        backend: { pid: $backend_pid },
        frontend: { pid: $frontend_pid }
      }, null, 2));
    "

    echo "  后端 PID: $backend_pid"
    echo "  前端 PID: $frontend_pid"
    echo "  HTTPS 后端: https://localhost:$BACKEND_PORT"
    echo "  访问  : http://localhost:$FRONTEND_PORT"
    echo "  日志  : $LOG_DIR/"
  elif [[ "$BACKEND_ONLY" -eq 1 ]]; then
    # 仅后端模式：不启动前端
    node -e "
      const fs = require('fs');
      fs.writeFileSync('$PIDS_FILE', JSON.stringify({
        backend: { pid: $backend_pid },
        frontend: null
      }, null, 2));
    "
    echo "  后端 PID: $backend_pid"
    echo "  访问  : http://localhost:$BACKEND_PORT   （仅后端，未启动前端）"
    echo "  日志  : $LOG_DIR/"
  else
    echo "  启动前端..."
    pushd "$FRONTEND_DIR" >/dev/null
    nohup npx vite preview --port "$FRONTEND_PORT" --host > "$LOG_DIR/frontend.log" 2>&1 &
    local frontend_pid=$!
    popd >/dev/null

    node -e "
      const fs = require('fs');
      fs.writeFileSync('$PIDS_FILE', JSON.stringify({
        backend: { pid: $backend_pid },
        frontend: { pid: $frontend_pid }
      }, null, 2));
    "

    echo "  后端 PID: $backend_pid"
    echo "  前端 PID: $frontend_pid"
    echo "  访问  : http://localhost:$FRONTEND_PORT"
    echo "  日志  : $LOG_DIR/"
  fi
}

cmd_build() {
  install_deps
  build
}

cmd_stop() {
  set_ports
  if [[ -f "$PIDS_FILE" ]]; then
    local backend_pid frontend_pid
    backend_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIDS_FILE','utf8')).backend.pid||'')}catch{}" 2>/dev/null || true)
    frontend_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIDS_FILE','utf8')).frontend?.pid||'')}catch{}" 2>/dev/null || true)
    [[ -n "$backend_pid" ]] && kill "$backend_pid" 2>/dev/null || true
    [[ -n "$frontend_pid" ]] && kill "$frontend_pid" 2>/dev/null || true
    rm -f "$PIDS_FILE"
  fi
  pkill -f "node.*backend/dist" 2>/dev/null || true
  pkill -f "vite preview" 2>/dev/null || true
  kill_port "$FRONTEND_PORT"
  echo "  已停止"
}

cmd_restart() {
  cmd_stop || true
  cmd_start
}

cmd_status() {
  set_ports
  if [[ -f "$PIDS_FILE" ]]; then
    local backend_pid frontend_pid
    backend_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIDS_FILE','utf8')).backend.pid||'')}catch{}" 2>/dev/null || true)
    frontend_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIDS_FILE','utf8')).frontend?.pid||'')}catch{}" 2>/dev/null || true)
    echo "  后端 PID: $backend_pid (端口 $BACKEND_PORT)"
    if [[ -n "$frontend_pid" ]]; then
      echo "  前端 PID: $frontend_pid (端口 $FRONTEND_PORT)"
    else
      echo "  前端: 未启动（仅后端 / HTTPS 模式）"
    fi
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

# ==================== 证书 ====================

# 交互选择证书签发类型（localhost / 域名或公网 IP）
select_cert_host() {
  echo ""
  echo "  请选择证书签发类型："
  echo "    [1] localhost（本机访问，默认，自签证书）"
  echo "    [2] 域名或公网 IP（如 example.com 或 1.2.3.4）"
  echo "        - 域名和公网 IP 将自动申请 Let's Encrypt 可信 CA 证书"
  echo "          （需已指向本机且 80 端口可访问）"
  echo "        - 内网 IP 使用自签证书"
  printf "  请输入 1 或 2（直接回车默认 1）: "
  read CERT_CHOICE
  if [ "$CERT_CHOICE" = "2" ]; then
    printf "  请输入域名或公网 IP 地址: "
    read CERT_HOST
    if [ -z "$CERT_HOST" ]; then
      echo "  [提示] 未输入地址，将使用 localhost"
      CERT_HOST="localhost"
    else
      echo ""
      echo "  [提示] 域名和公网 IP 将自动申请 Let's Encrypt 可信 CA 证书；"
      echo "         若无法申请（未解析 / 80 端口不可达），可改输入内网 IP 或 localhost 使用自签证书。"
    fi
  else
    CERT_HOST="localhost"
  fi
}

# 一键签发证书：交互选择类型后调用 scripts/generate-cert.js
do_cert() {
  local cert_script="$ROOT_DIR/scripts/generate-cert.js"
  if [[ ! -f "$cert_script" ]]; then
    echo "  [错误] 证书生成脚本缺失: $cert_script" >&2
    return 1
  fi
  select_cert_host
  echo "  [证书] 签发类型: $CERT_HOST"
  node "$cert_script" "$CERT_HOST"
  local rc=$?
  echo ""
  if [[ $rc -ne 0 ]]; then
    echo "  [证书] 签发失败（退出码 $rc）" >&2
    return 1
  fi
  echo "  [证书] 签发完成，证书位于 config/ssl/"
  return 0
}

# HTTPS 启动：交互选择证书类型 → 签发 → 以 HTTPS 启动（后端 HTTPS，前端 4173）
do_https() {
  local cert_script="$ROOT_DIR/scripts/generate-cert.js"
  if [[ ! -f "$cert_script" ]]; then
    echo "  [错误] 证书生成脚本缺失: $cert_script" >&2
    return 1
  fi
  select_cert_host
  echo "  [证书] 签发类型: $CERT_HOST"
  node "$cert_script" "$CERT_HOST"
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "  [证书] 签发失败，HTTPS 启动中止" >&2
    return 1
  fi
  HTTPS_MODE=1
  cmd_start
  return 0
}

usage() {
  cat <<EOF
用法: $0 {start|backend|cert|https|stop|restart|status|logs|build|menu|help} [选项]

命令:
  start              安装依赖后直接启动（默认不构建）
  backend            仅启动后端（加 --https 使用 HTTPS）
  build              单独构建前后端
  stop               停止服务
  restart            重启服务
  status             查看运行状态
  logs [backend|frontend]  查看日志（默认 backend）
  cert               一键签发 SSL 证书（localhost / 域名(Let's Encrypt) / 公网 IP）
  https              签发证书后以 HTTPS 启动（后端 HTTPS，前端 4173）
  menu               交互菜单（无参数时自动进入）
  help               显示此帮助

start/restart/backend 选项:
      --build             启动前执行构建
      --https             使用 HTTPS（后端 HTTPS，前端仍为 4173）

端口: 后端默认取 .env 的 PORT（否则 3333），前端固定 4173
EOF
}

# ==================== 交互菜单 ====================

do_menu() {
  while true; do
    clear 2>/dev/null || true
    echo "========================================"
    echo "  ZViewer 生产服务管理"
    echo "========================================"
    echo ""
    echo "  1) 启动服务"
    echo "  2) 仅启动后端"
    echo "  3) 停止服务"
    echo "  4) 重启服务"
    echo "  5) 查看状态"
    echo "  6) 查看日志"
    echo "  7) 构建前后端"
    echo "  8) 一键签发 SSL 证书"
    echo "  9) HTTPS 启动（自动签发证书）"
    echo "  0) 退出"
    echo ""
    printf "请输入编号 (0-9): "
    read CHOICE
    case "$CHOICE" in
      1) BACKEND_ONLY=0; HTTPS_MODE=0; cmd_start; wait_key ;;
      2) BACKEND_ONLY=1
        printf "  请选择类型 (1=HTTP 2=HTTPS，直接回车默认 HTTP): "
        read BO_CHOICE
        if [ "$BO_CHOICE" = "2" ]; then HTTPS_MODE=1; else HTTPS_MODE=0; fi
        cmd_start; wait_key ;;
      3) cmd_stop; wait_key ;;
      4) cmd_restart; wait_key ;;
      5) cmd_status; wait_key ;;
      6) cmd_logs; wait_key ;;
      7) cmd_build; wait_key ;;
      8) do_cert; wait_key ;;
      9) do_https; wait_key ;;
      0) return 0 ;;
      *) echo "  无效输入，请重新选择"; sleep 1 ;;
    esac
  done
}

wait_key() {
  echo ""
  printf "按回车返回菜单: "
  read _DUMMY
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --build) DO_BUILD=1; shift ;;
      --https) HTTPS_MODE=1; shift ;;
      *) echo "  未知参数: $1" >&2; usage; exit 1 ;;
    esac
  done
}

# ==================== 入口 ====================

main() {
  local cmd="${1:-menu}"
  shift || true

  case "$cmd" in
    start)
      parse_args "$@"
      cmd_start
      ;;
    backend)
      parse_args "$@"
      BACKEND_ONLY=1
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
    cert)
      do_cert
      ;;
    https)
      do_https
      ;;
    menu)
      do_menu
      ;;
    help|--help|-h|*)
      usage
      ;;
  esac
}

main "$@"
