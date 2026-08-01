# release-zip.ps1 —— ZViewer 一键打包发布脚本（源码发布包）
#
# 功能：
#   1. 自动构建前后端代码（npm run build，workspaces 同时构建）
#   2. 将项目源码 + 构建产物（backend/dist / frontend/dist）打包为可分发的 zip
#   3. 自动排除依赖 / 数据库 / 环境配置 / 日志 / 测试文件 / IDE 临时文件
#      （并排除根目录 dist/ 单文件版产物，避免发布包体积膨胀）
#   4. 接收者解压后执行 npm install --omit=dev，再执行 npm start 即可运行（无需再构建）
#
# 用法：
#   .\release-zip.ps1              打包到项目根目录，文件名带时间戳
#   .\release-zip.ps1 -OutputPath <路径>  指定输出 zip 路径
#   .\release-zip.ps1 -SkipBuild   跳过构建步骤（使用已有构建产物）
#   .\release-zip.ps1 -NoClean     保留临时目录（调试用）
#   .\release-zip.ps1 -Help        显示帮助

param(
  [string]$OutputPath = '',
  [switch]$SkipBuild,
  [switch]$NoClean,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

# 统一控制台编码，保证 zh-CN 系统（默认 GBK）下中文输出正常
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

# ==================== 排除规则 ====================

# 按目录名排除（匹配任意层级的同名目录）
# 注意：不排除 dist —— backend/dist 与 frontend/dist 构建产物需要打包
$excludeDirs = @(
  'node_modules',
  '.git',
  '.trae',
  '.update-temp',
  '.vscode',
  '.idea',
  '__pycache__',
  '.next',
  'coverage',
  'test-media',
  # 数据根目录：含数据库、用户上传文件、头像等敏感数据，禁止打包
  # 升级时由用户保留旧版本的 config/ 目录覆盖到新版本
  'config'
)

# 按完整路径排除（仅排除根目录下的特定目录，不影响 backend/frontend 下的同名目录）
# 根目录 dist/ 是单文件版产物（zviewer-*.exe 等，体积大），源码发布包不需要
$excludeRootDirs = @(
  'dist',
  'log'
)

# 按文件名排除
$excludeFiles = @(
  '.env',
  '.env.local',
  '.prod.pids.json',
  '.prod.ports.json',
  'dev.sqlite',
  'test-dev.sqlite',
  # 测试脚本与输出
  'test-browser.py',
  'verify_specs.py',
  'test-resolve.mjs',
  'test-resolve-output.txt',
  'test-refactor-output.txt',
  'verify-bili-vip-failure.png',
  # 打包脚本自身
  'release-zip.ps1',
  'release-zip.bat',
  # 临时检查文件
  '.check-ps1.ps1',
  '.check-sqlite.js',
  '.check-sqlite.ps1',
  '.add-bom.ps1'
)

# 按扩展名排除
$excludeExts = @('.sqlite', '.sqlite-journal', '.sqlite-wal', '.sqlite-shm', '.log')

# ==================== 辅助函数 ====================

function Write-Title {
  param([string]$Text)
  Write-Host ''
  Write-Host ('=' * 60) -ForegroundColor Cyan
  Write-Host "  $Text" -ForegroundColor Cyan
  Write-Host ('=' * 60) -ForegroundColor Cyan
  Write-Host ''
}

function Show-Help {
  Write-Title 'ZViewer 一键打包发布脚本（源码发布包）'
  Write-Host '用法：' -ForegroundColor Yellow
  Write-Host '  .\release-zip.ps1               打包到项目根目录，文件名带时间戳'
  Write-Host '  .\release-zip.ps1 -OutputPath <路径>  指定输出 zip 路径'
  Write-Host '  .\release-zip.ps1 -SkipBuild    跳过构建步骤（使用已有构建产物）'
  Write-Host '  .\release-zip.ps1 -NoClean      保留临时目录（调试用）'
  Write-Host '  .\release-zip.ps1 -Help         显示本帮助'
  Write-Host ''
  Write-Host '打包流程：' -ForegroundColor Yellow
  Write-Host '  1. 构建前后端代码（npm run build，可 -SkipBuild 跳过）'
  Write-Host '  2. 复制源码 + 构建产物到临时目录（排除敏感/无关文件）'
  Write-Host '  3. 压缩为 zip'
  Write-Host '  4. 验证输出'
  Write-Host ''
  Write-Host '排除内容：' -ForegroundColor Yellow
  Write-Host '  依赖：node_modules'
  Write-Host '  单文件版产物：根目录 dist/（zviewer-*.exe 等，发布包不需要）'
  Write-Host '  数据根目录：config/（含数据库、上传文件、头像等敏感数据）'
  Write-Host '  数据库：*.sqlite / *.sqlite-journal / *.sqlite-wal / *.sqlite-shm'
  Write-Host '  环境配置：.env / .env.local'
  Write-Host '  运行时状态：.prod.pids.json / .prod.ports.json'
  Write-Host '  日志：log/ 与 *.log'
  Write-Host '  版本控制：.git'
  Write-Host '  IDE：.vscode / .idea / .trae'
  Write-Host '  测试：test-* / verify-* / test-media/'
  Write-Host ''
  Write-Host '包含内容：' -ForegroundColor Yellow
  Write-Host '  所有源码、配置、文档、启动脚本、Docker 文件'
  Write-Host '  构建产物：backend/dist / frontend/dist（接收者无需再构建）'
  Write-Host ''
  Write-Host '接收者使用方式：' -ForegroundColor Yellow
  Write-Host '  首次部署：'
  Write-Host '    1. 解压 zip'
  Write-Host '    2. 复制 backend/.env.example 为 backend/.env 并配置'
  Write-Host '    3. npm install --omit=dev   # 仅安装运行时依赖'
  Write-Host '    4. .\start-prod.bat start（或 npm start）'
  Write-Host ''
  Write-Host '  升级（保留用户数据）：'
  Write-Host '    1. 停止旧版本服务'
  Write-Host '    2. 备份旧版本的 config/ 目录（包含数据库、上传文件、头像等）'
  Write-Host '    3. 解压新版本 zip 到新目录（或覆盖旧目录）'
  Write-Host '    4. 将备份的 config/ 目录复制到新版本根目录'
  Write-Host '    5. npm install --omit=dev'
  Write-Host '    6. .\start-prod.bat start（或 npm start）'
  Write-Host ''
}

# ==================== 构建 ====================

function Invoke-Build {
  Write-Title '步骤 1/4：构建前后端代码'

  Write-Host '  执行 npm run build（通过 workspaces 同时构建前后端）...' -ForegroundColor Yellow
  Push-Location $root
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) {
      throw "构建失败，npm run build 退出码：$LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  # 验证产物
  $backendArtifact = Join-Path $root 'backend\dist\index.js'
  $frontendArtifact = Join-Path $root 'frontend\dist\index.html'
  if (-not (Test-Path $backendArtifact)) {
    throw "后端构建产物不存在：$backendArtifact"
  }
  if (-not (Test-Path $frontendArtifact)) {
    throw "前端构建产物不存在：$frontendArtifact"
  }

  Write-Host '  构建成功：' -ForegroundColor Green
  Write-Host "    backend/dist/index.js"
  Write-Host "    frontend/dist/index.html"
  Write-Host ''
}

# ==================== 打包 ====================

function Invoke-Release {
  Write-Title 'ZViewer 一键打包发布（源码发布包）'

  # 1. 确定输出路径
  if ($OutputPath) {
    $dest = $OutputPath
    if (-not $dest.EndsWith('.zip')) { $dest += '.zip' }
    if (-not [System.IO.Path]::IsPathRooted($dest)) {
      $dest = Join-Path $root $dest
    }
  } else {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmm'
    $dest = Join-Path $root "ZViewer-release-$timestamp.zip"
  }

  Write-Host '打包配置：' -ForegroundColor Yellow
  Write-Host "  源目录：$root"
  Write-Host "  输出：$dest"
  Write-Host "  构建步骤：$(if ($SkipBuild) { '跳过（使用已有产物）' } else { '执行构建' })"
  Write-Host ''

  # 2. 构建（或校验已有产物）
  if (-not $SkipBuild) {
    Invoke-Build
  } else {
    Write-Host '步骤 1/4：跳过构建（-SkipBuild）' -ForegroundColor Yellow
    $backendArtifact = Join-Path $root 'backend\dist\index.js'
    $frontendArtifact = Join-Path $root 'frontend\dist\index.html'
    if (-not (Test-Path $backendArtifact)) {
      throw "未找到后端构建产物：$backendArtifact（请去掉 -SkipBuild 重新打包）"
    }
    if (-not (Test-Path $frontendArtifact)) {
      throw "未找到前端构建产物：$frontendArtifact（请去掉 -SkipBuild 重新打包）"
    }
    Write-Host '  使用已有构建产物' -ForegroundColor Green
    Write-Host ''
  }

  # 3. 复制文件到临时目录
  $tempBase = Join-Path $env:TEMP "zviewer-release-$(Get-Date -Format 'yyyyMMddHHmmss')"
  $tempDir = Join-Path $tempBase 'ZViewer'
  Write-Host '步骤 2/4：复制文件（含构建产物，过滤敏感/无关内容）...' -ForegroundColor Yellow
  Write-Host "  临时目录：$tempDir"
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

  try {
    # 使用 robocopy 复制（高效 + 原生排除规则；退出码 < 8 视为成功）
    $robocopyArgs = @(
      $root,
      $tempDir,
      '/E',           # 包含子目录（含空目录）
      '/NFL',         # 不列出文件
      '/NDL',         # 不列出目录
      '/NJH',         # 不显示作业头
      '/NJS',         # 不显示作业摘要
      '/NP',          # 不显示进度
      '/R:1',         # 失败重试 1 次
      '/W:1'          # 重试间隔 1 秒
    )

    # 排除目录（按目录名匹配任意层级）
    foreach ($dir in $excludeDirs) {
      $robocopyArgs += '/XD'
      $robocopyArgs += $dir
    }
    # 排除根目录特定目录（绝对路径，只排除根级）
    foreach ($dir in $excludeRootDirs) {
      $robocopyArgs += '/XD'
      $robocopyArgs += (Join-Path $root $dir)
    }

    # 排除文件（按文件名或通配符）
    foreach ($file in $excludeFiles) {
      $robocopyArgs += '/XF'
      $robocopyArgs += $file
    }
    # 排除扩展名
    foreach ($ext in $excludeExts) {
      $robocopyArgs += '/XF'
      $robocopyArgs += "*$ext"
    }

    & robocopy @robocopyArgs | Out-Null
    $robocopyExit = $LASTEXITCODE
    if ($robocopyExit -ge 8) {
      throw "robocopy 失败，退出码：$robocopyExit"
    }

    $fileCount = (Get-ChildItem -Path $tempDir -Recurse -File).Count
    $dirCount = (Get-ChildItem -Path $tempDir -Recurse -Directory).Count
    Write-Host "  已复制 $fileCount 个文件，$dirCount 个目录" -ForegroundColor Green

    # 验证构建产物已包含
    $tempBackendArtifact = Join-Path $tempDir 'backend\dist\index.js'
    $tempFrontendArtifact = Join-Path $tempDir 'frontend\dist\index.html'
    if (-not (Test-Path $tempBackendArtifact)) {
      throw "构建产物未正确复制到临时目录：$tempBackendArtifact"
    }
    if (-not (Test-Path $tempFrontendArtifact)) {
      throw "构建产物未正确复制到临时目录：$tempFrontendArtifact"
    }
    # 验证根目录 dist/（单文件版产物）未被复制
    if (Test-Path (Join-Path $tempDir 'dist')) {
      throw "根目录 dist/（单文件版产物）不应出现在源码发布包中"
    }
    Write-Host '  构建产物已包含：backend/dist / frontend/dist' -ForegroundColor Green
    Write-Host '  已排除：根目录 dist/（单文件版产物）、config/、node_modules/ 等' -ForegroundColor Green

    # 4. 压缩
    Write-Host ''
    Write-Host '步骤 3/4：压缩为 zip...' -ForegroundColor Yellow
    if (Test-Path $dest) {
      Remove-Item $dest -Force
      Write-Host "  已覆盖旧文件：$dest"
    }
    Compress-Archive -Path (Join-Path $tempDir '*') -DestinationPath $dest -CompressionLevel Optimal
    Write-Host '  压缩完成' -ForegroundColor Green

    # 5. 验证输出
    Write-Host ''
    Write-Host '步骤 4/4：验证输出...' -ForegroundColor Yellow
    if (-not (Test-Path $dest)) {
      throw "输出文件未生成：$dest"
    }
    $destItem = Get-Item $dest
    $sizeMB = $destItem.Length / 1MB

    Write-Title '打包完成'
    Write-Host '输出文件：' -ForegroundColor Yellow
    Write-Host "  路径：$($destItem.FullName)" -ForegroundColor Green
    Write-Host ("  大小：{0:N2} MB" -f $sizeMB) -ForegroundColor Green
    Write-Host "  文件数：$fileCount" -ForegroundColor Green
    Write-Host ''
    Write-Host '接收者使用方式：' -ForegroundColor Yellow
    Write-Host '  首次部署：解压 → 配置 .env → npm install --omit=dev → .\start-prod.bat start（或 npm start）'
    Write-Host '  升级：保留旧版本 config/ 目录 → 覆盖到新版本根目录 → npm install --omit=dev → .\start-prod.bat start（或 npm start）'
    Write-Host ''
  } finally {
    # 清理临时目录
    if (-not $NoClean -and (Test-Path $tempBase)) {
      Write-Host '清理临时目录...' -ForegroundColor Yellow
      Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
    } elseif ($NoClean) {
      Write-Host "保留临时目录（-NoClean）：$tempBase" -ForegroundColor Yellow
    }
  }
}

# ==================== 入口 ====================

if ($Help) {
  Show-Help
  exit 0
}

try {
  Invoke-Release
  exit 0
} catch {
  Write-Host ''
  Write-Host "打包失败：$_" -ForegroundColor Red
  Write-Host ''
  exit 1
}
