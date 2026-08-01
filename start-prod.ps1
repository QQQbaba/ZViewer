#!/usr/bin/env pwsh
#Requires -Version 5.1

# ZViewer 一键启动脚本
# 命令：start | backend | stop | restart | status | logs | build | help

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'backend', 'cert', 'https', 'stop', 'restart', 'status', 'logs', 'build', 'help', 'menu', '')]
    [string]$Command = 'menu',

    [Parameter(Position = 1)]
    [ValidateSet('backend', 'frontend', '')]
    [string]$Target = '',

    [switch]$Build,            # 启动前构建
    [switch]$Https             # 使用自签 HTTPS
)

$ErrorActionPreference = "Stop"

# Force UTF-8 console output so Chinese text renders correctly
# regardless of the system's default OEM codepage (GBK on zh-CN).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$backendDir = Join-Path $rootDir "backend"
$frontendDir = Join-Path $rootDir "frontend"
$logDir = Join-Path $rootDir "log"
$pidsFile = Join-Path $rootDir ".prod.pids.json"
$envFile = Join-Path $rootDir ".env"

# ==================== 工具函数 ====================

function Read-EnvPort {
    if (-not (Test-Path $envFile)) { return $null }
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -First 1
    if (-not $line) { return $null }
    $val = ($line -split '=', 2)[1].Trim().Trim('"').Trim()
    if ($val -match '^\d+$') { return [int]$val }
    return $null
}

