import { spawn } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import os from 'os';
import { getSystemSettings } from '../system-settings';

const REPO_OWNER = 'Zero-wyc';
const REPO_NAME = 'ZViewer';

/** CDN 加速配置，由调用方从 SystemSettings 读取后传入 */
interface CdnConfig {
  apiCdnDomain?: string;
  releaseCdnDomain?: string;
  mainCdnDomain?: string;
}

/**
 * 将 URL 的 host 替换为 CDN 域名（仅当 host 匹配 originalHost 时）。
 *
 * @param url 原始 URL
 * @param originalHost 需要替换的源站 host（如 api.github.com、objects.githubusercontent.com）
 * @param cdnDomain CDN 加速域名（不含协议，如 api.github.cdn.zero251.xyz）
 * @returns 替换后的 URL（host 不匹配时返回原 URL）
 */
function applyCdnToUrl(url: string, originalHost: string, cdnDomain: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === originalHost) {
      parsed.hostname = cdnDomain.trim();
      return parsed.toString();
    }
    return url;
  } catch {
    return url;
  }
}

export interface UpdateInfo {
  currentVersion: string;
  remoteVersion: string;
  hasUpdate: boolean;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
  downloadUrl: string;
  isPrerelease: boolean;
  assetName: string;
  assetSize: number;
}

/**
 * 判断当前运行环境是单文件版本（pkg 打包）还是 Node.js 开发模式。
 */
function isPkg(): boolean {
  return !!process.pkg;
}

function projectRoot(): string {
  return isPkg() ? process.cwd() : path.resolve(__dirname, '..', '..', '..', '..');
}

/**
 * 获取当前平台对应的构建产物名称。
 */
function getPlatformAssetName(): string {
  return os.platform() === 'win32'
    ? 'zviewer-windows-x64.zip'
    : 'zviewer-linux-x64.tar.gz';
}

/**
 * HTTPS GET JSON — 直接请求 GitHub API，不再经过 CDN 代理。
 */
