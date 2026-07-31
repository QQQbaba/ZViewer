@echo off
setlocal

:: =============================================
::  ZViewer Build Launcher
::
::  Pure-ASCII forwarder. All interactive menus and
::  Chinese output are handled by build-all.js
::  (Node.js readline), which is immune to the
::  cmd.exe set /p + parenthesized-block + codepage
::  parsing bugs that crash batch files.
:: =============================================

set "ROOT=%~dp0"
set "JS=%ROOT%build-all.js"

:: Force UTF-8 codepage so build-all.js (saved as UTF-8)
:: renders its Chinese text correctly. This also undoes
:: any chcp left by other scripts running earlier in the same console.
chcp 65001 >nul 2>&1

:: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Forward all arguments (e.g. --win, --mac, --linux, --all, --skip-build, --custom ...)
if "%~1"=="" (
    node "%JS%"
) else (
    node "%JS%" %*
)

endlocal & exit /b %ERRORLEVEL%