function Read-PidsFile {
    if (-not (Test-Path $pidsFile)) { return $null }
    try { return Get-Content $pidsFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-PidsFile($backendPid, $frontendPid) {
    @{
        backend = @{ pid = $backendPid }
        frontend = @{ pid = $frontendPid }
    } | ConvertTo-Json -Depth 3 | Set-Content -Path $pidsFile -Encoding UTF8
}

function Test-PortInUse($localPort) {
    $conn = Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $conn
}

function Stop-ProcessByPort($localPort) {
    $conn = Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn -and $conn.OwningProcess) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

function Test-DepsInstalled {
    return (Test-Path (Join-Path $rootDir "node_modules")) -and
           (Test-Path (Join-Path $rootDir "node_modules\express")) -and
           (Test-Path (Join-Path $rootDir "node_modules\better-sqlite3")) -and
           (Test-Path (Join-Path $rootDir "node_modules\typeorm"))
}

function Install-Deps {
    if (Test-DepsInstalled) {
        Write-Host "  依赖已安装"
        return
    }
    Write-Host "  安装依赖..."
    Push-Location $rootDir
    try {
        npm ci --no-audit --no-fund --prefer-offline --include=dev
        if ($LASTEXITCODE -ne 0) {
            npm install --no-audit --no-fund --include=dev
        }
    } finally {
        Pop-Location
    }
}

function Test-SqliteOk {
    try {
        node -e "require('better-sqlite3')" 2>$null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Rebuild-Sqlite {
    if (Test-SqliteOk) { return }
    Write-Host "  better-sqlite3 原生模块缺失，重建中..."
    Push-Location $rootDir
    try { npm rebuild better-sqlite3 } finally { Pop-Location }
}

function Resolve-ViteJs {
    $candidates = @(
        (Join-Path $rootDir "node_modules\vite\bin\vite.js"),
        (Join-Path $frontendDir "node_modules\vite\bin\vite.js")
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Build-Projects {
    Write-Host "  构建后端..."
    Push-Location $backendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "后端构建失败" }
    } finally { Pop-Location }

    Write-Host "  构建前端..."
    Push-Location $frontendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
    } finally { Pop-Location }

    Write-Host "  构建完成"
}

# ==================== 命令 ====================

function Set-Ports {
    $envPort = Read-EnvPort
    $script:Port = if ($envPort) { $envPort } else { 3333 }
    $script:FrontendPort = 4173
}

function Invoke-Start {
    param([switch]$BackendOnly)
    Set-Ports

    Write-Host "========================================"
    Write-Host "  ZViewer 启动"
    Write-Host "  后端端口: $Port"
    if ($Https) {
      Write-Host "  模式: HTTPS（自签/可信证书）"
      Write-Host "  前端: 由后端统一提供"
    } elseif ($BackendOnly) {
      Write-Host "  模式: 仅后端（HTTP）"
    } else {
      Write-Host "  前端端口: $FrontendPort"
    }
    Write-Host "========================================"

    if (Test-PortInUse $Port) {
        Write-Host "  错误：后端端口 $Port 已被占用" -ForegroundColor Red
        exit 1
    }
    if (-not $Https -and -not $BackendOnly -and (Test-PortInUse $FrontendPort)) {
        Write-Host "  错误：前端端口 $FrontendPort 已被占用" -ForegroundColor Red
        exit 1
    }

    Install-Deps
    Rebuild-Sqlite

    if ($Build) {
        Build-Projects
    } else {
        Write-Host "  跳过构建（如需构建请加 -Build）"
    }

    $backendArtifact = Join-Path $backendDir "dist/index.js"
    $frontendArtifact = Join-Path $frontendDir "dist/index.html"
    if (-not (Test-Path $backendArtifact)) {
        throw "后端构建产物缺失: $backendArtifact，请先执行 build 或加 -Build 启动"
    }
    if ($Https) {
      # HTTPS 模式：后端需要前端构建产物来提供静态文件服务
      if (-not (Test-Path $frontendArtifact)) {
        throw "前端构建产物缺失: $frontendArtifact，HTTPS 模式需要前端构建产物"
      }
    } elseif (-not $BackendOnly) {
      if (-not (Test-Path $frontendArtifact)) {
        throw "前端构建产物缺失: $frontendArtifact，请先执行 build 或加 -Build 启动"
      }
    }

    # HTTPS 模式：生成自签证书
    if ($Https) {
      Write-Host "  生成自签 SSL 证书..."
      $certScript = Join-Path $rootDir "scripts\generate-cert.js"
      if (-not (Test-Path $certScript)) {
        throw "证书生成脚本缺失: $certScript"
      }
      & node $certScript
      if ($LASTEXITCODE -ne 0) {
        throw "SSL 证书生成失败"
      }
    }

    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    "" | Set-Content "$logDir/backend.log" -Encoding UTF8
    "" | Set-Content "$logDir/backend.err.log" -Encoding UTF8
    if (-not $Https -and -not $BackendOnly) {
      "" | Set-Content "$logDir/frontend.log" -Encoding UTF8
      "" | Set-Content "$logDir/frontend.err.log" -Encoding UTF8
    }

    $env:PORT = "$Port"
    $env:NODE_ENV = "production"
    $env:HOST = "::"

    if ($Https) {
      $env:HTTPS = "true"
      # 证书路径使用默认值，由 generate-cert.js 生成
      $sslDir = Join-Path $rootDir "config\ssl"
      $env:SSL_CERT_PATH = Join-Path $sslDir "cert.pem"
      $env:SSL_KEY_PATH = Join-Path $sslDir "key.pem"
    }

    Write-Host "  启动后端..."
    $backend = Start-Process -FilePath "node" -ArgumentList "dist/index.js" `
        -WorkingDirectory $backendDir -WindowStyle Hidden `
        -RedirectStandardOutput "$logDir/backend.log" `
        -RedirectStandardError "$logDir/backend.err.log" -PassThru

    if ($Https) {
      # HTTPS 模式：后端已提供前端静态文件服务，无需单独启动前端
      Write-PidsFile -backendPid $backend.Id -frontendPid $null
      Write-Host "  后端 PID: $($backend.Id)"
      Write-Host "  HTTPS 访问: https://localhost:$Port"
      Write-Host "  日志: $logDir/"
    } elseif ($BackendOnly) {
      # 仅后端模式：不启动前端
      Write-PidsFile -backendPid $backend.Id -frontendPid $null
      Write-Host "  后端 PID: $($backend.Id)"
      Write-Host "  访问  : http://localhost:$Port   （仅后端，未启动前端）"
      Write-Host "  日志  : $logDir/"
    } else {
      Write-Host "  启动前端..."
      $viteJs = Resolve-ViteJs
      if (-not $viteJs) { throw "未找到 vite.js" }
      $frontend = Start-Process -FilePath "node" -ArgumentList "`"$viteJs`" preview --port $FrontendPort --host" `
          -WorkingDirectory $frontendDir -WindowStyle Hidden `
          -RedirectStandardOutput "$logDir/frontend.log" `
          -RedirectStandardError "$logDir/frontend.err.log" -PassThru

      Write-PidsFile -backendPid $backend.Id -frontendPid $frontend.Id
      Write-Host "  后端 PID: $($backend.Id)"
      Write-Host "  前端 PID: $($frontend.Id)"
      Write-Host "  访问  : http://localhost:$FrontendPort"
      Write-Host "  日志  : $logDir/"
    }
}

function Invoke-Build {
    Install-Deps
    Rebuild-Sqlite
    Build-Projects
}

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
    Stop-ProcessByPort $Port
    if (-not $Https) {
        Stop-ProcessByPort $FrontendPort
    }
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
    $backendPort = $Port
    $frontendPort = $FrontendPort

    $existing = Read-PidsFile
    $backendRunning = $false
    $frontendRunning = $false
    if ($existing -and $existing.backend -and $existing.backend.pid) {
        $proc = Get-Process -Id $existing.backend.pid -ErrorAction SilentlyContinue
        $backendRunning = $null -ne $proc
    }
    if ($existing -and $existing.frontend -and $existing.frontend.pid) {
        $proc = Get-Process -Id $existing.frontend.pid -ErrorAction SilentlyContinue
        $frontendRunning = $null -ne $proc
    }

    $backendListen = Test-PortInUse $backendPort
    $frontendListen = Test-PortInUse $frontendPort

    Write-Host "  后端:"
    Write-Host "    配置端口: $backendPort"
    Write-Host "    端口监听: $(if ($backendListen) { '是' } else { '否' })"
    if ($existing -and $existing.backend -and $existing.backend.pid) {
        $backendState = if ($backendRunning) { '运行中' } else { '未运行' }
        Write-Host "    记录 PID: $($existing.backend.pid) ($backendState)"
    }

    Write-Host "  前端:"
    Write-Host "    配置端口: $frontendPort"
    if ($existing -and $existing.frontend -and $existing.frontend.pid) {
        $frontendState = if ($frontendRunning) { '运行中' } else { '未运行' }
        Write-Host "    端口监听: $(if ($frontendListen) { '是' } else { '否' })"
        Write-Host "    记录 PID: $($existing.frontend.pid) ($frontendState)"
    } elseif ($existing -and $existing.frontend -eq $null) {
        Write-Host "    模式: 仅后端 / HTTPS（未启动前端）"
    } else {
        Write-Host "    端口监听: $(if ($frontendListen) { '是' } else { '否' })"
    }

    $backendArtifact = Join-Path $backendDir "dist/index.js"
    $frontendArtifact = Join-Path $frontendDir "dist/index.html"
    Write-Host "  构建产物:"
    Write-Host "    后端: $(if (Test-Path $backendArtifact) { '存在' } else { '缺失' })"
    Write-Host "    前端: $(if (Test-Path $frontendArtifact) { '存在' } else { '缺失' })"
}

function Invoke-Logs {
    param([string]$LogTarget)
    if (-not $LogTarget) { $LogTarget = 'backend' }
    $logFile = if ($LogTarget -eq 'frontend') { "$logDir/frontend.log" } else { "$logDir/backend.log" }
    if (Test-Path $logFile) {
        Get-Content $logFile -Tail 50
    } else {
        Write-Host "  日志不存在"
    }
}

# ==================== 证书 ====================

# 交互选择证书签发类型（localhost / 域名或公网 IP）
function Select-CertHost {
    Write-Host ""
    Write-Host "  请选择证书签发类型："
    Write-Host "    [1] localhost（本机访问，默认，自签证书）"
    Write-Host "    [2] 域名或公网 IP（如 example.com 或 1.2.3.4）"
    Write-Host "        - 域名将自动申请 Let's Encrypt 可信 CA 证书"
    Write-Host "          （需域名已解析到本机且 80 端口可访问）"
    Write-Host "        - 公网 IP 或内网地址使用自签证书"
    $choice = Read-Host "  请输入 1 或 2（直接回车默认 1）"
    if ($choice -eq '2') {
        $hostValue = Read-Host "  请输入域名或公网 IP 地址"
        if ([string]::IsNullOrWhiteSpace($hostValue)) {
            Write-Host "  [提示] 未输入地址，将使用 localhost"
            return 'localhost'
        }
        Write-Host ""
        Write-Host "  [提示] 若输入的是域名，将自动申请 Let's Encrypt 可信 CA 证书；"
        Write-Host "         若无法申请（域名未解析 / 80 端口不可达），可改输入 IP 或 localhost 使用自签证书。"
        return $hostValue.Trim()
    }
    return 'localhost'
}

# 一键签发证书：交互选择类型后调用 scripts/generate-cert.js
function Invoke-Cert {
    $certScript = Join-Path $rootDir "scripts\generate-cert.js"
    if (-not (Test-Path $certScript)) {
        Write-Host "  [错误] 证书生成脚本缺失: $certScript" -ForegroundColor Red
        return 1
    }
    $certHost = Select-CertHost
    Write-Host "  [证书] 签发类型: $certHost"
    & node $certScript $certHost
    $code = $LASTEXITCODE
    Write-Host ""
    if ($code -ne 0) {
        Write-Host "  [证书] 签发失败（退出码 $code）" -ForegroundColor Red
    } else {
        Write-Host "  [证书] 签发完成，证书位于 config/ssl/" -ForegroundColor Green
    }
    return $code
}

# HTTPS 启动：交互选择证书类型 → 签发 → 以 HTTPS 启动
function Invoke-HttpsStart {
    $certScript = Join-Path $rootDir "scripts\generate-cert.js"
    if (-not (Test-Path $certScript)) {
        Write-Host "  [错误] 证书生成脚本缺失: $certScript" -ForegroundColor Red
        return 1
    }
    $certHost = Select-CertHost
    Write-Host "  [证书] 签发类型: $certHost"
    & node $certScript $certHost
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [证书] 签发失败，HTTPS 启动中止" -ForegroundColor Red
        return 1
    }
    $script:Https = $true
    Invoke-Start
    return 0
}

