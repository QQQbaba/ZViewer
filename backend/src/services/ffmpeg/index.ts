/**
 * FFmpeg 服务：检测、在线下载、调用合并。
 *
 * 用途：B站 DASH 模式下载的 m4s 音视频流需要 FFmpeg 合并为单文件。
 *
 * 默认情况下不依赖系统 FFmpeg；用户可在前端「下载 B站视频」二级菜单中
 * 点击「下载 FFmpeg」按钮，由后端拉取静态构建的二进制到项目 `bin/` 目录。
 *
 * 调用优先级：
 *   1. 项目内置 `bin/ffmpeg`（在线下载安装的版本）
 *   2. 系统 PATH 中的 `ffmpeg`
 */
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createWriteStream } from 'node:fs'

/** 项目内置 bin 目录（存放 ffmpeg 二进制） */
export const FFMPEG_BIN_DIR = path.resolve(process.cwd(), 'bin')
/** 内置 ffmpeg 可执行文件路径 */
export const FFMPEG_BIN_PATH = path.join(
  FFMPEG_BIN_DIR,
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
)

/** FFmpeg 下载源（按平台） */
function getDownloadSource(): { url: string; kind: 'zip' | 'tar.xz'; size: number } {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'win32') {
    // Windows: gyan.dev 的 essentials 构建（约 80MB）
    return {
      url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
      kind: 'zip',
      size: 80 * 1024 * 1024,
    }
  }

  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    // Linux: johnvansickle 静态构建
    const suffix = arch === 'arm64' ? 'arm64' : 'amd64'
    return {
      url: `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${suffix}-static.tar.xz`,
      kind: 'tar.xz',
      size: 30 * 1024 * 1024,
    }
  }

  throw new Error(`当前平台 ${platform}-${arch} 暂不支持在线下载 FFmpeg，请手动安装`)
}

export interface FfmpegStatus {
  /** 是否可用（内置或系统 PATH） */
  available: boolean
  /** 来源：'builtin' | 'system' | null */
  source: 'builtin' | 'system' | null
  /** 实际使用的可执行文件路径 */
  path: string | null
  /** 版本号（如 '7.0'） */
  version: string | null
  /** 错误信息（不可用时） */
  error?: string
}

/**
 * 获取 FFmpeg 实际可用的可执行文件路径。
 * 优先级：项目内置 > 系统 PATH。
 * 不可用时返回 null。
 */
export function resolveFfmpegPath(): string | null {
  // 1. 项目内置
  if (fs.existsSync(FFMPEG_BIN_PATH)) {
    try {
      fs.accessSync(FFMPEG_BIN_PATH, fs.constants.X_OK)
      return FFMPEG_BIN_PATH
    } catch {
      // 权限不足，尝试修正
      try {
        fs.chmodSync(FFMPEG_BIN_PATH, 0o755)
        return FFMPEG_BIN_PATH
      } catch {
        // 修正失败，继续尝试系统
      }
    }
  }
  // 2. 系统 PATH（不实际检查，由 getVersion 验证）
  return 'ffmpeg'
}

/**
 * 获取 FFmpeg 版本号。
 * 调用 `ffmpeg -version`，解析第一行的版本号。
 */
export function getFfmpegVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binaryPath, ['-version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      const match = stdout.match(/ffmpeg version\s+([^\s]+)/)
      resolve(match ? match[1] : null)
    })
  })
}

/**
 * 检测 FFmpeg 状态（内置 + 系统）。
 */
export async function checkFfmpeg(): Promise<FfmpegStatus> {
  // 1. 内置
  if (fs.existsSync(FFMPEG_BIN_PATH)) {
    const version = await getFfmpegVersion(FFMPEG_BIN_PATH)
    if (version) {
      return {
        available: true,
        source: 'builtin',
        path: FFMPEG_BIN_PATH,
        version,
      }
    }
  }

  // 2. 系统 PATH
  const sysVersion = await getFfmpegVersion('ffmpeg')
  if (sysVersion) {
    return {
      available: true,
      source: 'system',
      path: 'ffmpeg',
      version: sysVersion,
    }
  }

  return {
    available: false,
    source: null,
    path: null,
    version: null,
    error: '未检测到 FFmpeg，无法下载高画质视频（DASH 合并）',
  }
}

/** 在线下载 FFmpeg 的进度回调 */
export interface InstallProgress {
  /** 当前阶段：downloading | extracting | done | error */
  stage: 'downloading' | 'extracting' | 'done' | 'error'
  /** 已下载字节数 */
  received?: number
  /** 总字节数（未知时为 0） */
  total?: number
  /** 百分比 0-100 */
  percent?: number
  /** 阶段说明文本 */
  message: string
}

