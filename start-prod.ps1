#!/usr/bin/env pwsh
#Requires -Version 5.1

<#
.SYNOPSIS
  ZViewer 一键启动 / 生产服务统一管理脚本
.DESCRIPTION
  一键启动：自动检测并安装依赖（npm install）、自动构建缺失产物（npm run build）、启动服务。
  无需提前执行 npm install 即可直接运行本脚本。
  支持子命令：start | stop | restart | status | logs | port | menu | help
  适配 npm workspaces（根目录统一安装依赖）。

  崩溃自动重启：通过 supervisor.ps1 监控前后端子进程，崩溃后自动重启（最多 20 次）。
  后端 /health 端点返回 startedAt + restartCount，前端据此在网页内提示"后端已自动重启"。
.EXAMPLE
  .\start-prod.ps1 start
  .\start-prod.ps1 start -Port 3001
  .\start-prod.ps1 stop
  .\start-prod.ps1 restart
  .\start-prod.ps1 status
  .\start-prod.ps1 logs backend
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'port', 'menu', 'help', '')]
    [string]$Command = 'help',

    [Parameter(Position = 1)]
    [ValidateSet('backend', 'frontend', '')]
    [string]$Target = '',

    [switch]$ForceDeps,            # 强制重新安装依赖（默认按需自动安装）
    [switch]$SkipBuild,            # 跳过自动构建（仅使用已有产物启动）
    [int]$Port = 3333,
    [int]$FrontendPort = 4173,
    [string]$Database
)

$ErrorActionPreference = "Stop"

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$backendDir = Join-Path $rootDir "backend"
$frontendDir = Join-Path $rootDir "frontend"
$pidsFile = Join-Path $rootDir ".prod.pids.json"
$portsFile = Join-Path $rootDir ".prod.ports.json"

# 数据根目录：所有持久化数据（数据库、上传文件、头像、NMS 媒体）统一存放于此
# 升级时仅需保留此目录即可保留全部用户数据；首次启动由后端自动创建
$configDir = Join-Path $rootDir "config"

# 运行时日志统一存放于根目录 log/ 文件夹
$logDir = Join-Path $rootDir "log"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$backendLog = Join-Path $logDir "backend.log"
$backendErrLog = Join-Path $logDir "backend.err.log"
$frontendLog = Join-Path $logDir "frontend.log"
$frontendErrLog = Join-Path $logDir "frontend.err.log"
$frontendConsoleLog = Join-Path $logDir "frontend-console.log"
$supervisorLogPath = Join-Path $logDir "supervisor.log"

# ============ 辅助函数 ============

function Write-Title {
    param([string]$Text)
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
}

function Test-CommandInstalled {
    param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "$Name 未安装或不在 PATH 中"
    }
    return $cmd
}

function Get-NetworkAddresses {
    # 获取本机所有可对外访问的 IPv4 / IPv6 地址（排除回环、链路本地、虚拟接口）
    # 返回 @{ IPv4 = @('1.2.3.4', ...); IPv6 = @('2001:db8::1', ...) }
    $result = @{ IPv4 = @(); IPv6 = @() }
    try {
        # Get-NetIPAddress 在 Windows 8+ / Server 2012+ 可用
        # 筛选 AddressState=Preferred（已生效地址），排除回环与链路本地
        $addresses = Get-NetIPAddress -AddressState Preferred -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -ne '127.0.0.1' -and
                $_.IPAddress -ne '::1' -and
                -not $_.IPAddress.StartsWith('169.254.') -and
                -not $_.IPAddress.StartsWith('fe80::')
            }
        foreach ($addr in $addresses) {
            if ($addr.AddressFamily -eq 'IPv4') {
                $result.IPv4 += $addr.IPAddress
            } elseif ($addr.AddressFamily -eq 'IPv6') {
                # 过滤临时 IPv6（隐私扩展）、Teredo、6to4 等可能不稳定的地址
                # 保留全局单播地址（2000::/3）
                if ($addr.IPAddress -match '^2[0-9a-fA-F]') {
                    $result.IPv6 += $addr.IPAddress
                }
            }
        }
    } catch {
        # 回退方案：使用 ipconfig 解析（兼容老版本 Windows）
        try {
            $ipconfigOutput = & ipconfig 2>$null | Out-String
            if ($ipconfigOutput) {
                $matches = [regex]::Matches($ipconfigOutput, 'IPv4 Address[.\s:]+([\d.]+)')
                foreach ($m in $matches) { $result.IPv4 += $m.Groups[1].Value }
                $matches6 = [regex]::Matches($ipconfigOutput, 'IPv6 Address[.\s:]+([0-9a-fA-F:]+)')
                foreach ($m in $matches6) {
                    if ($m.Groups[1].Value -match '^2[0-9a-fA-F]') {
                        $result.IPv6 += $m.Groups[1].Value
                    }
                }
            }
        } catch {}
    }
    # 去重
    $result.IPv4 = $result.IPv4 | Select-Object -Unique
    $result.IPv6 = $result.IPv6 | Select-Object -Unique
    return $result
}

function Format-AccessUrls {
    # 格式化访问地址列表，IPv6 地址需用方括号包裹
    # 参数：端口列表（如 @(3333, 4173)），返回需要打印的行数组
    param([int[]]$Ports)
    $lines = @()
    $addrs = Get-NetworkAddresses

    foreach ($port in $Ports) {
        $lines += "  端口 $port ："
        $lines += "    http://localhost:$port"
        $lines += "    http://127.0.0.1:$port"
        foreach ($ip in $addrs.IPv4) {
            if ($ip -ne '127.0.0.1') {
                $lines += "    http://${ip}:$port"
            }
        }
        foreach ($ip in $addrs.IPv6) {
            $lines += "    http://[${ip}]:$port"
        }
    }
    return $lines
}

function Backup-OldLogs {
    # 启动前备份上一轮日志到归档子目录，避免直接删除丢失历史记录
    # 备份命名格式：backend.20260725-120000.log
    $archivedCount = 0
    foreach ($log in @($backendLog, $backendErrLog, $frontendLog, $frontendErrLog, $frontendConsoleLog)) {
        if (-not (Test-Path $log)) { continue }
        try {
            $stamp = (Get-Item $log).LastWriteTime.ToString('yyyyMMdd-HHmmss')
            $base = [System.IO.Path]::GetFileNameWithoutExtension($log)
            $ext = [System.IO.Path]::GetExtension($log)
            $archiveName = "${base}.${stamp}${ext}"
            $archivePath = Join-Path $script:logDir $archiveName
            Move-Item -Path $log -Destination $archivePath -Force -ErrorAction Stop
            $archivedCount++
        } catch {
            # 备份失败则直接删除，避免占用文件句柄导致重定向失败
            Remove-Item $log -Force -ErrorAction SilentlyContinue
        }
    }
    # supervisor.log 是追加模式，启动时也备份一份（不删除，supervisor 会重新创建）
    if (Test-Path $supervisorLogPath) {
        try {
            $stamp = (Get-Item $supervisorLogPath).LastWriteTime.ToString('yyyyMMdd-HHmmss')
            $archivePath = Join-Path $script:logDir "supervisor.${stamp}.log"
            Move-Item -Path $supervisorLogPath -Destination $archivePath -Force -ErrorAction Stop
        } catch {
            Remove-Item $supervisorLogPath -Force -ErrorAction SilentlyContinue
        }
    }
    return $archivedCount
}