function Show-Help {
    Write-Host "用法: .\start-prod.ps1 {start|backend|cert|https|stop|restart|status|logs|build|help} [选项]"
    Write-Host ""
    Write-Host "命令:"
    Write-Host "  start              安装依赖后直接启动（默认不构建）"
    Write-Host "  backend            仅启动后端（加 -Https 使用 HTTPS）"
    Write-Host "  cert               一键签发 SSL 证书（localhost / 域名(Let's Encrypt) / 公网 IP）"
    Write-Host "  https              签发证书后以 HTTPS 启动（仅后端，统一提供前端页面）"
    Write-Host "  build              单独构建前后端"
    Write-Host "  stop               停止服务"
    Write-Host "  restart            重启服务"
    Write-Host "  status             查看运行状态"
    Write-Host "  logs [backend|frontend]  查看日志（默认 backend）"
    Write-Host "  help               显示此帮助"
    Write-Host ""
    Write-Host "start/restart/backend 选项:"
    Write-Host "  -Build                    启动前执行构建"
    Write-Host "  -Https                    使用 HTTPS（后端统一提供前端页面）"
    Write-Host ""
    Write-Host "端口: 后端默认取 .env 的 PORT（否则 3333），前端固定 4173"
}

# ==================== 交互菜单 ====================