function httpsGetJson<T>(
  url: string,
  cdnConfig?: CdnConfig,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'ZViewer-Updater',
          Accept: 'application/vnd.github+json',
        },
        timeout: 30_000,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          httpsGetJson<T>(res.headers.location, cdnConfig).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch (err) {
            reject(new Error(`解析响应失败: ${String(err)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

/**
 * 获取本地版本号。
 *
 * 单文件版本（pkg）从同目录的 package.json 读取；
 * 开发模式从项目根目录的 package.json 读取。
 *
 * CI 构建时会注入版本号：
 * - tag 推送 (v*)：版本号为 tag 名（如 1.0.0）
 * - main 分支推送：版本号为 0.0.0-dev.<sha前7位>
 */
function getLocalVersion(): string {
  const root = projectRoot();
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 判断版本号是否为开发版本（0.0.0-dev.xxx 格式）。
 */
function isDevVersion(version: string): boolean {
  return version.startsWith('0.0.0-dev.');
}

/**
 * 比较语义化版本号 a.b.c。
 * 返回 >0 表示 a>b，<0 表示 a<b，0 表示相等。
 */
function compareVersions(a: string, b: string): number {
  const normalize = (v: string) => v.replace(/^v/, '');
  const partsA = normalize(a).split('.').map(Number);
  const partsB = normalize(b).split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const va = partsA[i] || 0;
    const vb = partsB[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

interface GithubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

/**
 * 从 GitHub Releases 检查更新。
 *
 * 版本判断策略：
 *
 * 1. 正式版（!prerelease）：
 *    - 用 tag_name（如 v1.0.0）与本地版本做语义化比较
 *    - 如果本地是开发版本（0.0.0-dev.xxx），正式版总是"有更新"
 *
 * 2. 预发布版（prerelease，tag: latest）：
 *    - 仅当 includePrerelease=true 时才考虑
 *    - tag_name 为 `latest`，无法做语义化比较
 *
 * 整体逻辑：
 * - includePrerelease=false：只看正式版，忽略所有预发布版
 * - includePrerelease=true：优先正式版，无正式版更新时再看预发布版
 * - 本地版本 0.0.0（无法确定）→ 总是提示有更新
 */
export async function getUpdateInfo(
  includePrerelease = false,
): Promise<UpdateInfo> {
  const currentVersion = getLocalVersion();
  const assetName = getPlatformAssetName();

  // 读取 CDN 加速配置
  const settings = await getSystemSettings();
  const cdnConfig: CdnConfig | undefined = settings.cdnAccelerate
    ? {
        apiCdnDomain: settings.apiCdnDomain || undefined,
        releaseCdnDomain: settings.releaseCdnDomain || undefined,
        mainCdnDomain: settings.mainCdnDomain || undefined,
      }
    : undefined;

  // 替换 api.github.com 为 CDN 域名（更新检测加速）
  let apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=10`;
  if (cdnConfig?.apiCdnDomain) {
    apiUrl = applyCdnToUrl(apiUrl, 'api.github.com', cdnConfig.apiCdnDomain);
    console.log(`[updater] CDN 检测加速: ${cdnConfig.apiCdnDomain}`);
  }

  // 获取 releases 列表（包含正式版和预发布版）
  const releases = await httpsGetJson<GithubRelease[]>(apiUrl, cdnConfig);

  if (!releases || releases.length === 0) {
    throw new Error('未找到任何发布版本');
  }

  // 优先找最新正式版
  const stableRelease = releases.find((r) => !r.prerelease);
  // 找最新的 prerelease（通常是 main 分支推送的 latest tag）
  // 仅在 includePrerelease=true 时才考虑预发布版
  const prerelease = includePrerelease
    ? releases.find((r) => r.prerelease)
    : undefined;

  let release: GithubRelease;
  let hasUpdate: boolean;

  // 本地版本无法确定（package.json 不存在或无 version 字段）→ 总是提示有更新
  if (currentVersion === '0.0.0') {
    release = stableRelease || prerelease || releases[0];
    hasUpdate = true;
  } else if (stableRelease) {
    // 有正式版 Release
    const remoteStableVersion = stableRelease.tag_name;

    if (isDevVersion(currentVersion)) {
      // 本地是开发版本 → 正式版总是有更新
      release = stableRelease;
      hasUpdate = true;
    } else {
      // 本地也是正式版 → 语义化版本比较
      const cmp = compareVersions(remoteStableVersion, currentVersion);
      if (cmp > 0) {
        // 正式版比本地新
        release = stableRelease;
        hasUpdate = true;
      } else if (prerelease) {
        // 正式版不比本地新，但有预发布版且用户允许 → 检查预发布版
        release = prerelease;
        hasUpdate = true;
      } else {
        // 无预发布版或用户未开启 → 已是最新
        release = stableRelease;
        hasUpdate = false;
      }
    }
  } else if (prerelease) {
    // 没有正式版 Release，但有预发布版（仅 includePrerelease=true 时到达）
    release = prerelease;

    if (isDevVersion(currentVersion)) {
      // 本地也是开发版本 → 保守提示有更新
      hasUpdate = true;
    } else {
      // 本地是正式版，远程只有预发布版 → 提示有更新
      hasUpdate = true;
    }
  } else {
    // 没有正式版，也没有预发布版（或未开启预发布）
    // 使用第一个 release 作为信息来源，但不提示有更新
    release = releases[0];
    hasUpdate = false;
  }

  const remoteVersion = release.tag_name;
  const asset = release.assets.find((a) => a.name === assetName);

  if (!asset) {
    throw new Error(
      `Release ${remoteVersion} 中未找到平台对应的构建产物 ${assetName}`,
    );
  }

  return {
    currentVersion,
    remoteVersion,
    hasUpdate,
    releaseNotes: release.body || '',
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    downloadUrl: asset.browser_download_url,
    isPrerelease: release.prerelease,
    assetName: asset.name,
    assetSize: asset.size,
  };
}

/**
 * 流式下载文件，支持重定向跟随与进度回调。
 *
 * @param url       下载地址
 * @param dest      目标文件路径
 * @param onProgress 进度回调（每收到一段数据触发一次），参数为已接收字节数和总字节数
 *                   总字节数可能为 0（服务器未返回 content-length）
 */
function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
  cdnConfig?: CdnConfig,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { timeout: 300_000 }, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        // 关闭当前文件流，重定向后重新下载（保留进度回调）
        file.close();
        fs.unlinkSync(dest);
        // CDN 替换：将 objects.githubusercontent.com 替换为 release CDN 域名
        let redirectUrl = res.headers.location;
        if (cdnConfig?.releaseCdnDomain) {
          const before = redirectUrl;
          redirectUrl = applyCdnToUrl(
            redirectUrl,
            'objects.githubusercontent.com',
            cdnConfig.releaseCdnDomain,
          );
          if (redirectUrl !== before) {
            console.log(`[updater] CDN 下载加速: ${cdnConfig.releaseCdnDomain}`);
          }
        }
        downloadFile(redirectUrl, dest, onProgress, cdnConfig)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
        return;
      }
      // 从响应头读取总大小（可能不存在）
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve());
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('下载超时'));
    });
  });
}

