#!/bin/sh
# ZViewer 一键启动脚本（单文件 exe 版，Linux）
# 命令：start | stop | restart | status | logs | cert | https | help | menu
# 无参数时进入交互菜单。

cd "$(dirname "$0")" || exit 1

ROOT_DIR=$(pwd)
BACKEND_BIN="$ROOT_DIR/zviewer-backend"
FRONTEND_BIN="$ROOT_DIR/zviewer-frontend"
CERT_BIN="$ROOT_DIR/zviewer-cert"
LOG_DIR="$ROOT_DIR/log"
PIDS_FILE="$ROOT_DIR/.prod.pids.json"
ENV_FILE="$ROOT_DIR/.env"

DEFAULT_PORT=3333
DEFAULT_FRONTEND_PORT=4173
BACKEND_PORT=""
FRONTEND_PORT=""
BACKEND_ONLY=0
HTTPS_MODE=0
CERT_HOST=""
CERT_FORCE=""

# ==================== 工具函数 ====================

# 从 .env 读取 PORT
# 端口固定：后端 3333，前端 4173
resolve_ports() {
  if [ -z "$BACKEND_PORT" ]; then
    BACKEND_PORT="$DEFAULT_PORT"
  fi
  if [ -z "$FRONTEND_PORT" ]; then
    FRONTEND_PORT="$DEFAULT_FRONTEND_PORT"
  fi
}

write_pids() {
  # $1=backend_pid $2=frontend_pid（可为空）
  if [ -n "$2" ]; then
    printf '{"backend":{"pid":%s},"frontend":{"pid":%s}}\n' "$1" "$2" > "$PIDS_FILE"
  else
    printf '{"backend":{"pid":%s},"frontend":null}\n' "$1" > "$PIDS_FILE"
  fi
}

read_pid() { # $1=backend|frontend
  [ -f "$PIDS_FILE" ] || return 1
  sed -n "s/.*\"$1\":{\"pid\":\([0-9][0-9]*\).*/\1/p" "$PIDS_FILE" | head -n 1
}

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -lnt "sport = :$port" 2>/dev/null | grep -q LISTEN
  else
    return 1
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

kill_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "$port/tcp" >/dev/null 2>&1
  fi
}