function Cleanup-OldArchives {
    # 清理超过保留天数的归档日志，避免 log/ 目录无限增长
    param([int]$KeepDays = 7)
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    $archiveFiles = Get-ChildItem -Path $script:logDir -File -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '\.\d{8}-\d{6}\.' -and $_.LastWriteTime -lt $cutoff
    }
    foreach ($file in $archiveFiles) {
        Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
    }
    return $archiveFiles.Count
}

function Test-DepsInstalled {
    # npm workspaces：根目录 node_modules 存在 + 关键依赖存在即视为已安装
    # 检查后端运行时关键依赖（reflect-metadata / better-sqlite3 / typeorm 等），
    # 避免部分安装失败时误判为"已就绪"导致启动后 MODULE_NOT_FOUND。
    $rootNodeModules = Join-Path $script:rootDir "node_modules"
    $expressPath = Join-Path $script:rootDir "node_modules\express"
    $vitePath = Join-Path $script:rootDir "node_modules\vite"
    $reflectPath = Join-Path $script:rootDir "node_modules\reflect-metadata"
    $typeormPath = Join-Path $script:rootDir "node_modules\typeorm"
    $sqlitePath = Join-Path $script:rootDir "node_modules\better-sqlite3"
    $hasRoot = Test-Path $rootNodeModules
    $hasExpress = Test-Path $expressPath
    $hasVite = Test-Path $vitePath
    $hasReflect = Test-Path $reflectPath
    $hasTypeorm = Test-Path $typeormPath
    $hasSqlite = Test-Path $sqlitePath
    return [bool]($hasRoot -and $hasExpress -and $hasVite -and $hasReflect -and $hasTypeorm -and $hasSqlite)
}

function Resolve-ViteJs {
    # vite 在 workspaces 模式下可能 hoist 到根目录，也可能在 frontend/node_modules
    $candidates = @(
        (Join-Path $script:rootDir "node_modules\vite\bin\vite.js"),
        (Join-Path $script:frontendDir "node_modules\vite\bin\vite.js")
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Install-ProjectDependencies {
    # npm workspaces：仅在根目录安装一次，子目录会自动 hoist
    Write-Host "  [$rootDir] 安装依赖（npm workspaces）..."
    Push-Location $rootDir
    try {
        # 优先 npm ci（要求 package-lock.json，可重现依赖树，更快更稳定）
        # 失败则回退到 npm install（兼容 lock 文件缺失或损坏的情况）
        # 用 --no-audit --no-fund 提速；--prefer-offline 减少网络
        # 必须包含 devDependencies（typescript / vite 等），否则构建报 code 127。
        # 同时显式移除 NODE_ENV=production，避免 npm 跳过 devDependencies。
        $env:NPM_CONFIG_INCLUDE = 'dev'
        $env:NODE_ENV = $null
        npm ci --no-audit --no-fund --prefer-offline --include=dev
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  npm ci 失败，回退到 npm install ..." -ForegroundColor Yellow
            npm install --no-audit --no-fund --include=dev
            if ($LASTEXITCODE -ne 0) {
                Write-Host ""
                Write-Host "  ============================================" -ForegroundColor Red
                Write-Host "  依赖安装失败！" -ForegroundColor Red
                Write-Host "  最常见原因：better-sqlite3 原生模块编译失败" -ForegroundColor Red
                Write-Host "  解决方法：" -ForegroundColor Red
                Write-Host "    安装 Visual Studio Build Tools（C++ 工作负载）" -ForegroundColor Red
                Write-Host "    或运行: npm install --global windows-build-tools" -ForegroundColor Red
                Write-Host "  安装后重新运行: .\start-prod.ps1 start -ForceDeps" -ForegroundColor Red
                Write-Host "  ============================================" -ForegroundColor Red
                throw "依赖安装失败"
            }
        }
    } finally {
        Pop-Location
    }

    # 安装后验证关键依赖是否存在（防止 npm 部分成功但关键模块缺失）
    if (-not (Test-DepsInstalled)) {
        $missing = @()
        $checks = @{
            'reflect-metadata' = 'node_modules\reflect-metadata'
            'typeorm'          = 'node_modules\typeorm'
            'better-sqlite3'   = 'node_modules\better-sqlite3'
            'express'          = 'node_modules\express'
        }
        foreach ($kv in $checks.GetEnumerator()) {
            $p = Join-Path $rootDir $kv.Value
            if (-not (Test-Path $p)) { $missing += $kv.Key }
        }
        Write-Host ""
        Write-Host "  ============================================" -ForegroundColor Red
        Write-Host "  依赖安装后验证失败，缺失模块: $($missing -join ', ')" -ForegroundColor Red
        Write-Host "  这通常是因为 better-sqlite3 编译失败导致 npm 回滚了部分安装。" -ForegroundColor Red
        Write-Host "  解决方法：" -ForegroundColor Red
        Write-Host "    1. 安装 Visual Studio Build Tools（C++ 工作负载）" -ForegroundColor Red
        Write-Host "    2. 重新安装: .\start-prod.ps1 start -ForceDeps" -ForegroundColor Red
        Write-Host "  ============================================" -ForegroundColor Red
        throw "依赖验证失败：缺失 $($missing -join ', ')"
    }
    Write-Host "  依赖安装完成，关键模块验证通过。" -ForegroundColor Green
}

function Read-PidsFile {
    if (-not (Test-Path $pidsFile)) { return $null }
    try {
        return Get-Content $pidsFile -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

# ============ 端口配置 ============

function Read-PortsFile {
    if (-not (Test-Path $portsFile)) { return $null }
    try {
        $obj = Get-Content $portsFile -Raw | ConvertFrom-Json
        $backend = if ($null -ne $obj.backend) { [int]$obj.backend } else { $null }
        $frontend = if ($null -ne $obj.frontend) { [int]$obj.frontend } else { $null }
        if ($backend -gt 0 -and $frontend -gt 0) {
            return @{ backend = $backend; frontend = $frontend }
        }
    } catch {}
    return $null
}

function Write-PortsFile {
    param([int]$BackendPort, [int]$FrontendPort)
    $ports = @{
        backend  = $BackendPort
        frontend = $FrontendPort
        updatedAt = (Get-Date).ToString('o')
    }
    $ports | ConvertTo-Json -Depth 2 | Set-Content -Path $portsFile -Encoding UTF8
}

function Test-PortValid {
    param([int]$Port, [switch]$CheckInUse)
    if ($Port -lt 1 -or $Port -gt 65535) {
        Write-Host "  端口 $Port 不合法（需 1-65535）" -ForegroundColor Red
        return $false
    }
    if ($CheckInUse) {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) {
            Write-Host "  端口 $Port 已被占用（PID $($conn.OwningProcess)）" -ForegroundColor Red
            return $false
        }
    }
    return $true
}

function Read-PortInput {
    param([string]$Prompt, [int]$DefaultValue, [switch]$CheckInUse)
    while ($true) {
        $input = Read-Host "$Prompt (默认 $DefaultValue，留空使用默认)"
        if ([string]::IsNullOrWhiteSpace($input)) {
            return $DefaultValue
        }
        if ($input -notmatch '^\d+$') {
            Write-Host "  请输入正整数" -ForegroundColor Red
            continue
        }
        $port = [int]$input
        if (-not (Test-PortValid -Port $port -CheckInUse:$CheckInUse)) {
            continue
        }
        return $port
    }
}

function Write-PidsFile {
    param(
        [int]$BackendPid,
        [int]$FrontendPid,
        [int]$BackendPort,
        [int]$FrontendPortNum
    )
    $pids = @{
        backend  = @{ pid = $BackendPid; port = $BackendPort; url = "http://localhost:$BackendPort" }
        frontend = @{ pid = $FrontendPid; port = $FrontendPortNum; url = "http://localhost:$FrontendPortNum" }
    }
    $pids | ConvertTo-Json -Depth 3 | Set-Content -Path $pidsFile -Encoding UTF8
}

function Test-PortInUse {
    # 仅检查 Listen 状态，避免 TIME_WAIT / CloseWait 等残留连接造成误判
    param([int]$LocalPort)
    $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $conn
}

function Get-ProcessByIdSafe {
    param([int]$ProcessId)
    try {
        return Get-Process -Id $ProcessId -ErrorAction Stop
    } catch {
        return $null
    }
}

function Stop-ProcessGraceful {
    # 终止进程及其所有子进程。
    # node / vite 后台进程 detached 于控制台，taskkill 不带 /F 发送的信号对它们无效；
    # Stop-Process -Force 又只杀单个 PID 不杀子进程，会导致 vite fork 的监听子进程残留。
    # 因此统一使用 taskkill /T /F 一次性强制终止整个进程树。
    param([int]$ProcessId, [int]$TimeoutSec = 5)
    $proc = Get-ProcessByIdSafe -ProcessId $ProcessId
    if (-not $proc) {
        Write-Host "  进程 PID $ProcessId 不存在或已结束"
        return $false
    }
    $name = $proc.ProcessName

    # 1. 优雅尝试：taskkill /T（不带 /F），给进程一个清理机会
    try {
        & taskkill /PID $ProcessId /T 2>&1 | Out-Null
    } catch {}
    $deadline = (Get-Date).AddSeconds(2)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-ProcessByIdSafe -ProcessId $ProcessId)) {
            Write-Host "  已结束进程 PID $ProcessId ($name)"
            return $true
        }
        Start-Sleep -Milliseconds 200
    }

    # 2. 强制终止整个进程树（/T = 含子进程，/F = 强制）
    try {
        & taskkill /PID $ProcessId /T /F 2>&1 | Out-Null
    } catch {}
    # 等待进程真正消失
    $deadline2 = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline2) {
        if (-not (Get-ProcessByIdSafe -ProcessId $ProcessId)) {
            Write-Host "  已强制结束进程 PID $ProcessId ($name)" -ForegroundColor Yellow
            return $true
        }
        Start-Sleep -Milliseconds 200
    }

    # 3. 最后兜底：Stop-Process -Force
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        Write-Host "  已强制结束进程 PID $ProcessId ($name)" -ForegroundColor Yellow
        return $true
    } catch {
        Write-Host "  无法结束进程 PID $ProcessId：$_" -ForegroundColor Red
        return $false
    }
}

