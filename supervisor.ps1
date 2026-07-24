#!/usr/bin/env pwsh
#Requires -Version 5.1

<#
.SYNOPSIS
  进程 supervisor：监控子进程，崩溃后自动重启
.DESCRIPTION
  由 start-prod.ps1 调用，负责监控单个子进程（后端 node / 前端 vite）并在崩溃后自动重启。
  - 每次重启前递增 RESTART_COUNT 环境变量，子进程可读取用于 /health 端点
  - 达到 MaxRestarts 上限后停止监控
  - 被 taskkill /T /F 终止时连同子进程一起退出，不会进入重启循环
.EXAMPLE
  powershell.exe -File supervisor.ps1 -Command node -CommandArgs "dist/index.js" `
    -WorkingDirectory "F:\Code\ZControl\backend" `
    -LogStdout "F:\Code\ZControl\backend-prod.log" `
    -LogStderr "F:\Code\ZControl\backend-prod.err.log"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [string]$CommandArgs,

    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,

    [Parameter(Mandatory = $true)]
    [string]$LogStdout,

    [Parameter(Mandatory = $true)]
    [string]$LogStderr,

    [int]$MaxRestarts = 20,
    [int]$RestartDelaySec = 2,

    [string]$RestartCountEnv = 'RESTART_COUNT'
)

$ErrorActionPreference = 'Continue'
$restartCount = 0

# supervisor 自身的日志文件（记录重启事件，与子进程 stdout/stderr 分离）
$supervisorLog = Join-Path (Split-Path $LogStdout -Parent) 'supervisor.log'

function Write-SupervisorLog {
    param([string]$Message)
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$timestamp] $Message"
    Write-Host $line
    Add-Content -Path $supervisorLog -Value $line -Encoding UTF8
}

Write-SupervisorLog "supervisor 启动，监控命令: $Command $CommandArgs"
Write-SupervisorLog "工作目录: $WorkingDirectory"
Write-SupervisorLog "最大重启次数: $MaxRestarts，重启间隔: ${RestartDelaySec}s"

while ($true) {
    if ($restartCount -ge $MaxRestarts) {
        Write-SupervisorLog "已达到最大重启次数 $MaxRestarts，supervisor 退出。请手动检查日志后重新启动服务。"
        break
    }

    # 设置重启次数环境变量，子进程（后端）可通过 process.env.RESTART_COUNT 读取
    Set-Item -Path "Env:$RestartCountEnv" -Value "$restartCount"

    # 每次启动前清理旧日志文件，避免文件被前一个进程占用导致重定向失败
    foreach ($logFile in @($LogStdout, $LogStderr)) {
        if (Test-Path $logFile) {
            Remove-Item $logFile -Force -ErrorAction SilentlyContinue
        }
    }

    Write-SupervisorLog "启动子进程 (restart=$restartCount) ..."

    $proc = $null
    try {
        $proc = Start-Process -FilePath $Command -ArgumentList $CommandArgs `
            -WorkingDirectory $WorkingDirectory `
            -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $LogStdout -RedirectStandardError $LogStderr
    } catch {
        Write-SupervisorLog "子进程启动失败: $_"
        $restartCount++
        Start-Sleep -Seconds $RestartDelaySec
        continue
    }

    Write-SupervisorLog "子进程已启动 PID=$($proc.Id) (restart=$restartCount)"

    # 阻塞等待子进程退出
    $proc.WaitForExit()
    $exitCode = $proc.ExitCode

    Write-SupervisorLog "子进程退出 PID=$($proc.Id) exitCode=$exitCode (restart=$restartCount)"

    $restartCount++
    Write-SupervisorLog "${RestartDelaySec}s 后重启 ..."
    Start-Sleep -Seconds $RestartDelaySec
}

Write-SupervisorLog "supervisor 已退出。"