has_exe() {
  if [ ! -f "$1" ]; then
    echo "  [错误] 未找到 $2 : $1"
    echo "         请先运行 build-all 编译（含单文件可执行程序）"
    return 1
  fi
  return 0
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

issue_cert() {
  # 返回码由 $CERT_RC 携带
  if ! has_exe "$CERT_BIN" "证书工具 zviewer-cert"; then CERT_RC=1; return; fi
  echo "  [证书] 签发类型: $CERT_HOST"
  if [ -n "$CERT_FORCE" ]; then
    "$CERT_BIN" "$CERT_HOST" --force
  else
    "$CERT_BIN" "$CERT_HOST"
  fi
  CERT_RC=$?
}

do_cert() {
  if [ -z "$CERT_HOST" ]; then
    select_cert_host
  fi
  issue_cert
  echo ""
  if [ "$CERT_RC" -ne 0 ]; then
    echo "  [证书] 签发失败（退出码 $CERT_RC）"
    return 1
  fi
  echo "  [证书] 签发完成，证书位于 config/ssl/"
  return 0
}

# ==================== 启动 ====================

do_start() {
  resolve_ports
  echo "========================================"
  echo "  ZViewer 启动"
  echo "  后端端口: $BACKEND_PORT"
  if [ "$HTTPS_MODE" -eq 1 ]; then
    echo "  模式: HTTPS（可信/自签证书）"
    echo "  前端端口: $FRONTEND_PORT"
  elif [ "$BACKEND_ONLY" -eq 1 ]; then
    echo "  模式: 仅后端（HTTP）"
  else
    echo "  前端端口: $FRONTEND_PORT"
  fi
  echo "========================================"

  if ! has_exe "$BACKEND_BIN" "后端程序 zviewer-backend"; then return 1; fi
  if [ "$BACKEND_ONLY" -ne 1 ] && ! has_exe "$FRONTEND_BIN" "前端程序 zviewer-frontend"; then return 1; fi

  if port_in_use "$BACKEND_PORT"; then
    echo "  [错误] 后端端口 $BACKEND_PORT 已被占用"
    return 1
  fi
  if [ "$BACKEND_ONLY" -ne 1 ] && port_in_use "$FRONTEND_PORT"; then
    echo "  [错误] 前端端口 $FRONTEND_PORT 已被占用"
    return 1
  fi

  # HTTPS 模式：先签发证书
  if [ "$HTTPS_MODE" -eq 1 ]; then
    if ! has_exe "$CERT_BIN" "证书工具 zviewer-cert"; then return 1; fi
    if [ -z "$CERT_HOST" ]; then
      select_cert_host
    fi
    issue_cert
    if [ "$CERT_RC" -ne 0 ]; then
      echo "  [证书] 签发失败，HTTPS 启动中止"
      return 1
    fi
  fi

  mkdir -p "$LOG_DIR"
  : > "$LOG_DIR/backend.log"
  : > "$LOG_DIR/backend.err.log"
  if [ "$BACKEND_ONLY" -ne 1 ]; then
    : > "$LOG_DIR/frontend.log"
    : > "$LOG_DIR/frontend.err.log"
  fi

  echo "  启动后端..."
  if [ "$HTTPS_MODE" -eq 1 ]; then
    PORT="$BACKEND_PORT" NODE_ENV=production HTTPS=true \
      nohup "$BACKEND_BIN" >> "$LOG_DIR/backend.log" 2>> "$LOG_DIR/backend.err.log" &
  else
    PORT="$BACKEND_PORT" NODE_ENV=production \
      nohup "$BACKEND_BIN" >> "$LOG_DIR/backend.log" 2>> "$LOG_DIR/backend.err.log" &
  fi
  local_backend_pid=$!

  # 等待后端就绪（TypeORM 初始化 + NMS 启动需要数秒），
  # 避免前端先就绪时页面请求被 ECONNREFUSED
  echo "  等待后端就绪..."
  if ! wait_port_ready "$BACKEND_PORT"; then
    echo "  错误：后端在 30 秒内未就绪，请检查日志: $LOG_DIR/backend.err.log" >&2
    kill "$local_backend_pid" 2>/dev/null || true
    return 1
  fi

  if [ "$HTTPS_MODE" -eq 1 ]; then
    # HTTPS 模式：后端使用 HTTPS，前端单独启动在 4173 端口
    echo "  启动前端..."
    PORT="$FRONTEND_PORT" BACKEND_URL="https://localhost:$BACKEND_PORT" HOST='0.0.0.0' \
      nohup "$FRONTEND_BIN" >> "$LOG_DIR/frontend.log" 2>> "$LOG_DIR/frontend.err.log" &
    local_frontend_pid=$!
    write_pids "$local_backend_pid" "$local_frontend_pid"
    echo "  后端 PID: $local_backend_pid"
    echo "  前端 PID: $local_frontend_pid"
    echo "  HTTPS 后端: https://localhost:$BACKEND_PORT"
    echo "  访问  : http://localhost:$FRONTEND_PORT"
    echo "  日志  : $LOG_DIR/"
  elif [ "$BACKEND_ONLY" -eq 1 ]; then
    # 仅后端模式：不启动前端
    write_pids "$local_backend_pid" ""
    echo "  后端 PID: $local_backend_pid"
    echo "  访问  : http://localhost:$BACKEND_PORT   （仅后端，未启动前端）"
    echo "  日志  : $LOG_DIR/"
  else
    echo "  启动前端..."
    PORT="$FRONTEND_PORT" BACKEND_URL="http://localhost:$BACKEND_PORT" HOST='0.0.0.0' \
      nohup "$FRONTEND_BIN" >> "$LOG_DIR/frontend.log" 2>> "$LOG_DIR/frontend.err.log" &
    local_frontend_pid=$!
    write_pids "$local_backend_pid" "$local_frontend_pid"
    echo "  后端 PID: $local_backend_pid"
    echo "  前端 PID: $local_frontend_pid"
    echo "  访问  : http://localhost:$FRONTEND_PORT"
    echo "  日志  : $LOG_DIR/"
  fi
  return 0
}

# ==================== 停止 / 重启 / 状态 / 日志 ====================

do_stop() {
  local bp fp
  bp=$(read_pid backend)
  fp=$(read_pid frontend)
  [ -n "$bp" ] && kill "$bp" 2>/dev/null
  [ -n "$fp" ] && kill "$fp" 2>/dev/null
  rm -f "$PIDS_FILE"
  resolve_ports
  kill_port "$BACKEND_PORT"
  kill_port "$FRONTEND_PORT"
  echo "  已停止"
}

do_restart() {
  do_stop
  sleep 1
  do_start
}

do_status() {
  echo "========================================"
  echo "  ZViewer 运行状态"
  echo "========================================"
  resolve_ports
  local bp fp backend_running frontend_running
  bp=$(read_pid backend)
  fp=$(read_pid frontend)
  backend_running="否"
  frontend_running="否"
  if [ -n "$bp" ] && kill -0 "$bp" 2>/dev/null; then backend_running="是"; fi
  if [ -n "$fp" ] && kill -0 "$fp" 2>/dev/null; then frontend_running="是"; fi

  echo "  后端:"
  echo "    配置端口: $BACKEND_PORT"
  echo "    端口监听: $(if port_in_use "$BACKEND_PORT"; then echo 是; else echo 否; fi)"
  if [ -n "$bp" ]; then
    echo "    记录 PID: $bp ($(if [ "$backend_running" = "是" ]; then echo 运行中; else echo 未运行; fi))"
  fi
  echo "  前端:"
  echo "    配置端口: $FRONTEND_PORT"
  if [ -n "$fp" ]; then
    echo "    端口监听: $(if port_in_use "$FRONTEND_PORT"; then echo 是; else echo 否; fi)"
    echo "    记录 PID: $fp ($(if [ "$frontend_running" = "是" ]; then echo 运行中; else echo 未运行; fi))"
  elif [ -f "$PIDS_FILE" ] && grep -q '"frontend":null' "$PIDS_FILE"; then
    echo "    模式: 仅后端（未启动前端）"
  else
    echo "    端口监听: $(if port_in_use "$FRONTEND_PORT"; then echo 是; else echo 否; fi)"
  fi
  echo "  程序:"
  echo "    后端: $(if [ -f "$BACKEND_BIN" ]; then echo 存在; else echo 缺失; fi)"
  echo "    前端: $(if [ -f "$FRONTEND_BIN" ]; then echo 存在; else echo 缺失; fi)"
  echo "    证书: $(if [ -f "$ROOT_DIR/config/ssl/cert.pem" ]; then echo 存在; else echo 缺失; fi)"
}

do_logs() {
  local target="$1"
  if [ -z "$target" ]; then target="backend"; fi
  local log_file
  if [ "$target" = "frontend" ]; then
    log_file="$LOG_DIR/frontend.log"
  else
    log_file="$LOG_DIR/backend.log"
  fi
  if [ -f "$log_file" ]; then
    tail -n 50 "$log_file"
  else
    echo "  日志不存在: $log_file"
  fi
}

# ==================== 帮助 / 菜单 ====================

usage() {
  cat <<EOF
用法: $0 {start|backend|stop|restart|status|logs|cert|https|help|menu} [选项]

命令:
  start              启动服务（HTTP 前后端；加 --https 使用 HTTPS）
  backend            仅启动后端（加 --https 使用 HTTPS）
  stop               停止服务
  restart            重启服务
  status             查看运行状态
  logs [backend|frontend]  查看日志（默认 backend）
  cert [host]        一键签发 SSL 证书（localhost / 域名(Let's Encrypt) / 公网 IP）
  https [host]       签发证书后以 HTTPS 启动（后端 HTTPS，前端 4173）
  help               显示此帮助
  menu               交互菜单（无参数时自动进入）

start/restart/cert/https 选项:
      --https              start 时使用 HTTPS（后端 HTTPS，前端仍为 4173）
      --force              证书强制重新签发

端口: 后端 3333，前端 4173

示例:
  ./start.sh                    # 交互菜单
  ./start.sh start              # HTTP 启动（前后端）
  ./start.sh backend            # 仅启动后端
  ./start.sh https example.com  # 申请 Let's Encrypt 证书后 HTTPS 启动
  ./start.sh cert 1.2.3.4 --force  # 为公网 IP 强制重新签发 Let's Encrypt 证书
EOF
}

do_menu() {
  while true; do
    clear 2>/dev/null || true
    echo "========================================"
    echo "  ZViewer 服务管理（单文件版）"
    echo "========================================"
    echo ""
    echo "  1) 启动服务 (HTTP)"
    echo "  2) 仅启动后端"
    echo "  3) 停止服务"
    echo "  4) 重启服务"
    echo "  5) 查看状态"
    echo "  6) 查看日志"
    echo "  7) 一键签发 SSL 证书"
    echo "  8) HTTPS 启动（自动签发证书）"
    echo "  0) 退出"
    echo ""
    printf "  请输入编号 (0-8): "
    read CHOICE
    case "$CHOICE" in
      1) BACKEND_ONLY=0; HTTPS_MODE=0; do_start; wait_key ;;
      2) BACKEND_ONLY=1
        printf "  请选择类型 (1=HTTP 2=HTTPS，直接回车默认 HTTP): "
        read BO_CHOICE
        if [ "$BO_CHOICE" = "2" ]; then HTTPS_MODE=1; else HTTPS_MODE=0; fi
        do_start; wait_key ;;
      3) do_stop; wait_key ;;
      4) do_restart; wait_key ;;
      5) do_status; wait_key ;;
      6) do_logs; wait_key ;;
      7) do_cert; wait_key ;;
      8) BACKEND_ONLY=0; HTTPS_MODE=1; do_start; wait_key ;;
      0) return 0 ;;
      *) echo "  无效输入，请重新选择"; sleep 1 ;;
    esac
  done
}