/**
 * 解压压缩包到指定目录。
 * - Windows (.zip)：使用 PowerShell Expand-Archive
 * - Linux (.tar.gz)：使用 tar
 */
function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWindows = os.platform() === 'win32';
    let cmd: string;
    let args: string[];

    if (isWindows) {
      const psCmd = `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      cmd = 'powershell';
      args = ['-NoProfile', '-Command', psCmd];
    } else {
      cmd = 'tar';
      args = ['xzf', archivePath, '-C', destDir];
    }

    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`解压失败 (exit ${code}): ${stderr}`));
      }
    });
  });
}

/**
 * 生成 Windows 更新批处理脚本。
 *
 * 与旧版本的区别：
 * - 不再执行 npm install / npm run build（下载的是构建好的单文件产物）
 * - 同时支持单文件版本（exe）和 Node.js 开发模式
 * - 停止服务时同时尝试终止 exe 和 node 进程
 */
function writeApplyUpdateBat(
  root: string,
  tempDir: string,
  extractedDir: string,
): string {
  const batPath = path.join(root, 'apply-update.bat');
  const content = `@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "ROOT=${root.replace(/\\/g, '\\\\')}"
set "TEMP_DIR=${tempDir.replace(/\\/g, '\\\\')}"
set "EXTRACTED_DIR=${extractedDir.replace(/\\/g, '\\\\')}"
set "PIDS_FILE=%ROOT%\\.prod.pids.json"
set "CONFIG_DIR=%ROOT%\\config"
set "CONFIG_BACKUP=%ROOT%\\.config-backup-%%RANDOM%%"

echo [更新脚本] 等待后端返回响应...
timeout /t 3 /nobreak >nul

echo [更新脚本] 停止现有服务...
:: 停止单文件版本进程
taskkill /F /IM zviewer-frontend.exe /T >nul 2>&1
taskkill /F /IM zviewer-backend.exe /T >nul 2>&1
taskkill /F /IM zviewer-cert.exe /T >nul 2>&1

:: 停止 Node.js 开发模式进程
if exist "%PIDS_FILE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "\
    $pids = Get-Content '%PIDS_FILE%' -Raw | ConvertFrom-Json; \
    foreach ($key in $pids.PSObject.Properties.Name) { \
      $info = $pids.$key; \
      if ($info.pid) { \
        Stop-Process -Id $info.pid -Force -ErrorAction SilentlyContinue; \
        Write-Host ('已停止进程 PID: ' + $info.pid); \
      } \
    }"
  del "%PIDS_FILE%"
)
taskkill /F /IM node.exe /T >nul 2>&1

:: 备份 config 目录（包含数据库、用户上传文件、头像等全部用户数据）
echo [更新脚本] 备份 config 目录...
if exist "%CONFIG_DIR%" (
  set "BACKUP_NAME=.config-backup-!RANDOM!"
  set "CONFIG_BACKUP=%ROOT%\\!BACKUP_NAME!"
  xcopy /E /Y /I "%CONFIG_DIR%" "!CONFIG_BACKUP!" >nul
  if errorlevel 1 (
    echo [错误] config 目录备份失败
    pause
    exit /b 1
  )
  echo [更新脚本] 已备份 config 到 !BACKUP_NAME!
  rmdir /S /Q "%CONFIG_DIR%"
)

echo [更新脚本] 应用新文件...
if not exist "%EXTRACTED_DIR%" (
  echo [错误] 未找到解压目录：%EXTRACTED_DIR%
  pause
  exit /b 1
)

xcopy /E /Y /I "%EXTRACTED_DIR%\\*" "%ROOT%\\"
if errorlevel 1 (
  echo [错误] 文件复制失败
  if exist "!CONFIG_BACKUP!" (
    xcopy /E /Y /I "!CONFIG_BACKUP!" "%CONFIG_DIR%" >nul
  )
  pause
  exit /b 1
)

:: 恢复 config 目录（保留用户数据）
echo [更新脚本] 恢复 config 目录...
if exist "!CONFIG_BACKUP!" (
  if not exist "%CONFIG_DIR%" (
    mkdir "%CONFIG_DIR%"
  )
  xcopy /E /Y /I "!CONFIG_BACKUP!\\*" "%CONFIG_DIR%" >nul
  rmdir /S /Q "!CONFIG_BACKUP!"
  echo [更新脚本] 已恢复 config 目录（用户数据已保留）
) else (
  echo [更新脚本] 未检测到 config 备份（可能是首次部署），跳过恢复
)

