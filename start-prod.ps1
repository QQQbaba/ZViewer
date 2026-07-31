#!/usr/bin/env pwsh
#Requires -Version 5.1

# ZViewer 一键启动脚本
# 命令：start | stop | restart | status | logs | build | help

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'build', 'help', '')]
    [string]$Command = 'help',

    [Parameter(Position = 1)]
    [ValidateSet('backend', 'frontend', '')]
    [string]$Target = '',

    [switch]$Build,            # 启动前构建
    [switch]$Https,            # 使用自签 HTTPS
    [int]$Port = 3333,
    [int]$FrontendPort = 4173
)

$ErrorActionPreference = "Stop"

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$backendDir = Join-Path $rootDir "backend"
$frontendDir = Join-Path $rootDir "frontend"
$logDir = Join-Path $rootDir "log"
$pidsFile = Join-Path $rootDir ".prod.pids.json"
$portsFile = Join-Path $rootDir ".prod.ports.json"

# ==================== 工具函数 ====================

function Read-PortsFile {
    if (-not (Test-Path $portsFile)) { return $null }
    try {
        $obj = Get-Content $portsFile -Raw | ConvertFrom-Json
        return @{
            backend = if ($null -ne $obj.backend) { [int]$obj.backend } else { $null }
            frontend = if ($null -ne $obj.frontend) { [int]$obj.frontend } else { $null }
        }
    } catch { return $null }
}

function Read-PidsFile {
    if (-not (Test-Path $pidsFile)) { return $null }
    try { return Get-Content $pidsFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-PidsFile($backendPid, $frontendPid) {
    @{
        backend = @{ pid = $backendPid }
        frontend = @{ pid = $frontendPid }
        ports = @{ backend = $Port; frontend = $FrontendPort }
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

function Invoke-Start {
    $saved = Read-PortsFile
    if (-not $PSBoundParameters.ContainsKey('Port') -and $saved -and $saved.backend) {
        $Port = $saved.backend
    }
    if (-not $PSBoundParameters.ContainsKey('FrontendPort') -and $saved -and $saved.frontend) {
        $FrontendPort = $saved.frontend
    }

    Write-Host "========================================"
    Write-Host "  ZViewer 启动"
    Write-Host "  后端端口: $Port"
    if ($Https) {
      Write-Host "  模式: HTTPS（自签证书）"
      Write-Host "  前端: 由后端统一提供"
    } else {
      Write-Host "  前端端口: $FrontendPort"
    }
    Write-Host "========================================"

    if (Test-PortInUse $Port) {
        Write-Host "  错误：后端端口 $Port 已被占用" -ForegroundColor Red
        exit 1
    }
    if (-not $Https -and (Test-PortInUse $FrontendPort)) {
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
    } else {
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
    if (-not $Https) {
      # 非 HTTPS 模式才需要启动前端
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
      Write-Host "  日志: $logDir/"
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

    $saved = Read-PortsFile
    $backendPort = if ($saved -and $saved.backend) { $saved.backend } else { $Port }
    $frontendPort = if ($saved -and $saved.frontend) { $saved.frontend } else { $FrontendPort }

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
        Write-Host "    模式: HTTPS（后端统一提供服务）"
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

function Show-Help {
    Write-Host "用法: .\start-prod.ps1 {start|stop|restart|status|logs|build|help} [选项]"
    Write-Host ""
    Write-Host "命令:"
    Write-Host "  start              安装依赖后直接启动（默认不构建）"
    Write-Host "  build              单独构建前后端"
    Write-Host "  stop               停止服务"
    Write-Host "  restart            重启服务"
    Write-Host "  status             查看运行状态"
    Write-Host "  logs [backend|frontend]  查看日志（默认 backend）"
    Write-Host "  help               显示此帮助"
    Write-Host ""
    Write-Host "start/restart 选项:"
    Write-Host "  -Port PORT                指定后端端口（默认 3333）"
    Write-Host "  -FrontendPort PORT        指定前端端口（默认 4173）"
    Write-Host "  -Build                    启动前执行构建"
    Write-Host "  -Https                    使用自签 HTTPS（后端统一提供前端页面）"
}

# ==================== 入口 ====================

switch ($Command) {
    'start'   { Invoke-Start }
    'build'   { Invoke-Build }
    'stop'    { Invoke-Stop }
    'restart' { Invoke-Restart }
    'status'  { Invoke-Status }
    'logs'    { Invoke-Logs -LogTarget $Target }
    default   { Show-Help }
}
