#!/usr/bin/env pwsh
#Requires -Version 5.1

# ZViewer 一键启动脚本（单文件 exe 版，Windows）
# 命令：start | backend | stop | restart | status | logs | cert | https | help | menu

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'backend', 'stop', 'restart', 'status', 'logs', 'cert', 'https', 'help', 'menu', '')]
    [string]$Command = 'menu',

    [Parameter(Position = 1)]
    [string]$HostArg = '',            # cert/https 的域名或 IP（缺省则交互选择）

    [switch]$Force,                   # 证书强制重新签发
    [switch]$Https                    # start 时使用 HTTPS（后端 HTTPS，前端仍为 4173）
)

$ErrorActionPreference = "Stop"

# Force UTF-8 console output so Chinese text renders correctly
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$backendExe = Join-Path $rootDir "zviewer-backend.exe"
$frontendExe = Join-Path $rootDir "zviewer-frontend.exe"
$certExe = Join-Path $rootDir "zviewer-cert.exe"
$logDir = Join-Path $rootDir "log"
$pidsFile = Join-Path $rootDir ".prod.pids.json"
$envFile = Join-Path $rootDir ".env"

# ==================== 工具函数 ====================

function Read-PidsFile {
    if (-not (Test-Path $pidsFile)) { return $null }
    try { return Get-Content $pidsFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-PidsFile($backendPid, $frontendPid) {
    @{
        backend  = @{ pid = $backendPid }
        frontend = @{ pid = $frontendPid }
    } | ConvertTo-Json -Depth 3 | Set-Content -Path $pidsFile -Encoding UTF8
}

function Test-PortInUse($localPort) {
    $conn = Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $conn
}

# 等待端口开始监听（后端初始化需要数秒，避免前端先就绪后页面请求被拒）
function Wait-PortReady {
    param([int]$Port, [int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortInUse $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Stop-ProcessByPort($localPort) {
    $conn = Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn -and $conn.OwningProcess) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

# 从 .env 读取 PORT（与后端 dotenv 行为一致）
# 端口固定：后端 3333，前端 4173
function Set-Ports {
    $script:BackendPort = 3333
    $script:FrontendPort = 4173
}

function Test-Exe([string]$Exe, [string]$Name) {
    if (-not (Test-Path $Exe)) {
        Write-Host "  [错误] 未找到 $Name : $Exe" -ForegroundColor Red
        Write-Host "         请先运行 build-all 编译（含单文件可执行程序）"
        return $false
    }
    return $true
}

# 解析端口：显式参数 > 持久化 > .env / 默认
# ==================== 证书 ====================

# 交互选择证书签发类型（localhost / 域名或公网 IP）
function Select-CertHost {
    Write-Host ""
    Write-Host "  请选择证书签发类型："
    Write-Host "    [1] localhost（本机访问，默认，自签证书）"
    Write-Host "    [2] 域名或公网 IP（如 example.com 或 1.2.3.4）"
    Write-Host "        - 域名和公网 IP 将自动申请 Let's Encrypt 可信 CA 证书"
    Write-Host "          （需已指向本机且 80 端口可访问）"
    Write-Host "        - 内网 IP 使用自签证书"
    $choice = Read-Host "  请输入 1 或 2（直接回车默认 1）"
    if ($choice -eq '2') {
        $hostValue = Read-Host "  请输入域名或公网 IP 地址"
        if ([string]::IsNullOrWhiteSpace($hostValue)) {
            Write-Host "  [提示] 未输入地址，将使用 localhost"
            return 'localhost'
        }
        Write-Host ""
        Write-Host "  [提示] 域名和公网 IP 将自动申请 Let's Encrypt 可信 CA 证书；"
        Write-Host "         若无法申请（未解析 / 80 端口不可达），可改输入内网 IP 或 localhost 使用自签证书。"
        return $hostValue.Trim()
    }
    return 'localhost'
}

# 执行签发：zviewer-cert.exe [host] [--force]
# 注意：不 return 退出码（exe 的 stdout 会混入函数返回值），调用方读取 $LASTEXITCODE
function Invoke-CertIssue([string]$CertHost, [switch]$IsForce) {
    if (-not (Test-Exe $certExe "证书工具 zviewer-cert.exe")) { $script:CertExitCode = 1; return }
    $certArgs = @()
    if ($CertHost) { $certArgs += $CertHost }
    if ($IsForce) { $certArgs += '--force' }
    Write-Host "  [证书] 签发类型: $CertHost"
    & $certExe @certArgs
    $script:CertExitCode = $LASTEXITCODE
}

function Invoke-Cert {
    $certHost = if ($HostArg) { $HostArg } else { Select-CertHost }
    Invoke-CertIssue -CertHost $certHost -IsForce:$Force
    $code = $script:CertExitCode
    Write-Host ""
    if ($code -ne 0) {
        Write-Host "  [证书] 签发失败（退出码 $code）" -ForegroundColor Red
    } else {
        Write-Host "  [证书] 签发完成，证书位于 config/ssl/" -ForegroundColor Green
    }
    return $code
}

# ==================== 启动 ====================

# 以指定环境变量启动 exe（兼容 Windows PowerShell 5.1，启动后恢复原环境）
function Start-ExeWithEnv([string]$FilePath, [hashtable]$EnvVars, [string]$OutFile, [string]$ErrFile) {
    $saved = @{}
    foreach ($k in $EnvVars.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, [string]$EnvVars[$k], 'Process')
    }
    try {
        return Start-Process -FilePath $FilePath -WorkingDirectory $rootDir -WindowStyle Hidden  `
            -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -PassThru
    } finally {
        foreach ($k in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process')
        }
    }
}

function Invoke-Start([switch]$BackendOnly) {
    Set-Ports

    Write-Host "========================================"
    Write-Host "  ZViewer 启动"
    Write-Host "  后端端口: $BackendPort"
    if ($Https) {
        Write-Host "  模式: HTTPS（可信/自签证书）"
        Write-Host "  前端端口: $FrontendPort"
    } elseif ($BackendOnly) {
        Write-Host "  模式: 仅后端（HTTP）"
    } else {
        Write-Host "  前端端口: $FrontendPort"
    }
    Write-Host "========================================"

    if (-not (Test-Exe $backendExe "后端程序 zviewer-backend.exe")) { return 1 }
    if (-not $BackendOnly -and -not (Test-Exe $frontendExe "前端程序 zviewer-frontend.exe")) { return 1 }

    if (Test-PortInUse $BackendPort) {
        Write-Host "  [错误] 后端端口 $BackendPort 已被占用" -ForegroundColor Red
        return 1
    }
    if (-not $BackendOnly -and (Test-PortInUse $FrontendPort)) {
        Write-Host "  [错误] 前端端口 $FrontendPort 已被占用" -ForegroundColor Red
        return 1
    }

    # HTTPS 模式：先签发证书
    if ($Https) {
        if (-not (Test-Exe $certExe "证书工具 zviewer-cert.exe")) { return 1 }
        $certHost = if ($HostArg) { $HostArg } else { Select-CertHost }
        Invoke-CertIssue -CertHost $certHost -IsForce:$Force
        $code = $script:CertExitCode
        if ($code -ne 0) {
            Write-Host "  [证书] 签发失败，HTTPS 启动中止" -ForegroundColor Red
            return 1
        }
    }

    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    "" | Set-Content "$logDir/backend.log" -Encoding UTF8
    "" | Set-Content "$logDir/backend.err.log" -Encoding UTF8
    if (-not $BackendOnly) {
        "" | Set-Content "$logDir/frontend.log" -Encoding UTF8
        "" | Set-Content "$logDir/frontend.err.log" -Encoding UTF8
    }

    Write-Host "  启动后端..."
    $backendEnv = @{
        PORT = "$BackendPort"
        NODE_ENV = "production"
        HOST = "::"
    }
    if ($Https) { $backendEnv.HTTPS = "true" }
    $backend = Start-ExeWithEnv -FilePath $backendExe -EnvVars $backendEnv  `
        -OutFile "$logDir/backend.log" -ErrFile "$logDir/backend.err.log"

    # 等待后端就绪（TypeORM 初始化 + NMS 启动需要数秒），
    # 避免前端先就绪时页面请求被 ECONNREFUSED
    Write-Host "  等待后端就绪..."
    if (-not (Wait-PortReady $BackendPort)) {
        Write-Host "  错误：后端在 30 秒内未就绪，请检查日志: $logDir\backend.err.log" -ForegroundColor Red
        Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
        exit 1
    }

    if ($Https) {
        # HTTPS 模式：后端使用 HTTPS，前端单独启动在 4173 端口
        Write-Host "  启动前端..."
        $frontendEnv = @{
            PORT = "$FrontendPort"
            BACKEND_URL = "https://localhost:$BackendPort"
            HOST = "0.0.0.0"
        }
        $frontend = Start-ExeWithEnv -FilePath $frontendExe -EnvVars $frontendEnv  `
            -OutFile "$logDir/frontend.log" -ErrFile "$logDir/frontend.err.log"

        Write-PidsFile -backendPid $backend.Id -frontendPid $frontend.Id
        Write-Host "  后端 PID: $($backend.Id)"
        Write-Host "  前端 PID: $($frontend.Id)"
        Write-Host "  HTTPS 后端: https://localhost:$BackendPort"
        Write-Host "  访问  : http://localhost:$FrontendPort"
        Write-Host "  日志  : $logDir/"
    } elseif ($BackendOnly) {
        # 仅后端模式：不启动前端
        Write-PidsFile -backendPid $backend.Id -frontendPid $null
        Write-Host "  后端 PID: $($backend.Id)"
        Write-Host "  访问  : http://localhost:$BackendPort   （仅后端，未启动前端）"
        Write-Host "  日志  : $logDir/"
    } else {
        Write-Host "  启动前端..."
        $frontendEnv = @{
            PORT = "$FrontendPort"
            BACKEND_URL = "http://localhost:$BackendPort"
            HOST = "0.0.0.0"
        }
        $frontend = Start-ExeWithEnv -FilePath $frontendExe -EnvVars $frontendEnv  `
            -OutFile "$logDir/frontend.log" -ErrFile "$logDir/frontend.err.log"

        Write-PidsFile -backendPid $backend.Id -frontendPid $frontend.Id
        Write-Host "  后端 PID: $($backend.Id)"
        Write-Host "  前端 PID: $($frontend.Id)"
        Write-Host "  访问  : http://localhost:$FrontendPort"
        Write-Host "  日志  : $logDir/"
    }
    return 0
}

# ==================== 停止 / 重启 / 状态 / 日志 ====================

function Invoke-Stop {
    $existing = Read-PidsFile
    if ($existing) {
        if ($existing.backend -and $existing.backend.pid) {
            Stop-Process -Id $existing.backend.pid -Force -ErrorAction SilentlyContinue
        }
        if ($existing.frontend -and $existing.frontend.pid) {
            Stop-Process -Id $existing.frontend.pid -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $pidsFile -Force -ErrorAction SilentlyContinue
    }
    # 兜底：按端口清理
    Set-Ports
    Stop-ProcessByPort $BackendPort
    Stop-ProcessByPort $FrontendPort
    Write-Host "  已停止"
}

function Invoke-Restart {
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
}

function Invoke-Status {
    Write-Host "========================================"
    Write-Host "  ZViewer 运行状态"
    Write-Host "========================================"

    Set-Ports
    $existing = Read-PidsFile
    $backendRunning = $false
    $frontendRunning = $false
    if ($existing -and $existing.backend -and $existing.backend.pid) {
        $backendRunning = $null -ne (Get-Process -Id $existing.backend.pid -ErrorAction SilentlyContinue)
    }
    if ($existing -and $existing.frontend -and $existing.frontend.pid) {
        $frontendRunning = $null -ne (Get-Process -Id $existing.frontend.pid -ErrorAction SilentlyContinue)
    }

    $backendListen = Test-PortInUse $BackendPort
    $frontendListen = Test-PortInUse $FrontendPort

    Write-Host "  后端:"
    Write-Host "    配置端口: $BackendPort"
    Write-Host "    端口监听: $(if ($backendListen) { '是' } else { '否' })"
    if ($existing -and $existing.backend -and $existing.backend.pid) {
        Write-Host "    记录 PID: $($existing.backend.pid) ($(if ($backendRunning) { '运行中' } else { '未运行' }))"
    }

    Write-Host "  前端:"
    Write-Host "    配置端口: $FrontendPort"
    if ($existing -and $existing.frontend -and $existing.frontend.pid) {
        Write-Host "    端口监听: $(if ($frontendListen) { '是' } else { '否' })"
        Write-Host "    记录 PID: $($existing.frontend.pid) ($(if ($frontendRunning) { '运行中' } else { '未运行' }))"
    } elseif ($existing -and $null -eq $existing.frontend) {
        Write-Host "    模式: 仅后端 / HTTPS（未启动前端）"
    } else {
        Write-Host "    端口监听: $(if ($frontendListen) { '是' } else { '否' })"
    }

    Write-Host "  程序:"
    Write-Host "    后端: $(if (Test-Path $backendExe) { '存在' } else { '缺失' })"
    Write-Host "    前端: $(if (Test-Path $frontendExe) { '存在' } else { '缺失' })"
    Write-Host "    证书: $(if (Test-Path (Join-Path $rootDir 'config\ssl\cert.pem')) { '存在' } else { '缺失' })"
}

function Invoke-Logs {
    param([string]$LogTarget)
    if (-not $LogTarget) { $LogTarget = $HostArg }
    if (-not $LogTarget) { $LogTarget = 'backend' }
    $logFile = if ($LogTarget -eq 'frontend') { "$logDir/frontend.log" } else { "$logDir/backend.log" }
    if (Test-Path $logFile) {
        Get-Content $logFile -Tail 50
    } else {
        Write-Host "  日志不存在: $logFile"
    }
}

# ==================== 帮助 / 菜单 ====================

function Show-Help {
    Write-Host "用法: .\start.bat {start|backend|stop|restart|status|logs|cert|https|help|menu} [选项]"
    Write-Host ""
    Write-Host "命令:"
    Write-Host "  start              启动服务（HTTP 前后端；加 -Https 使用 HTTPS）"
    Write-Host "  backend            仅启动后端（加 -Https 使用 HTTPS）"
    Write-Host "  stop               停止服务"
    Write-Host "  restart            重启服务"
    Write-Host "  status             查看运行状态"
    Write-Host "  logs [backend|frontend]  查看日志（默认 backend）"
    Write-Host "  cert [host]        一键签发 SSL 证书（localhost / 域名(Let's Encrypt) / 公网 IP）"
    Write-Host "  https [host]       签发证书后以 HTTPS 启动（后端 HTTPS，前端 4173）"
    Write-Host "  help               显示此帮助"
    Write-Host "  menu               交互菜单（无参数时自动进入）"
    Write-Host ""
    Write-Host "start/restart/cert/https 选项:"
    Write-Host "  -Https                    start 时使用 HTTPS（后端 HTTPS，前端仍为 4173）"
    Write-Host "  -Force                    证书强制重新签发"
    Write-Host ""
    Write-Host "端口: 后端 3333，前端 4173"
    Write-Host ""
    Write-Host "示例:"
    Write-Host "  start.bat                  # 交互菜单"
    Write-Host "  start.bat start            # HTTP 启动（前后端）"
    Write-Host "  start.bat backend          # 仅启动后端"
    Write-Host "  start.bat https example.com  # 申请 Let's Encrypt 证书后 HTTPS 启动"
    Write-Host "  start.bat cert 1.2.3.4 -Force  # 为公网 IP 强制重新签发 Let's Encrypt 证书"
}

function Show-Menu {
    while ($true) {
        Clear-Host
        Write-Host "========================================"
        Write-Host "  ZViewer 服务管理（单文件版）"
        Write-Host "========================================"
        Write-Host ""
        Write-Host "  1) 启动服务 (HTTP)"
        Write-Host "  2) 仅启动后端"
        Write-Host "  3) 停止服务"
        Write-Host "  4) 重启服务"
        Write-Host "  5) 查看状态"
        Write-Host "  6) 查看日志"
        Write-Host "  7) 一键签发 SSL 证书"
        Write-Host "  8) HTTPS 启动（自动签发证书，前后端分离）"
        Write-Host "  0) 退出"
        Write-Host ""
        $choice = Read-Host "  请输入编号 (0-8)"
        switch ($choice) {
            '1' { $script:Https = $false; Invoke-Start; Wait-MenuKey }
            '2' {
                $boChoice = Read-Host "  请选择类型 (1=HTTP 2=HTTPS，直接回车默认 HTTP)"
                if ($boChoice -eq '2') { $script:Https = $true } else { $script:Https = $false }
                Invoke-Start -BackendOnly
                Wait-MenuKey
            }
            '3' { Invoke-Stop; Wait-MenuKey }
            '4' { Invoke-Restart; Wait-MenuKey }
            '5' { Invoke-Status; Wait-MenuKey }
            '6' { Invoke-Logs; Wait-MenuKey }
            '7' { Invoke-Cert; Wait-MenuKey }
            '8' { $script:Https = $true; Invoke-Start; Wait-MenuKey }
            '0' { return }
            default { Write-Host "  无效输入，请重新选择"; Start-Sleep -Milliseconds 800 }
        }
    }
}

function Wait-MenuKey {
    Write-Host ""
    Read-Host "  按回车返回菜单" | Out-Null
}

# ==================== 入口 ====================

switch ($Command) {
    'start'   { exit (Invoke-Start) }
    'backend' { exit (Invoke-Start -BackendOnly) }
    'stop'    { Invoke-Stop; exit 0 }
    'restart' { Invoke-Restart; exit 0 }
    'status'  { Invoke-Status; exit 0 }
    'logs'    { Invoke-Logs; exit 0 }
    'cert'    { exit (Invoke-Cert) }
    'https'   { $script:Https = $true; exit (Invoke-Start) }
    'menu'    { Show-Menu }
    default   { Show-Help }
}