echo [更新脚本] 清理临时文件...
rmdir /S /Q "%TEMP_DIR%"

echo [更新脚本] 重新启动服务...
start "" "%ROOT%\\start.bat"

echo [更新脚本] 更新完成，服务正在启动...
del "%~f0"
exit
`;
  fs.writeFileSync(batPath, content, 'utf8');
  return batPath;
}

/**
 * 生成 Linux 更新 shell 脚本。
 */
function writeApplyUpdateSh(
  root: string,
  tempDir: string,
  extractedDir: string,
): string {
  const shPath = path.join(root, 'apply-update.sh');
  const content = `#!/bin/bash
set -e

ROOT="${root}"
TEMP_DIR="${tempDir}"
EXTRACTED_DIR="${extractedDir}"
CONFIG_DIR="$ROOT/config"
CONFIG_BACKUP="$ROOT/.config-backup-$$"

echo "[更新脚本] 等待后端返回响应..."
sleep 3

echo "[更新脚本] 停止现有服务..."
pkill -f "zviewer-frontend" 2>/dev/null || true
pkill -f "zviewer-backend" 2>/dev/null || true
pkill -f "zviewer-cert" 2>/dev/null || true

# 备份 config 目录
echo "[更新脚本] 备份 config 目录..."
if [ -d "$CONFIG_DIR" ]; then
  cp -r "$CONFIG_DIR" "$CONFIG_BACKUP"
  rm -rf "$CONFIG_DIR"
  echo "[更新脚本] 已备份 config 到 $CONFIG_BACKUP"
fi

echo "[更新脚本] 应用新文件..."
if [ ! -d "$EXTRACTED_DIR" ]; then
  echo "[错误] 未找到解压目录：$EXTRACTED_DIR"
  exit 1
fi

cp -rf "$EXTRACTED_DIR/"* "$ROOT/" 2>/dev/null || true
chmod +x "$ROOT/zviewer-frontend" "$ROOT/zviewer-backend" "$ROOT/zviewer-cert" 2>/dev/null || true

# 恢复 config 目录
echo "[更新脚本] 恢复 config 目录..."
if [ -d "$CONFIG_BACKUP" ]; then
  mkdir -p "$CONFIG_DIR"
  cp -rf "$CONFIG_BACKUP/"* "$CONFIG_DIR/" 2>/dev/null || true
  rm -rf "$CONFIG_BACKUP"
  echo "[更新脚本] 已恢复 config 目录（用户数据已保留）"
fi

echo "[更新脚本] 清理临时文件..."
rm -rf "$TEMP_DIR"

echo "[更新脚本] 重新启动服务..."
cd "$ROOT"
nohup ./start.sh > /dev/null 2>&1 &