function Test-BackendBuilt {
    return Test-Path (Join-Path $backendDir "dist/index.js")
}

function Test-FrontendBuilt {
    return Test-Path (Join-Path $frontendDir "dist/index.html")
}

function Test-BuildUpToDate {
    # 智能构建跳过：检测构建产物是否新于所有源代码文件
    # 返回 $true = 可跳过，$false = 需要构建
    param([string]$ProjectDir, [string]$Artifact)

    # 产物不存在，必须构建
    if (-not (Test-Path $Artifact)) { return $false }

    $artifactTime = (Get-Item $Artifact).LastWriteTime

    # 检查 src 目录下所有源代码文件
    $srcDir = Join-Path $ProjectDir "src"
    if (Test-Path $srcDir) {
        $newerFile = Get-ChildItem -Path $srcDir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $artifactTime } |
            Select-Object -First 1
        if ($newerFile) { return $false }
    }

    # 同时检查 package.json / tsconfig.json / vite.config 等配置文件
    foreach ($cfg in @("package.json", "tsconfig.json", "vite.config.ts", "vite.config.js")) {
        $cfgPath = Join-Path $ProjectDir $cfg
        if ((Test-Path $cfgPath) -and ((Get-Item $cfgPath).LastWriteTime -gt $artifactTime)) {
            return $false
        }
    }

    return $true
}

function Build-ProjectDependencies {
    # 构建前后端项目（npm workspaces：可在根目录执行 npm run build 一次性构建所有 workspace）
    Write-Host "  构建后端 ..."
    Push-Location $backendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "后端构建失败 (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }

    Write-Host "  构建前端 ..."
    Push-Location $frontendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "前端构建失败 (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

function Invoke-BuildIfNeeded {
    # 自动构建缺失或过期产物。SkipBuild 时跳过；否则检测产物是否最新，按需构建。
    Write-Host "[3/5] 检查并构建产物 ..."
    if ($SkipBuild) {
        Write-Host "  跳过构建（-SkipBuild）" -ForegroundColor Yellow
        return
    }

    $backendArtifact = Join-Path $backendDir "dist/index.js"
    $frontendArtifact = Join-Path $frontendDir "dist/index.html"

    $backendUpToDate = Test-BuildUpToDate -ProjectDir $backendDir -Artifact $backendArtifact
    $frontendUpToDate = Test-BuildUpToDate -ProjectDir $frontendDir -Artifact $frontendArtifact

    if ($backendUpToDate -and $frontendUpToDate) {
        Write-Host "  构建产物已是最新（源代码未修改），跳过构建" -ForegroundColor Green
        return
    }

    if (-not $backendUpToDate) {
        Write-Host "  后端产物缺失或源代码已更新，需要构建" -ForegroundColor Yellow
    }
    if (-not $frontendUpToDate) {
        Write-Host "  前端产物缺失或源代码已更新，需要构建" -ForegroundColor Yellow
    }
    Build-ProjectDependencies
    Write-Host "  构建完成" -ForegroundColor Green
}

function Get-PidByPort {
    # 通过端口查找真正监听的进程 PID
    # Start-Process -WindowStyle Hidden 在 Windows 上返回的 PID 可能是 stub 进程
    param([int]$LocalPort, [int]$TimeoutMs = 4000)
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn -and $conn.OwningProcess -and $conn.OwningProcess -gt 0) {
            return [int]$conn.OwningProcess
        }
        Start-Sleep -Milliseconds 200
    }
    return $null
}