/**
 * 在线下载并安装 FFmpeg 到项目 `bin/` 目录。
 *
 * 流程：
 *   1. 下载压缩包到临时文件
 *   2. 解压并提取 ffmpeg 可执行文件到 bin/
 *   3. 赋予可执行权限（非 Windows）
 *   4. 清理临时文件
 *
 * @param onProgress 进度回调
 */
export async function installFfmpeg(
  onProgress?: (p: InstallProgress) => void
): Promise<void> {
  // 确保目录存在
  fs.mkdirSync(FFMPEG_BIN_DIR, { recursive: true })

  const source = getDownloadSource()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-install-'))
  const archivePath = path.join(
    tmpDir,
    source.kind === 'zip' ? 'ffmpeg.zip' : 'ffmpeg.tar.xz'
  )

  try {
    // ===== 阶段 1：下载 =====
    onProgress?.({
      stage: 'downloading',
      received: 0,
      total: source.size,
      percent: 0,
      message: '正在下载 FFmpeg...',
    })

    const res = await fetch(source.url, { redirect: 'follow' })
    if (!res.ok || !res.body) {
      throw new Error(`下载失败：HTTP ${res.status}`)
    }

    const total = Number(res.headers.get('content-length') || '0')
    let received = 0
    let lastPercent = 0

    const fileStream = createWriteStream(archivePath)
    const reader = res.body.getReader()

    // 将 Web ReadableStream 转为 Node Writable
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          fileStream.write(Buffer.from(value))
          received += value.length
          const percent = total > 0 ? Math.floor((received / total) * 100) : 0
          if (percent >= lastPercent + 2 || (total === 0 && received % (512 * 1024) === 0)) {
            lastPercent = percent
            onProgress?.({
              stage: 'downloading',
              received,
              total,
              percent,
              message: `下载中 ${percent}%`,
            })
          }
        }
      }
    }

    await pump()
    await new Promise<void>((resolve, reject) => {
      fileStream.end((err?: Error) => (err ? reject(err) : resolve()))
    })

    onProgress?.({
      stage: 'extracting',
      message: '正在解压并提取 ffmpeg 可执行文件...',
    })

    // ===== 阶段 2：解压并提取 =====
    if (source.kind === 'zip') {
      // Windows zip：使用 PowerShell 解压并查找 ffmpeg.exe
      await extractZipAndFindFfmpeg(archivePath, tmpDir)
    } else {
      // Linux tar.xz：使用 tar 解压
      await extractTarAndFindFfmpeg(archivePath, tmpDir)
    }

    // ===== 阶段 3：完成 =====
    onProgress?.({
      stage: 'done',
      message: 'FFmpeg 安装完成',
    })
  } finally {
    // 清理临时目录
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/** 解压 Windows zip 并提取 ffmpeg.exe 到 bin/ */
async function extractZipAndFindFfmpeg(zipPath: string, _tmpDir: string): Promise<void> {
  // 使用 PowerShell Expand-Archive
  const extractDir = path.join(path.dirname(zipPath), 'extracted')
  fs.mkdirSync(extractDir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const ps = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path "${zipPath}" -DestinationPath "${extractDir}" -Force`,
      ],
      { stdio: 'ignore' }
    )
    ps.on('error', reject)
    ps.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`PowerShell 解压失败，退出码 ${code}`))
    })
  })

  // 递归查找 ffmpeg.exe
  const ffmpegExe = findFileRecursive(extractDir, 'ffmpeg.exe')
  if (!ffmpegExe) {
    throw new Error('解压后未找到 ffmpeg.exe')
  }

  // 复制到 bin/
  fs.copyFileSync(ffmpegExe, FFMPEG_BIN_PATH)
}

/** 解压 Linux tar.xz 并提取 ffmpeg 到 bin/ */
async function extractTarAndFindFfmpeg(
  tarPath: string,
  _tmpDir: string
): Promise<void> {
  const extractDir = path.join(path.dirname(tarPath), 'extracted')
  fs.mkdirSync(extractDir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const tar = spawn(
      'tar',
      ['-xf', tarPath, '-C', extractDir, '--strip-components=0'],
      { stdio: 'ignore' }
    )
    tar.on('error', reject)
    tar.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar 解压失败，退出码 ${code}`))
    })
  })

  // 递归查找 ffmpeg
  const ffmpegBin = findFileRecursive(extractDir, 'ffmpeg')
  if (!ffmpegBin) {
    throw new Error('解压后未找到 ffmpeg')
  }

  // 复制到 bin/ 并赋权
  fs.copyFileSync(ffmpegBin, FFMPEG_BIN_PATH)
  fs.chmodSync(FFMPEG_BIN_PATH, 0o755)
}

