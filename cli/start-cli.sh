#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

EXE_DIR=""
EXE_NAME=""

if [ -f "./zviewer-cli-macos-arm64" ]; then
  EXE_DIR="."
  EXE_NAME="zviewer-cli-macos-arm64"
elif [ -f "./release/zviewer-cli-macos-arm64" ]; then
  EXE_DIR="release"
  EXE_NAME="zviewer-cli-macos-arm64"
elif [ -f "./zviewer-cli-macos-x64" ]; then
  EXE_DIR="."
  EXE_NAME="zviewer-cli-macos-x64"
elif [ -f "./release/zviewer-cli-macos-x64" ]; then
  EXE_DIR="release"
  EXE_NAME="zviewer-cli-macos-x64"
elif [ -f "./zviewer-cli-linux-x64" ]; then
  EXE_DIR="."
  EXE_NAME="zviewer-cli-linux-x64"
elif [ -f "./release/zviewer-cli-linux-x64" ]; then
  EXE_DIR="release"
  EXE_NAME="zviewer-cli-linux-x64"
fi

if [ -n "$EXE_DIR" ]; then
  echo "[ZViewer CLI] 检测到可执行文件，正在启动本地配置页..."
  chmod +x "$EXE_DIR/$EXE_NAME"
  "$EXE_DIR/$EXE_NAME" setup
  echo ""
  echo "[ZViewer CLI] 服务已退出。"
  read -n 1 -s -r -p "按任意键继续..."
  echo ""
  exit 0
fi

echo "[ZViewer CLI] 未检测到可执行文件，正在检查 Node.js 环境..."

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 Node.js 后再运行。"
  read -n 1 -s -r -p "按任意键继续..."
  echo ""
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[错误] 未检测到 npm，请确认 Node.js 安装完整。"
  read -n 1 -s -r -p "按任意键继续..."
  echo ""
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[ZViewer CLI] 检测到依赖未安装，正在执行 npm install..."
  npm install
fi

echo "[ZViewer CLI] 正在启动本地配置页..."
if [ -f "dist/index.js" ]; then
  node dist/index.js setup
else
  npm run dev -- setup
fi

echo ""
echo "[ZViewer CLI] 服务已退出。"
read -n 1 -s -r -p "按任意键继续..."
echo ""
