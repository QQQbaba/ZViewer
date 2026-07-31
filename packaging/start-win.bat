@echo off
setlocal

:: Set console to UTF-8 so the PowerShell script's Chinese output displays correctly
chcp 65001 >nul 2>&1

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "PS1=%ROOT%\start.ps1"
if not exist "%PS1%" set "PS1=%ROOT%\start-win.ps1"

:: Check PowerShell
where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERROR] PowerShell not found. Please install Windows PowerShell.
  pause
  exit /b 1
)

:: Check start-win.ps1 exists
if not exist "%PS1%" (
  echo [ERROR] File not found: %PS1%
  pause
  exit /b 1
)

:: All output (including Chinese menu) is handled by PowerShell,
:: because cmd.exe parses .bat bytes with the system ANSI codepage (GBK on zh-CN),
:: which breaks UTF-8 Chinese characters even with `chcp 65001`.
:: This .bat is a pure forwarder - no Chinese here.

:: Double-click (no args) -> interactive menu; keep the window open.
:: Explicit args are forwarded unchanged (e.g. start.bat status).
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" menu
  pause
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
)

endlocal
exit /b %ERRORLEVEL%