/** 递归查找指定文件名 */
function findFileRecursive(dir: string, filename: string): string | null {
  const items = fs.readdirSync(dir, { withFileTypes: true })
  for (const item of items) {
    const fullPath = path.join(dir, item.name)
    if (item.isDirectory()) {
      const found = findFileRecursive(fullPath, filename)
      if (found) return found
    } else if (item.name === filename) {
      return fullPath
    }
  }
  return null
}

// ============ 合并 m4s 流 ============

export interface MergeOptions {
  /** 视频流临时文件路径 */
  videoPath: string
  /** 音频流临时文件路径（无音频时传 undefined） */
  audioPath?: string
  /** 输出文件路径 */
  outputPath: string
  /** 进度回调（percent 0-100） */
  onProgress?: (percent: number, message: string) => void
  /** 总时长（秒），用于计算合并进度 */
  duration?: number
}

/**
 * 调用 FFmpeg 合并视频流和音频流。
 *
 * 使用 `-c copy` 流复制模式（不重新编码，速度快），
 * 输出为 MP4 容器（+faststart 优化流式播放）。
 *
 * 进度通过解析 stderr 的 `time=` 行计算。
 */
export function mergeVideoAudio(opts: MergeOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath()
    if (!ffmpegPath) {
      reject(new Error('FFmpeg 不可用'))
      return
    }

    const args: string[] = [
      '-y', // 覆盖输出
      '-i',
      opts.videoPath,
    ]

    if (opts.audioPath) {
      args.push('-i', opts.audioPath)
    }

    args.push(
      '-c',
      'copy', // 流复制，不重新编码
      '-map',
      '0:v', // 取第一个输入的视频流
      ...(opts.audioPath ? ['-map', '1:a'] : []), // 取第二个输入的音频流
      '-movflags',
      '+faststart', // 优化流式播放
      opts.outputPath
    )

    const ffmpeg = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderrBuffer = ''
    let lastPercent = 0

    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString()
      // 解析进度行：frame= 1234 fps= 56 q=-1.0 size= 1024kB time=00:01:23.45 ...
      const lines = stderrBuffer.split('\n')
      stderrBuffer = lines.pop() || '' // 保留最后一行（可能不完整）

      for (const line of lines) {
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/)
        if (timeMatch && opts.duration && opts.duration > 0) {
          const [, h, m, s] = timeMatch
          const currentTime =
            Number(h) * 3600 + Number(m) * 60 + Number(s)
          const percent = Math.min(
            100,
            Math.floor((currentTime / opts.duration) * 100)
          )
          if (percent >= lastPercent + 2) {
            lastPercent = percent
            opts.onProgress?.(percent, `合并中 ${percent}%`)
          }
        }
      }
    })

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg 启动失败：${err.message}`))
    })

    ffmpeg.on('exit', (code) => {
      if (code === 0) {
        opts.onProgress?.(100, '合并完成')
        resolve()
      } else {
        reject(
          new Error(`FFmpeg 合并失败，退出码 ${code}。${stderrBuffer.slice(-500)}`)
        )
      }
    })
  })
}

/**
 * 流式下载文件到本地路径。
 *
 * 优化点：
 * - 下载失败时自动清理不完整的文件
 * - 进度回调节流：每 2% 或 512KB 触发一次，避免过度回调
 * - 并行下载由调用方控制（DASH 模式视频/音频流 Promise.all）
 *
 * @returns 文件大小（字节）
 */
export async function downloadToFile(
  url: string,
  filePath: string,
  headers?: Record<string, string>,
  onProgress?: (received: number, total: number, percent: number) => void
): Promise<number> {
  const res = await fetch(url, { headers, redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`)
  }

  const total = Number(res.headers.get('content-length') || '0')
  let received = 0
  let lastPercent = 0

  const fileStream = createWriteStream(filePath)
  const reader = res.body.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        fileStream.write(Buffer.from(value))
        received += value.length
        const percent = total > 0 ? Math.floor((received / total) * 100) : 0
        if (percent >= lastPercent + 2 || (total === 0 && received % (512 * 1024) === 0)) {
          lastPercent = percent
          onProgress?.(received, total, percent)
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.end((err?: Error) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    // 下载失败时清理不完整的文件
    try { fs.unlinkSync(filePath) } catch { /* ignore */ }
    throw err
  }

  return received
}