function Stop-ServiceByPidOrPort {
    # 优先用 PID 停止；PID 失效或停止后端口仍被占用则按端口查找。
    # vite preview / node 会 fork 子进程实际监听端口，杀父 PID 后子进程可能仍占用端口，
    # 因此必须以端口释放为最终判据，而不是仅看 PID 是否消失。
    param([int]$ProcessId, [int]$LocalPort)
    $proc = Get-ProcessByIdSafe -ProcessId $ProcessId
    if ($proc) {
        Stop-ProcessGraceful -ProcessId $ProcessId | Out-Null
    } else {
        Write-Host "  PID $ProcessId 不存在" -ForegroundColor Yellow
    }

    # 验证端口是否真的释放。vite/node 的子进程可能仍在监听。
    if ($LocalPort -gt 0) {
        # 短暂等待端口释放
        $waitDeadline = (Get-Date).AddSeconds(1)
        while ((Get-Date) -lt $waitDeadline) {
            if (-not (Test-PortInUse -LocalPort $LocalPort)) { break }
            Start-Sleep -Milliseconds 200
        }

        if (Test-PortInUse -LocalPort $LocalPort) {
            # 端口仍被占用，按端口查找真实监听进程并强杀整个进程树
            $realPid = Get-PidByPort -LocalPort $LocalPort -TimeoutMs 500
            if ($realPid) {
                if ($realPid -ne $ProcessId) {
                    Write-Host "  端口 $LocalPort 仍被 PID $realPid 占用（PID $ProcessId 的子进程），按端口清理..." -ForegroundColor Yellow
                } else {
                    Write-Host "  PID $ProcessId 仍占用端口 $LocalPort，再次强制清理..." -ForegroundColor Yellow
                }
                Stop-ProcessGraceful -ProcessId $realPid | Out-Null

                # 最终验证
                if (Test-PortInUse -LocalPort $LocalPort) {
                    $stillPid = Get-PidByPort -LocalPort $LocalPort -TimeoutMs 500
                    if ($stillPid) {
                        Write-Host "  端口 $LocalPort 仍被 PID $stillPid 占用，请手动结束" -ForegroundColor Red
                    }
                }
            }
        }
    }
}

# ============ 命令实现 ============

function Test-ServiceRunning {
    # 服务运行检测：PID 文件 + 端口监听双重判定
    #
    # 返回 @{ Running = $true/$false; BackendPid = ...; FrontendPid = ...;
    #         BackendByPort = $true/$false; FrontendByPort = $true/$false;
    #         PidFile = $existing; StalePidFile = $true/$false }
    #
    # 判定规则：
    # 1. PID 文件中记录的进程仍存活 → 视为运行中（最可靠）
    # 2. PID 文件不存在或进程已死，但端口仍被监听 → 视为运行中（兜底）
    #    此场景常见于：服务通过其他方式启动（dev 模式、手动 node）、
    #                 PID 文件被误删、系统重启后 PID 复用
    # 3. 两者都不满足 → 未运行
    $existing = Read-PidsFile
    $result = @{
        Running       = $false
        BackendPid    = $null
        FrontendPid   = $null
        BackendByPort = $false
        FrontendByPort = $false
        PidFile       = $existing
        StalePidFile  = $false
    }

    # 路径 1：PID 文件 + 进程存活检测
    if ($existing) {
        $backendProc = Get-ProcessByIdSafe -ProcessId $existing.backend.pid
        $frontendProc = Get-ProcessByIdSafe -ProcessId $existing.frontend.pid
        if ($backendProc) {
            $result.Running = $true
            $result.BackendPid = $backendProc.Id
        }
        if ($frontendProc) {
            $result.Running = $true
            $result.FrontendPid = $frontendProc.Id
        }
        # PID 文件存在但进程都死了 → 标记为过期文件，调用方可清理
        if (-not $backendProc -and -not $frontendProc) {
            $result.StalePidFile = $true
        }
    }

    # 路径 2：端口监听兜底检测
    # 即使 PID 文件不存在或过期，只要端口被监听就视为服务在运行
    $backendPortInUse = Test-PortInUse -LocalPort $Port
    $frontendPortInUse = Test-PortInUse -LocalPort $FrontendPort
    if ($backendPortInUse -and -not $result.BackendPid) {
        $portPid = Get-PidByPort -LocalPort $Port -TimeoutMs 500
        if ($portPid) {
            $result.Running = $true
            $result.BackendPid = $portPid
            $result.BackendByPort = $true
        }
    }
    if ($frontendPortInUse -and -not $result.FrontendPid) {
        $portPid = Get-PidByPort -LocalPort $FrontendPort -TimeoutMs 500
        if ($portPid) {
            $result.Running = $true
            $result.FrontendPid = $portPid
            $result.FrontendByPort = $true
        }
    }

    return $result
}

