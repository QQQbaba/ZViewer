@echo off
setlocal

:: Set console to UTF-8 so the PowerShell script's Chinese output displays correctly
chcp 65001 >nul 2>&1

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "PS1=%ROOT%\release-zip.ps1"

:: Check PowerShell
where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERROR] PowerShell not found. Please install Windows PowerShell.
  pause
  exit /b 1
)

:: Check release-zip.ps1 exists
if not exist "%PS1%" (
  echo [ERROR] File not found: %PS1%
  pause
  exit /b 1
)

:: All output (including Chinese) is handled by PowerShell,
:: because cmd.exe parses .bat bytes with the system ANSI codepage (GBK on zh-CN),
:: which breaks UTF-8 Chinese characters even with `chcp 65001`.
:: This .bat is a pure forwarder - no Chinese here.

:: Double-click (no args) -> run the packaging; keep the window open so the result is visible.
:: Explicit args are forwarded unchanged (e.g. release-zip.bat -Help).
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
  pause
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
)

endlocal
exit /b %ERRORLEVEL%