echo "[更新脚本] 更新完成，服务正在启动..."
rm -f "$0"
exit 0
`;
  fs.writeFileSync(shPath, content, 'utf8');
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

/**
 * 更新过程阶段事件，供 SSE 流式接口推送进度。
 */
export type UpdateStageEvent =
  | { stage: 'downloading'; received: number; total: number }
  | { stage: 'extracting' }
  | { stage: 'starting' }
  | { stage: 'done'; message: string }
  | { stage: 'error'; message: string };

/**
 * 应用更新（从已下载或已上传的压缩包）。
 *
 * 流程：
 * 1. 将压缩包保存到临时目录（若为 URL 则流式下载，支持进度回调）
 * 2. 解压
 * 3. 生成更新脚本（bat/sh）
 * 4. detached 启动更新脚本，后台替换文件并重启
 *
 * @param onStage 阶段事件回调，用于推送下载/解压/启动进度
 */
async function applyUpdateFromArchive(
  archiveData: Buffer | string,
  archiveFilename: string,
  onStage?: (event: UpdateStageEvent) => void,
  cdnConfig?: CdnConfig,
): Promise<{ success: boolean; message: string }> {
  const root = projectRoot();
  const tempDir = path.join(root, '.update-temp');
  const archivePath = path.join(tempDir, archiveFilename);

  // 清理并创建临时目录
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 写入压缩包
    if (typeof archiveData === 'string') {
      // archiveData 是 URL，需要下载（带进度），透传 CDN 配置
      await downloadFile(archiveData, archivePath, (received, total) => {
        if (onStage) onStage({ stage: 'downloading', received, total });
      }, cdnConfig);
    } else {
      fs.writeFileSync(archivePath, archiveData);
    }

    // 解压
    if (onStage) onStage({ stage: 'extracting' });
    await extractArchive(archivePath, tempDir);

    // 找到解压后的产物目录
    // GitHub Release 的 zip/tar.gz 解压后通常直接包含文件（无外层目录）
    // 但也可能有外层目录，需要检查
    let extractedDir = tempDir;
    const entries = fs.readdirSync(tempDir).filter(
      (name) => !name.endsWith('.zip') && !name.endsWith('.tar.gz'),
    );
    // 如果解压后只有一个目录且不包含 exe/可执行文件，进入该目录
    if (entries.length === 1) {
      const onlyEntry = path.join(tempDir, entries[0]);
      if (fs.statSync(onlyEntry).isDirectory()) {
        const subEntries = fs.readdirSync(onlyEntry);
        const hasExe = subEntries.some(
          (name) =>
            name.startsWith('zviewer-') ||
            name === 'start.bat' ||
            name === 'start.sh',
        );
        if (hasExe) {
          extractedDir = onlyEntry;
        }
      }
    }

    // 生成并启动更新脚本
    if (onStage) onStage({ stage: 'starting' });
    const isWindows = os.platform() === 'win32';
    const scriptPath = isWindows
      ? writeApplyUpdateBat(root, tempDir, extractedDir)
      : writeApplyUpdateSh(root, tempDir, extractedDir);

    if (isWindows) {
      spawn('cmd', ['/c', scriptPath], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      spawn('bash', [scriptPath], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
      }).unref();
    }

    const successMessage = '更新已触发，后台将自动替换文件并重启服务';
    if (onStage) onStage({ stage: 'done', message: successMessage });
    return {
      success: true,
      message: successMessage,
    };
  } catch (err) {
    // 清理临时文件
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup error
    }
    const errMsg = err instanceof Error ? err.message : '应用更新失败';
    if (onStage) onStage({ stage: 'error', message: errMsg });
    throw err;
  }
}

/**
 * 从 GitHub Releases 下载最新构建产物并应用更新。
 *
 * @param includePrerelease 是否包含预发布版本
 * @param onStage 阶段事件回调，用于推送下载/解压/启动进度
 */
export async function applyUpdate(
  includePrerelease = false,
  onStage?: (event: UpdateStageEvent) => void,
): Promise<{
  success: boolean;
  message: string;
}> {
  const info = await getUpdateInfo(includePrerelease);
  if (!info.downloadUrl) {
    throw new Error('未找到可用的下载地址');
  }

  // 读取 CDN 配置（getUpdateInfo 已读取一次，这里再读一次确保最新）
  const settings = await getSystemSettings();
  const cdnConfig: CdnConfig | undefined = settings.cdnAccelerate
    ? {
        apiCdnDomain: settings.apiCdnDomain || undefined,
        releaseCdnDomain: settings.releaseCdnDomain || undefined,
        mainCdnDomain: settings.mainCdnDomain || undefined,
      }
    : undefined;

  // 若配置了 main CDN 域名，将 downloadUrl 的 github.com 替换为 CDN 域名
  // 这样 Release 下载第一步（请求 github.com 获取 302）也走 CDN 加速
  let downloadUrl = info.downloadUrl;
  if (cdnConfig?.mainCdnDomain) {
    downloadUrl = applyCdnToUrl(downloadUrl, 'github.com', cdnConfig.mainCdnDomain);
    console.log(`[updater] CDN 主站加速: ${cdnConfig.mainCdnDomain}`);
  }

  // downloadFile 在 302 重定向跟随时会替换 objects.githubusercontent.com 为 release CDN 域名
  return applyUpdateFromArchive(downloadUrl, info.assetName, onStage, cdnConfig);
}

/**
 * 从用户上传的压缩包应用更新。
 *
 * @param fileData 压缩包文件的 Buffer 数据
 * @param filename 原始文件名（用于判断压缩格式）
 * @param onStage 阶段事件回调（上传场景无下载阶段，仅推送解压/启动/完成）
 */
export async function applyUpdateFromFile(
  fileData: Buffer,
  filename: string,
  onStage?: (event: UpdateStageEvent) => void,
): Promise<{ success: boolean; message: string }> {
  // 验证文件类型
  const lowerName = filename.toLowerCase();
  if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.tar.gz')) {
    throw new Error('仅支持 .zip 或 .tar.gz 格式的压缩包');
  }

  // 统一使用 .zip 或 .tar.gz 扩展名保存
  const archiveName = lowerName.endsWith('.tar.gz')
    ? 'uploaded-update.tar.gz'
    : 'uploaded-update.zip';

  return applyUpdateFromArchive(fileData, archiveName, onStage);
}