function Invoke-Start {
    Write-Title "ZViewer 生产服务启动"

    # 端口已在主入口统一解析（命令行参数 > 配置文件 > 默认值）
    Write-Host "  后端端口：$Port"
    Write-Host "  前端端口：$FrontendPort"

    # 检查是否已在运行（PID 文件 + 端口监听双重判定）
    $running = Test-ServiceRunning
    if ($running.Running) {
        Write-Host "服务已在运行中，如需重启请使用 restart 子命令" -ForegroundColor Yellow
        if ($running.BackendPid) {
            $source = if ($running.BackendByPort) { "端口检测" } else { "PID 文件" }
            Write-Host "  后端 PID: $($running.BackendPid) (来源: $source)"
        }
        if ($running.FrontendPid) {
            $source = if ($running.FrontendByPort) { "端口检测" } else { "PID 文件" }
            Write-Host "  前端 PID: $($running.FrontendPid) (来源: $source)"
        }
        # 如果 PID 文件不存在但端口被占用，提示用户
        if (-not $running.PidFile -and ($running.BackendByPort -or $running.FrontendByPort)) {
            Write-Host ""
            Write-Host "  提示：检测到端口被占用但未找到 PID 文件，" -ForegroundColor DarkYellow
            Write-Host "        可能是服务通过其他方式启动（如 dev 模式或手动 node）。" -ForegroundColor DarkYellow
            Write-Host "        如需强制启动，请先停止占用端口的进程，或使用 -Port / -FrontendPort 指定其他端口。" -ForegroundColor DarkYellow
        }
        return
    }

    # 清理过期的 PID 文件
    if ($running.StalePidFile) {
        Remove-Item $pidsFile -Force -ErrorAction SilentlyContinue
    }

    # 1. 检查环境
    Write-Host "[1/5] 检查环境 ..."
    $nodeCmd = Test-CommandInstalled "node"
    $npmCmd = Test-CommandInstalled "npm"
    Write-Host "  Node.js: $( & $nodeCmd.Source --version )"
    Write-Host "  npm: $( & $npmCmd.Source --version )"

    # 2. 依赖：node_modules 缺失则自动安装；-ForceDeps 强制重装
    Write-Host "[2/5] 检查依赖 ..."
    if ($ForceDeps) {
        Write-Host "  强制重新安装依赖 ..."
        Install-ProjectDependencies
    } elseif (Test-DepsInstalled) {
        Write-Host "  依赖已就绪" -ForegroundColor Green
    } else {
        Write-Host "  node_modules 缺失，自动安装依赖 ..." -ForegroundColor Yellow
        Install-ProjectDependencies
    }

    # 3. 自动构建缺失或过期的产物（除非 -SkipBuild）
    Invoke-BuildIfNeeded

    # 4. 校验构建产物（兜底，确保启动前产物存在）
    Write-Host "[4/5] 校验构建产物 ..."
    $backendArtifact = Join-Path $backendDir "dist/index.js"
    $frontendArtifact = Join-Path $frontendDir "dist/index.html"
    if (-not (Test-Path $backendArtifact)) {
        throw "后端构建产物缺失: $backendArtifact"
    }
    if (-not (Test-Path $frontendArtifact)) {
        throw "前端构建产物缺失: $frontendArtifact"
    }
    Write-Host "  构建产物已就绪" -ForegroundColor Green

    # 5. 启动服务
    Write-Host "[5/5] 启动服务 ..."
    $env:PORT = "$Port"
    $env:NODE_ENV = "production"
    # 绑定到 '::' 让后端同时监听 IPv4 与 IPv6（IPv6 双栈），兼容纯 IPv6 网络。
    # Node.js 在大多数平台上 '::' 会同时接受 IPv4-mapped 连接，无需额外配置。
    $env:HOST = "::"
    if ($Database) { $env:DATABASE_URL = $Database }

    # 前端 Vite preview 需要通过代理访问后端 API 与 HTTP-FLV 拉流，
    # 且必须支持用户自定义端口，因此把实际目标地址注入环境变量。
    $rtmpPort = if ($env:RTMP_PORT) { [int]$env:RTMP_PORT } else { 3334 }
    $httpFlvPort = if ($env:HTTP_FLV_PORT) { [int]$env:HTTP_FLV_PORT } else { 3335 }
    $env:VITE_API_TARGET = "http://localhost:$Port"
    $env:VITE_LIVE_TARGET = "http://localhost:$httpFlvPort"

    # 备份上一轮日志到归档（带时间戳），并清理超过 7 天的历史归档
    Write-Host "  归档上一轮日志 ..."
    $archivedCount = Backup-OldLogs
    if ($archivedCount -gt 0) {
        Write-Host "  已归档 $archivedCount 个日志文件至 log/ 目录" -ForegroundColor DarkGray
    }
    $cleanedCount = Cleanup-OldArchives -KeepDays 7
    if ($cleanedCount -gt 0) {
        Write-Host "  已清理 $cleanedCount 个超过 7 天的历史归档" -ForegroundColor DarkGray
    }

    # supervisor 脚本：监控子进程，崩溃后自动重启
    $supervisorScript = Join-Path $rootDir "supervisor.ps1"

    Write-Host "  启动后端 (PORT=$Port, supervisor 模式) ..."
    # 注意：Start-Process -ArgumentList 接收数组时按空格分词，
    # 无法处理包含空格的参数（如 vite.js preview --port 4173 --host ::）。
    # 改用单个字符串形式传递完整 ArgumentList，外层用双引号包裹每个参数。
    $backendSupervisorArgs = @(
        '-NoProfile'
        '-ExecutionPolicy', 'Bypass'
        '-File', "`"$supervisorScript`""
        '-Command', 'node'
        '-CommandArgs', '"dist/index.js"'
        '-WorkingDirectory', "`"$backendDir`""
        '-LogStdout', "`"$backendLog`""
        '-LogStderr', "`"$backendErrLog`""
    ) -join ' '
    $backendSupervisor = Start-Process -FilePath 'powershell.exe' -ArgumentList $backendSupervisorArgs -PassThru -WindowStyle Hidden
    $backendSupervisorPid = $backendSupervisor.Id
    Write-Host "  后端 supervisor PID: $backendSupervisorPid (等待端口监听...)"

    # 通过端口查找真实监听进程（supervisor 启动的子进程）
    $realBackendPid = Get-PidByPort -LocalPort $Port -TimeoutMs 8000
    if (-not $realBackendPid) {
        Write-Host "  后端启动失败（端口 $Port 未监听），查看日志 $backendErrLog" -ForegroundColor Red
        if (Test-Path $backendErrLog) {
            Write-Host "  --- 错误日志（最后 20 行）---"
            Get-Content $backendErrLog -Tail 20 -ErrorAction SilentlyContinue
        }
        Stop-ProcessGraceful -ProcessId $backendSupervisorPid | Out-Null
        throw "后端启动失败"
    }
    Write-Host "  后端服务 PID: $realBackendPid (supervisor: $backendSupervisorPid)" -ForegroundColor Green
    # 记录 supervisor PID：stop 时杀 supervisor，/T 连带杀子进程
    $backendPid = $backendSupervisorPid

    Write-Host "  启动前端 (PORT=$FrontendPort, supervisor 模式) ..."
    $viteJs = Resolve-ViteJs
    if (-not $viteJs) {
        Write-Host "  未找到 vite.js，前端启动失败" -ForegroundColor Red
        Write-Host "  回滚：停止已启动的后端 supervisor PID $backendPid ..." -ForegroundColor Yellow
        Stop-ProcessGraceful -ProcessId $backendPid | Out-Null
        throw "未找到 vite.js，请确认 frontend 依赖已安装"
    }
    Write-Host "  vite.js: $viteJs"
    # 注意：-CommandArgs 参数包含空格（vite.js preview --port ...），
    # 用数组传 -ArgumentList 会被空格分词截断；用单字符串传时，外层双引号
    # 会被 PowerShell 吃掉，导致 "vite.js" 后的部分被当作独立参数。
    # 解决方案：用反引号转义内层双引号，让整个 -CommandArgs 值作为一个参数传递。
    # 实际传递：-CommandArgs "\"F:\...\vite.js\" preview --port 4179 --host ::"
    $frontendCommandArgs = "`"$viteJs`" preview --port $FrontendPort --host ::"
    $frontendSupervisorArgs = @(
        '-NoProfile'
        '-ExecutionPolicy', 'Bypass'
        '-File', "`"$supervisorScript`""
        '-Command', 'node'
        # --host :: 让 Vite preview 绑定到 IPv6 双栈（同时接受 IPv4/IPv6 连接）
        '-CommandArgs', "`"$frontendCommandArgs`""
        '-WorkingDirectory', "`"$frontendDir`""
        '-LogStdout', "`"$frontendLog`""
        '-LogStderr', "`"$frontendErrLog`""
    ) -join ' '
    $frontendSupervisor = Start-Process -FilePath 'powershell.exe' -ArgumentList $frontendSupervisorArgs -PassThru -WindowStyle Hidden
    $frontendSupervisorPid = $frontendSupervisor.Id
    Write-Host "  前端 supervisor PID: $frontendSupervisorPid (等待端口监听...)"

    $realFrontendPid = Get-PidByPort -LocalPort $FrontendPort -TimeoutMs 10000
    if (-not $realFrontendPid) {
        Write-Host "  前端启动失败（端口 $FrontendPort 未监听），查看日志 $frontendErrLog" -ForegroundColor Red
        if (Test-Path $frontendErrLog) {
            Write-Host "  --- 错误日志（最后 20 行）---"
            Get-Content $frontendErrLog -Tail 20 -ErrorAction SilentlyContinue
        }
        Stop-ProcessGraceful -ProcessId $frontendSupervisorPid | Out-Null
        Write-Host "  回滚：停止已启动的后端 supervisor PID $backendPid ..." -ForegroundColor Yellow
        Stop-ProcessGraceful -ProcessId $backendPid | Out-Null
        throw "前端启动失败"
    }
    Write-Host "  前端服务 PID: $realFrontendPid (supervisor: $frontendSupervisorPid)" -ForegroundColor Green
    $frontendPid = $frontendSupervisorPid

    Write-PidsFile -BackendPid $backendPid -FrontendPid $frontendPid -BackendPort $Port -FrontendPortNum $FrontendPort

    Write-Title "启动完成"

    Write-Host "  可访问地址：" -ForegroundColor Cyan
    $accessLines = Format-AccessUrls -Ports @($FrontendPort)
    foreach ($line in $accessLines) {
        Write-Host $line
    }
    Write-Host ""
    Write-Host "  提示：前端页面通过 Vite preview 提供，访问前端地址即可使用全部功能。" -ForegroundColor DarkGray
    Write-Host "        后端 API 端口 $Port 通常由前端代理访问，无需直接暴露。" -ForegroundColor DarkGray
    Write-Host ""

    Write-Host "  需要放行的端口（防火墙 / 安全组）：" -ForegroundColor Cyan
    Write-Host "    $FrontendPort  - 前端页面（必须放行，对外提供访问）" -ForegroundColor Yellow
    Write-Host "    $Port          - 后端 API（默认由前端代理访问，如直连需放行）"
    Write-Host "    $rtmpPort      - RTMP 推流端口（使用 OBS 推流时必须放行）"
    Write-Host "    $httpFlvPort   - HTTP-FLV 拉流端口（未配置反向代理时需放行）"
    Write-Host ""

    Write-Host "  PID 文件：$pidsFile"
    Write-Host "  日志目录：$logDir"
    Write-Host "    实时日志：backend.log / backend.err.log / frontend.log / frontend.err.log / frontend-console.log / supervisor.log"
    Write-Host "    历史归档：backend.YYYYMMDD-HHmmss.log 等（保留 7 天）"
    Write-Host ""
    Write-Host "  数据目录：$configDir" -ForegroundColor Cyan
    Write-Host "    升级时仅需保留此目录即可保留全部数据（数据库、用户上传文件、头像等）" -ForegroundColor DarkGray
    Write-Host ""
}