wait_key() {
  echo ""
  printf "  按回车返回菜单: "
  read _DUMMY
}

# ==================== 参数解析 ====================

# start/https 参数：--https/--force/host（端口已固定，不支持自定义）
parse_start_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --https) HTTPS_MODE=1; shift ;;
      --force) CERT_FORCE="--force"; shift ;;
      *)
        if [ -z "$CERT_HOST" ]; then
          CERT_HOST="$1"; shift
        else
          echo "  未知参数: $1" >&2
          exit 1
        fi
        ;;
    esac
  done
}

# cert 参数：host / --force
parse_cert_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --force|-f) CERT_FORCE="--force"; shift ;;
      *) CERT_HOST="$1"; shift ;;
    esac
  done
}

# ==================== 入口 ====================

CMD="${1:-menu}"
case "$CMD" in
  start)
    shift
    parse_start_args "$@"
    do_start
    ;;
  backend)
    shift
    parse_start_args "$@"
    BACKEND_ONLY=1
    do_start
    ;;
  stop)
    do_stop
    ;;
  restart)
    shift
    parse_start_args "$@"
    do_restart
    ;;
  status)
    do_status
    ;;
  logs)
    do_logs "${2:-backend}"
    ;;
  cert)
    shift
    parse_cert_args "$@"
    do_cert
    ;;
  https)
    shift
    HTTPS_MODE=1
    parse_start_args "$@"
    do_start
    ;;
  help|--help|-h)
    usage
    ;;
  menu)
    do_menu
    ;;
  *)
    usage
    ;;
esac

exit 0