function Show-Menu {
    while ($true) {
        Clear-Host
        Write-Host "========================================"
        Write-Host "  ZViewer 生产服务管理"
        Write-Host "========================================"
        Write-Host ""
        Write-Host "  1) 启动服务"
        Write-Host "  2) 仅启动后端"
        Write-Host "  3) 停止服务"
        Write-Host "  4) 重启服务"
        Write-Host "  5) 查看状态"
        Write-Host "  6) 查看日志"
        Write-Host "  7) 构建前后端"
        Write-Host "  8) 一键签发 SSL 证书"
        Write-Host "  9) HTTPS 启动（自动签发证书）"
        Write-Host "  0) 退出"
        Write-Host ""
        $choice = Read-Host "请输入编号 (0-9)"
        switch ($choice) {
            '1' { Invoke-Start; Wait-MenuKey }
            '2' {
                $boChoice = Read-Host "  请选择类型 (1=HTTP 2=HTTPS，直接回车默认 HTTP)"
                if ($boChoice -eq '2') { $script:Https = $true }
                Invoke-Start -BackendOnly
                Wait-MenuKey
            }
            '3' { Invoke-Stop; Wait-MenuKey }
            '4' { Invoke-Restart; Wait-MenuKey }
            '5' { Invoke-Status; Wait-MenuKey }
            '6' { Invoke-Logs -LogTarget $Target; Wait-MenuKey }
            '7' { Invoke-Build; Wait-MenuKey }
            '8' { Invoke-Cert; Wait-MenuKey }
            '9' { Invoke-HttpsStart; Wait-MenuKey }
            '0' { return }
            default { Write-Host "  无效输入，请重新选择"; Start-Sleep -Milliseconds 800 }
        }
    }
}

function Wait-MenuKey {
    Write-Host ""
    Read-Host "按回车返回菜单" | Out-Null
}

# ==================== 入口 ====================

switch ($Command) {
    'start'   { Invoke-Start }
    'backend' { Invoke-Start -BackendOnly }
    'cert'    { $null = Invoke-Cert; exit 0 }
    'https'   { $null = Invoke-HttpsStart; exit 0 }
    'build'   { Invoke-Build }
    'stop'    { Invoke-Stop }
    'restart' { Invoke-Restart }
    'status'  { Invoke-Status }
    'logs'    { Invoke-Logs -LogTarget $Target }
    'menu'    { Show-Menu }
    default   { Show-Help }
}