function Invoke-Stop {
    Write-Title "ZViewer 生产服务停止"
    $existing = Read-PidsFile
    if ($existing) {
        if ($existing.backend -and $existing.backend.pid) {
            $backendPort = if ($existing.backend.port) { [int]$existing.backend.port } else { $Port }
            Stop-ServiceByPidOrPort -ProcessId $existing.backend.pid -LocalPort $backendPort
        }
        if ($existing.frontend -and $existing.frontend.pid) {
            $frontendPortNum = if ($existing.frontend.port) { [int]$existing.frontend.port } else { $FrontendPort }
            Stop-ServiceByPidOrPort -ProcessId $existing.frontend.pid -LocalPort $frontendPortNum
        }
        Remove-Item $pidsFile -Force -ErrorAction SilentlyContinue
        Write-Host "  已清理 PID 文件"
    } else {
        Write-Host "  未找到 PID 文件，尝试按端口清理（仅清理监听进程，dev server 也会被停止）..." -ForegroundColor Yellow
        # 读取持久化端口配置；若无配置则使用参数默认值
        $savedPorts = Read-PortsFile
        $bePort = if ($savedPorts) { $savedPorts.backend } else { $Port }
        $fePort = if ($savedPorts) { $savedPorts.frontend } else { $FrontendPort }
        foreach ($p in @($bePort, $fePort)) {
            if ($p -gt 0 -and (Test-PortInUse -LocalPort $p)) {
                $realPid = Get-PidByPort -LocalPort $p -TimeoutMs 500
                if ($realPid) {
                    Write-Host "  端口 $p 被 PID $realPid 占用，停止该进程..."
                    Stop-ProcessGraceful -ProcessId $realPid | Out-Null
                }
            }
        }
    }
    Write-Host ""
    Write-Host "服务已停止" -ForegroundColor Green
    Write-Host ""
}

function Invoke-Restart {
    Write-Title "ZViewer 生产服务重启"
    Invoke-Stop
    Start-Sleep -Seconds 1
    # 重启：跳过依赖检查和构建，直接使用已有产物启动，加快重启速度
    $origSkipBuild = $SkipBuild
    $SkipBuild = $true
    try {
        Invoke-Start
    } finally {
        $SkipBuild = $origSkipBuild
    }
}

