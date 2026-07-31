@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

echo ========================================
echo   ZViewer 一键启动 (Windows)
echo ========================================

:: ---------- 配置区（可在此手动覆盖） ----------
:: 后端端口优先级: PORT_OVERRIDE > .env 中的 PORT > DEFAULT_PORT
set "DEFAULT_PORT=3333"
set "PORT_OVERRIDE="
:: 前端代理的后端地址（留空则按 PORT 自动生成，如 http://localhost:3333）
set "BACKEND_URL_OVERRIDE="
:: ---------------------------------------------

if not exist "zviewer-backend.exe" (
  echo [ERROR] 未找到 zviewer-backend.exe
  pause
  exit /b 1
)
if not exist "zviewer-frontend.exe" (
  echo [ERROR] 未找到 zviewer-frontend.exe
  pause
  exit /b 1
)

:: 从 .env 读取 PORT（若存在）
set "CFG_PORT="
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" if not "%%b"=="" set "CFG_PORT=%%b"
  )
)
:: 去掉引号与首尾空格
if defined CFG_PORT set "CFG_PORT=%CFG_PORT:"=%"
if defined CFG_PORT for /f "tokens=* delims= " %%t in ("%CFG_PORT%") do set "CFG_PORT=%%t"

:: 确定最终 PORT 与前端代理地址
set "PORT=%DEFAULT_PORT%"
if defined PORT_OVERRIDE set "PORT=%PORT_OVERRIDE%"
if not defined PORT_OVERRIDE if not "%CFG_PORT%"=="" set "PORT=%CFG_PORT%"
set "BACKEND_URL=http://localhost:%PORT%"
if defined BACKEND_URL_OVERRIDE set "BACKEND_URL=%BACKEND_URL_OVERRIDE%"

:: 启动服务（最小化窗口，日志在各自窗口内实时输出）
start "ZViewer-Backend" /min zviewer-backend.exe
start "ZViewer-Frontend" /min zviewer-frontend.exe

echo.
echo   ZViewer 已启动
echo   后端  : http://localhost:%PORT%
echo   前端  : %BACKEND_URL%
echo.
echo 提示: 关闭对应最小化窗口即可停止服务
pause