function Invoke-Status {
    Write-Title "ZViewer 生产服务状态"

    # 端口已在主入口统一解析（命令行参数 > 配置文件 > 默认值）
    $savedPorts = Read-PortsFile  # 仅用于显示配置文件状态

    # 使用统一的检测函数（PID 文件 + 端口监听双重判定）
    $running = Test-ServiceRunning
    if (-not $running.Running) {
        Write-Host "  服务未运行" -ForegroundColor Yellow
        if ($running.PidFile) {
            Write-Host "  （PID 文件存在但进程已退出，属过期文件）" -ForegroundColor DarkGray
        }
    } else {
        # 后端状态
        Write-Host "  后端:"
        if ($running.PidFile -and $running.PidFile.backend) {
            Write-Host "    PID:   $($running.PidFile.backend.pid) (supervisor)"
            Write-Host "    端口:  $($running.PidFile.backend.port)"
            Write-Host "    URL:   $($running.PidFile.backend.url)"
        } else {
            Write-Host "    PID:   $($running.BackendPid) (无 PID 文件，端口检测)"
            Write-Host "    端口:  $Port"
            Write-Host "    URL:   http://localhost:$Port"
        }
        if ($running.BackendPid) {
            $svcPid = Get-PidByPort -LocalPort $Port -TimeoutMs 500
            if ($svcPid) {
                $source = if ($running.BackendByPort) { "端口检测" } else { "PID 文件" }
                Write-Host "    状态:  运行中 (服务 PID $svcPid, 来源: $source)" -ForegroundColor Green
            } else {
                Write-Host "    状态:  supervisor 运行中，服务正在重启..." -ForegroundColor Yellow
            }
        } else {
            Write-Host "    状态:  supervisor 已退出" -ForegroundColor Red
        }

        Write-Host ""
        Write-Host "  前端:"
        if ($running.PidFile -and $running.PidFile.frontend) {
            Write-Host "    PID:   $($running.PidFile.frontend.pid) (supervisor)"
            Write-Host "    端口:  $($running.PidFile.frontend.port)"
            Write-Host "    URL:   $($running.PidFile.frontend.url)"
        } else {
            Write-Host "    PID:   $($running.FrontendPid) (无 PID 文件，端口检测)"
            Write-Host "    端口:  $FrontendPort"
            Write-Host "    URL:   http://localhost:$FrontendPort"
        }
        if ($running.FrontendPid) {
            $svcPid = Get-PidByPort -LocalPort $FrontendPort -TimeoutMs 500
            if ($svcPid) {
                $source = if ($running.FrontendByPort) { "端口检测" } else { "PID 文件" }
                Write-Host "    状态:  运行中 (服务 PID $svcPid, 来源: $source)" -ForegroundColor Green
            } else {
                Write-Host "    状态:  supervisor 运行中，服务正在重启..." -ForegroundColor Yellow
            }
        } else {
            Write-Host "    状态:  supervisor 已退出" -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "  端口配置:"
    Write-Host "    后端端口: $Port"
    Write-Host "    前端端口: $FrontendPort"
    if ($savedPorts) {
        Write-Host "    配置文件: $portsFile （已持久化）" -ForegroundColor Green
    } else {
        Write-Host "    配置文件: $portsFile （未创建，使用默认值）" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "  端口占用检查:"
    if (Test-PortInUse -LocalPort $Port) {
        Write-Host "    $Port : 占用" -ForegroundColor Yellow
    } else {
        Write-Host "    $Port : 空闲" -ForegroundColor Green
    }
    if (Test-PortInUse -LocalPort $FrontendPort) {
        Write-Host "    $FrontendPort : 占用" -ForegroundColor Yellow
    } else {
        Write-Host "    $FrontendPort : 空闲" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "  构建产物状态:"
    if (Test-BackendBuilt) {
        Write-Host "    backend/dist/index.js : 存在" -ForegroundColor Green
    } else {
        Write-Host "    backend/dist/index.js : 缺失" -ForegroundColor Red
    }
    if (Test-FrontendBuilt) {
        Write-Host "    frontend/dist/index.html : 存在" -ForegroundColor Green
    } else {
        Write-Host "    frontend/dist/index.html : 缺失" -ForegroundColor Red
    }
    Write-Host ""
}

function Invoke-Logs {
    param([string]$LogTarget)
    if (-not $LogTarget) { $LogTarget = 'backend' }
    $logFile = if ($LogTarget -eq 'frontend') { $frontendLog } else { $backendLog }
    $errFile = if ($LogTarget -eq 'frontend') { $frontendErrLog } else { $backendErrLog }
    Write-Title "ZViewer 日志 - $LogTarget"
    if (-not (Test-Path $logFile) -and -not (Test-Path $errFile)) {
        Write-Host "  日志文件不存在：$logFile" -ForegroundColor Yellow
        Write-Host "  提示：服务可能尚未启动"
        return
    }
    if (Test-Path $errFile) {
        Write-Host "  错误日志：$errFile"
        $errTail = Get-Content $errFile -Tail 20 -ErrorAction SilentlyContinue
        if ($errTail) {
            Write-Host "  --- stderr（最后 20 行）---" -ForegroundColor Red
            $errTail | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        }
    }
    if (Test-Path $logFile) {
        Write-Host "  标准输出：$logFile"
        Write-Host "  --- stdout（最后 50 行）---"
        Get-Content $logFile -Tail 50
    }
    Write-Host "  ----------------------------------------"
    Write-Host ""
    Write-Host "  提示：实时跟踪日志请使用 Get-Content $logFile -Wait"
    Write-Host ""
}

function Show-Help {
    Write-Title "ZViewer 生产服务管理脚本"
    Write-Host "用法："
    Write-Host "  .\start-prod.ps1 <command> [options]"
    Write-Host ""
    Write-Host "命令："
    Write-Host "  start     一键启动：自动安装依赖、自动构建缺失产物、启动服务"
    Write-Host "  stop      停止服务"
    Write-Host "  restart   重启服务（不重新构建）"
    Write-Host "  status    查看服务状态（含构建产物检查）"
    Write-Host "  logs      查看日志（默认 backend，可选 frontend）"
    Write-Host "  port      交互式修改端口配置（持久化到 .prod.ports.json）"
    Write-Host "  menu      交互式菜单（双击 .bat 默认进入）"
    Write-Host "  help      显示此帮助"
    Write-Host ""
    Write-Host "选项："
    Write-Host "  -ForceDeps          强制重新安装依赖（默认按需自动安装）"
    Write-Host "  -SkipBuild          跳过自动构建（仅使用已有产物启动）"
    Write-Host "  -Port <int>         后端端口（默认 3333，优先级高于配置文件）"
    Write-Host "  -FrontendPort <int> 前端端口（默认 4173，优先级高于配置文件）"
    Write-Host "  -Database <url>     数据库 URL"
    Write-Host ""
    Write-Host "一键启动说明："
    Write-Host "  无需提前执行 npm install 或 npm run build，脚本会自动检测："
    Write-Host "    1. node_modules 缺失 -> 自动执行 npm ci / npm install"
    Write-Host "    2. 构建产物缺失或源代码已更新 -> 自动执行 npm run build"
    Write-Host "    3. 构建产物已是最新 -> 跳过构建，直接启动"
    Write-Host "  如需跳过自动构建（仅使用已有产物启动），请加 -SkipBuild"
    Write-Host ""
    Write-Host "IPv6 兼容："
    Write-Host "  前后端服务默认绑定到 '::'（IPv6 双栈），同时接受 IPv4 与 IPv6 连接。"
    Write-Host "  可通过 http://<IPv4> 或 http://<IPv6> 访问，兼容纯 IPv6 网络环境。"
    Write-Host ""
    Write-Host "端口优先级："
    Write-Host "  命令行参数 > .prod.ports.json 配置文件 > 默认值"
    Write-Host "  使用 port 子命令或菜单第 7 项可交互式修改并持久化端口"
    Write-Host ""
    Write-Host "示例："
    Write-Host "  .\start-prod.ps1 start                # 一键启动（自动安装+构建）"
    Write-Host "  .\start-prod.ps1 start -SkipBuild     # 跳过构建，仅启动"
    Write-Host "  .\start-prod.ps1 start -ForceDeps     # 强制重新安装依赖"
    Write-Host "  .\start-prod.ps1 start -Port 3001"
    Write-Host "  .\start-prod.ps1 port"
    Write-Host "  .\start-prod.ps1 logs frontend"
    Write-Host ""
}

function Invoke-Menu {
    # 交互式中文菜单循环。.bat 无参数调用时进入此分支。
    # 所有中文输出在 PowerShell 中处理，规避 cmd.exe 对 .bat 的 GBK 解析问题。
    $ErrorActionPreference = "Continue"  # 菜单循环中不能因单条命令失败就退出
    # 非交互式环境（stdin 被重定向，如管道）下 Read-Host 会立即返回 $null/空，导致死循环。
    # 检测到非交互式环境时直接退出，提示用户通过命令行调用子命令。
    if ([Console]::IsInputRedirected) {
        Write-Host "检测到非交互式输入，菜单模式需要在交互式终端中运行。" -ForegroundColor Yellow
        Write-Host "请直接双击 start-prod.bat，或使用子命令：start / stop / restart / status / logs / port / help" -ForegroundColor Yellow
        Write-Host "示例：.\start-prod.ps1 start" -ForegroundColor Cyan
        return
    }
    while ($true) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "  ZViewer 生产服务管理" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "  1. 启动服务"
        Write-Host "  2. 停止服务"
        Write-Host "  3. 重启服务"
        Write-Host "  4. 查看状态"
        Write-Host "  5. 查看后端日志"
        Write-Host "  6. 查看前端日志"
        Write-Host "  7. 修改端口配置"
        Write-Host "  0. 退出"
        Write-Host "========================================"
        $choice = Read-Host "请选择 [0-7]"
        # 防御性：Read-Host 返回空（用户直接按 Enter 或异常）时退出，避免死循环
        if ([string]::IsNullOrWhiteSpace($choice)) {
            Write-Host "未收到输入，退出菜单。" -ForegroundColor Yellow
            return
        }
        switch ($choice) {
            '1' { Invoke-Start }
            '2' { Invoke-Stop }
            '3' { Invoke-Restart }
            '4' { Invoke-Status }
            '5' { Invoke-Logs -LogTarget 'backend' }
            '6' { Invoke-Logs -LogTarget 'frontend' }
            '7' { Invoke-Port }
            '0' { return }
            default { Write-Host "无效选项，请重新选择" -ForegroundColor Yellow; Start-Sleep -Seconds 1 }
        }
        if ($choice -in @('1','2','3','4','5','6','7')) {
            Write-Host ""
            Write-Host "按 Enter 返回菜单..." -NoNewline
            [void](Read-Host)
        }
    }
}

function Invoke-Port {
    # 交互式端口配置：读取/修改后端、前端端口，持久化到 .prod.ports.json
    # 下次 start 时自动读取（命令行 -Port / -FrontendPort 参数优先级更高）
    Write-Title "ZViewer 端口配置"

    # 非交互式环境检测
    if ([Console]::IsInputRedirected) {
        Write-Host "检测到非交互式输入，端口配置需要在交互式终端中运行。" -ForegroundColor Yellow
        Write-Host "也可通过命令行参数指定：.\start-prod.ps1 start -Port 3001 -FrontendPort 4180" -ForegroundColor Cyan
        return
    }

    # 读取当前生效的端口（优先级：配置文件 > 默认值）
    $saved = Read-PortsFile
    $currentBackend = if ($saved) { $saved.backend } else { $Port }
    $currentFrontend = if ($saved) { $saved.frontend } else { $FrontendPort }

    while ($true) {
        Write-Host ""
        Write-Host "  当前端口配置：" -ForegroundColor Cyan
        Write-Host "    后端端口：$currentBackend"
        Write-Host "    前端端口：$currentFrontend"
        if (Test-Path $portsFile) {
            Write-Host "    配置文件：$portsFile （已持久化）" -ForegroundColor Green
        } else {
            Write-Host "    配置文件：$portsFile （未创建，使用默认值）" -ForegroundColor Yellow
        }
        Write-Host ""
        Write-Host "  1. 修改后端端口"
        Write-Host "  2. 修改前端端口"
        Write-Host "  3. 同时修改两个端口"
        Write-Host "  4. 重置为默认值（后端 $Port，前端 $FrontendPort）"
        Write-Host "  0. 返回"
        $choice = Read-Host "请选择 [0-4]"
        if ([string]::IsNullOrWhiteSpace($choice)) { return }

        switch ($choice) {
            '1' {
                $newPort = Read-PortInput -Prompt "  输入新的后端端口" -DefaultValue $currentBackend
                if ($newPort -eq $currentFrontend) {
                    Write-Host "  后端端口不能与前端端口 ($currentFrontend) 相同" -ForegroundColor Red
                    break
                }
                $currentBackend = $newPort
                Write-PortsFile -BackendPort $currentBackend -FrontendPort $currentFrontend
                Write-Host "  已保存：后端端口 = $currentBackend" -ForegroundColor Green
            }
            '2' {
                $newPort = Read-PortInput -Prompt "  输入新的前端端口" -DefaultValue $currentFrontend
                if ($newPort -eq $currentBackend) {
                    Write-Host "  前端端口不能与后端端口 ($currentBackend) 相同" -ForegroundColor Red
                    break
                }
                $currentFrontend = $newPort
                Write-PortsFile -BackendPort $currentBackend -FrontendPort $currentFrontend
                Write-Host "  已保存：前端端口 = $currentFrontend" -ForegroundColor Green
            }
            '3' {
                $newBackend = Read-PortInput -Prompt "  输入新的后端端口" -DefaultValue $currentBackend
                $newFrontend = Read-PortInput -Prompt "  输入新的前端端口" -DefaultValue $currentFrontend
                if ($newBackend -eq $newFrontend) {
                    Write-Host "  后端端口与前端端口不能相同" -ForegroundColor Red
                    break
                }
                $currentBackend = $newBackend
                $currentFrontend = $newFrontend
                Write-PortsFile -BackendPort $currentBackend -FrontendPort $currentFrontend
                Write-Host "  已保存：后端 = $currentBackend，前端 = $currentFrontend" -ForegroundColor Green
            }
            '4' {
                Remove-Item $portsFile -Force -ErrorAction SilentlyContinue
                $currentBackend = $Port
                $currentFrontend = $FrontendPort
                Write-Host "  已重置为默认值：后端 = $currentBackend，前端 = $currentFrontend" -ForegroundColor Green
            }
            '0' { return }
            default { Write-Host "  无效选项" -ForegroundColor Yellow }
        }
    }
}

# ============ 主入口 ============

try {
    # 端口优先级：命令行参数 > .prod.ports.json 配置文件 > 默认值
    # 在进入子命令前统一解析（port 子命令除外，它自己管理配置文件）
    if ($Command -in @('start', 'restart', 'status')) {
        $savedPorts = Read-PortsFile
        if ($savedPorts) {
            if (-not $PSBoundParameters.ContainsKey('Port')) {
                $Port = $savedPorts.backend
            }
            if (-not $PSBoundParameters.ContainsKey('FrontendPort')) {
                $FrontendPort = $savedPorts.frontend
            }
        }
    }

    switch ($Command) {
        'start'   { Invoke-Start }
        'stop'    { Invoke-Stop }
        'restart' { Invoke-Restart }
        'status'  { Invoke-Status }
        'logs'    { Invoke-Logs -LogTarget $Target }
        'port'    { Invoke-Port }
        'menu'    { Invoke-Menu }
        default   { Show-Help }
    }
} catch {
    Write-Host ""
    Write-Host "[错误] $_" -ForegroundColor Red
    Write-Host ""
    exit 1
}
