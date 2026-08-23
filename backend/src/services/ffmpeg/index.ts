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
import AdmZip from 'adm-zip'
import { PROJECT_ROOT } from '../paths'

/** 项目内置 bin 目录（存放 ffmpeg 二进制） */
export const FFMPEG_BIN_DIR = path.resolve(PROJECT_ROOT, 'bin')
/** 内置 ffmpeg 可执行文件路径 */
export const FFMPEG_BIN_PATH = path.join(
  FFMPEG_BIN_DIR,
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
)

/** 内置 ffprobe 可执行文件路径 */
export const FFPROBE_BIN_PATH = path.join(
  FFMPEG_BIN_DIR,
  process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
)

/** 下载源（按平台）。供在线安装与手动下载链接生成共用（服务端平台为准）。 */
export function getDownloadSource(): { url: string; kind: 'zip' | 'tar.xz'; size: number } {
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

  if (platform === 'linux' && arch === 'x64') {
    // Linux: BtbN/FFmpeg-Builds GitHub Releases 静态构建
    return {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
      kind: 'tar.xz',
      size: 140 * 1024 * 1024,
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
    // 重置缓存，确保下次检测使用新安装的 FFmpeg
    resetFfmpegCache()
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
  // 使用 adm-zip（纯 JavaScript）解压，不依赖系统 PowerShell
  const extractDir = path.join(path.dirname(zipPath), 'extracted')
  fs.mkdirSync(extractDir, { recursive: true })

  const zip = new AdmZip(zipPath)
  zip.extractAllTo(extractDir, true)

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

// ============ 手动安装（从用户上传的压缩包）============

/**
 * 从用户上传的压缩包安装 FFmpeg 到项目 `bin/` 目录。
 *
 * 支持 zip（Windows）和 tar.xz/tar.gz（Linux）两种格式。
 * 根据服务器平台查找对应的 ffmpeg 可执行文件。
 *
 * @param archivePath  用户上传的压缩包临时路径
 */
export async function installFfmpegFromZip(archivePath: string): Promise<void> {
  fs.mkdirSync(FFMPEG_BIN_DIR, { recursive: true })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-manual-'))
  try {
    const extractDir = path.join(tmpDir, 'extracted')
    fs.mkdirSync(extractDir, { recursive: true })

    // 根据文件扩展名选择解压方式
    const lowerPath = archivePath.toLowerCase()
    if (lowerPath.endsWith('.zip')) {
      // zip：使用 adm-zip（纯 JavaScript），不依赖系统命令
      const zip = new AdmZip(archivePath)
      zip.extractAllTo(extractDir, true)
    } else if (lowerPath.endsWith('.tar.xz') || lowerPath.endsWith('.tar.gz') || lowerPath.endsWith('.tgz')) {
      // tar.xz / tar.gz：使用系统 tar 命令
      // 注意：tar.xz 需要系统安装 xz-utils（Docker 中需在 Dockerfile 添加）
      await new Promise<void>((resolve, reject) => {
        const tar = spawn(
          'tar',
          ['-xf', archivePath, '-C', extractDir, '--strip-components=0'],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let stderr = ''
        tar.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })
        tar.on('error', (err) => {
          reject(new Error(`tar 命令执行失败：${err.message}。如果是 Docker 环境，请确保 Dockerfile 中已安装 xz-utils`))
        })
        tar.on('exit', (code) => {
          if (code === 0) resolve()
          else {
            const hint = lowerPath.endsWith('.xz')
              ? '（可能缺少 xz-utils，Docker 用户请在 Dockerfile 中添加 xz-utils）'
              : ''
            reject(new Error(`tar 解压失败，退出码 ${code}${hint}${stderr ? '\n' + stderr.trim() : ''}`))
          }
        })
      })
    } else {
      throw new Error('不支持的压缩包格式，请上传 .zip、.tar.xz 或 .tar.gz 文件')
    }

    // 递归查找 ffmpeg 可执行文件（按服务器平台区分）
    const ffmpegExeName =
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    const ffmpegBin = findFileRecursive(extractDir, ffmpegExeName)
    if (!ffmpegBin) {
      throw new Error(`解压后未找到 ${ffmpegExeName}，请确认压缩包内包含与服务器平台匹配的 ffmpeg 可执行文件`)
    }

    // 复制到 bin/
    fs.copyFileSync(ffmpegBin, FFMPEG_BIN_PATH)

    // 非 Windows 赋予可执行权限
    if (process.platform !== 'win32') {
      fs.chmodSync(FFMPEG_BIN_PATH, 0o755)
    }

    // 重置缓存
    resetFfmpegCache()
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
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

// ============ ffprobe 媒体探测 ============

/**
 * 获取 ffprobe 实际可用的可执行文件路径。
 * 优先级与 resolveFfmpegPath 一致：项目内置 > 系统 PATH。
 */
export function resolveFfprobePath(): string | null {
  // 1. 项目内置
  if (fs.existsSync(FFPROBE_BIN_PATH)) {
    try {
      fs.accessSync(FFPROBE_BIN_PATH, fs.constants.X_OK)
      return FFPROBE_BIN_PATH
    } catch {
      try {
        fs.chmodSync(FFPROBE_BIN_PATH, 0o755)
        return FFPROBE_BIN_PATH
      } catch {
        // 修正失败，继续尝试系统
      }
    }
  }
  // 2. 系统 PATH
  return 'ffprobe'
}

/** 字幕提取输出格式（对应 ffmpeg 的 -f 参数）。ass 用于保留 ASS/SSA 样式与定位。 */
export type SubtitleOutputFormat = 'srt' | 'ass' | 'webvtt'

/**
 * 根据 ffprobe 的内嵌字幕编码推导 ffmpeg 的提取输出格式，尽量保留原始样式：
 * - ASS/SSA → ass（保留样式/定位，SSA 由 ffmpeg 自动转 ASS）
 * - webvtt  → webvtt
 * - 其余（subrip / mov_text 等）→ srt
 */
export function mapCodecToSubtitleFormat(codecName: string): SubtitleOutputFormat {
  switch (codecName) {
    case 'ass':
    case 'ssa':
      return 'ass'
    case 'webvtt':
      return 'webvtt'
    default:
      return 'srt'
  }
}

export interface SubtitleStreamInfo {
  /** ffprobe 流索引（0-based，在所有流中的绝对索引） */
  index: number
  /** 字幕编码格式（如 'subrip', 'ass', 'mov_text', 'webvtt'） */
  codecName: string
  /** 语言标签（如 'chi', 'eng', 'jpn'），可能为空 */
  language: string | null
  /** 字幕轨道标题（如 '简体中文'），可能为空 */
  title: string | null
}

export interface MediaProbeInfo {
  /** 音频编码（如 'aac', 'dts', 'ac3', 'eac3'），无音频流时为 null */
  audioCodec: string | null
  /** 视频编码（如 'h264', 'hevc'），无视频流时为 null */
  videoCodec: string | null
  /** 时长（秒） */
  duration: number | null
  /** 内嵌字幕轨道列表（可能为空数组） */
  subtitleStreams: SubtitleStreamInfo[]
}

/** 探测结果内存缓存（key = 文件路径） */
const probeCache = new Map<string, MediaProbeInfo>()

/**
 * 使用 ffprobe 探测媒体文件的音视频编码、时长和内嵌字幕轨道。
 *
 * 结果缓存在内存中，避免重复探测同一文件。
 * ffprobe 不可用时返回全 null。
 */
export function probeMediaInfo(
  input: string,
  opts?: { headers?: string },
): Promise<MediaProbeInfo> {
  const cacheKey = opts?.headers ? `${input}\n${opts.headers}` : input
  const cached = probeCache.get(cacheKey)
  if (cached) return Promise.resolve(cached)

  const ffprobePath = resolveFfprobePath()
  if (!ffprobePath) return Promise.resolve({ audioCodec: null, videoCodec: null, duration: null, subtitleStreams: [] })

  return new Promise((resolve) => {
    execFile(
      ffprobePath,
      [
        '-v', 'error',
        ...(opts?.headers ? ['-headers', opts.headers] : []),
        '-show_entries', 'stream=index,codec_name,codec_type:stream_tags=language,title',
        '-show_entries', 'format=duration',
        '-of', 'json',
        input,
      ],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) {
          resolve({ audioCodec: null, videoCodec: null, duration: null, subtitleStreams: [] })
          return
        }
        try {
          const data = JSON.parse(stdout)
          const duration = parseFloat(data.format?.duration) || null

          let audioCodec: string | null = null
          const subtitleStreams: SubtitleStreamInfo[] = []

          for (const stream of data.streams || []) {
            if (stream.codec_type === 'audio' && !audioCodec) {
              audioCodec = stream.codec_name || null
            } else if (stream.codec_type === 'subtitle') {
              subtitleStreams.push({
                index: stream.index,
                codecName: stream.codec_name || 'unknown',
                language: stream.tags?.language || null,
                title: stream.tags?.title || null,
              })
            }
          }

          const result: MediaProbeInfo = {
            audioCodec,
            videoCodec: null,
            duration,
            subtitleStreams,
          }
          probeCache.set(cacheKey, result)
          resolve(result)
        } catch {
          resolve({ audioCodec: null, videoCodec: null, duration: null, subtitleStreams: [] })
        }
      }
    )
  })
}

/**
 * 使用 ffmpeg 提取指定字幕轨道为指定格式文本。
 *
 * @param input       源文件路径或 http(s)/ftp URL（服务器中转源可以传 URL）
 * @param streamIndex ffprobe 流索引（绝对索引）
 * @param format      输出格式（默认 'srt'）。传 'ass' 可保留 ASS/SSA 样式
 * @param opts        headers：HTTP 请求头（src 需鉴权时传入，例如 Authorization: Basic ...）
 * @returns 字幕文本（格式由 format 决定）
 */
export function extractSubtitleTrack(
  input: string,
  streamIndex: number,
  format: SubtitleOutputFormat = 'srt',
  opts?: { headers?: string },
): Promise<string> {
  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) return Promise.reject(new Error('FFmpeg 不可用'))

  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      [
        ...(opts?.headers ? ['-headers', opts.headers] : []),
        '-i', input,
        '-map', `0:${streamIndex}`,
        '-f', format,
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('error', (err) => {
      reject(new Error(`FFmpeg 启动失败：${err.message}`))
    })

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`字幕提取失败，退出码 ${code}。${stderr.slice(-300)}`))
      }
    })
  })
}

// ============ 实时音频转码 ============

/**
 * 浏览器 <video> 元素原生支持的音频编码。
 * 不在此列表中的编码需要后端实时转码为 AAC。
 */
export const BROWSER_SUPPORTED_AUDIO_CODECS = [
  'aac', 'mp3', 'opus', 'vorbis', 'flac',
]

/**
 * 判断音频编码是否需要转码。
 * null（未知）时保守地返回 false，让浏览器尝试播放。
 */
export function needsAudioTranscode(audioCodec: string | null): boolean {
  if (!audioCodec) return false
  return !BROWSER_SUPPORTED_AUDIO_CODECS.includes(audioCodec.toLowerCase())
}

/** FFmpeg 转码能力缓存（null = 未检测, boolean = 检测结果） */
let transcodeCapableCache: boolean | null = null

/**
 * 重置 FFmpeg 相关缓存。
 *
 * 在安装新 FFmpeg 后调用，确保下次检测重新执行。
 */
export function resetFfmpegCache(): void {
  transcodeCapableCache = null
  probeCache.clear()
}

/**
 * 检测 FFmpeg 是否具备音频转码能力（AAC 编码器 + pipe 输出）。
 *
 * 某些精简版 FFmpeg（如 TRAE 自带版本）禁用了大部分编码器和解码器，
 * 无法进行音频转码。此函数通过检查 `ffmpeg -encoders` 输出中是否包含
 * AAC 编码器来判断。
 *
 * 结果缓存在模块级变量中，仅检测一次。
 */
export async function isFfmpegTranscodeCapable(): Promise<boolean> {
  if (transcodeCapableCache !== null) return transcodeCapableCache

  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) {
    transcodeCapableCache = false
    return false
  }

  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-encoders'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          transcodeCapableCache = false
          resolve(false)
          return
        }
        // 检查是否有 AAC 编码器（原生或 libfdk_aac）
        const hasAac = /aac|libfdk_aac/i.test(stdout)
        transcodeCapableCache = hasAac
        if (!hasAac) {
          console.warn('[ffmpeg] 当前 FFmpeg 不支持 AAC 编码，音频转码不可用')
        }
        resolve(hasAac)
      }
    )
  })
}

export interface TranscodeStreamResult {
  /** FFmpeg stdout 可读流，可直接 pipe 到 HTTP 响应 */
  stream: import('node:stream').Readable
  /** FFmpeg 子进程引用，用于客户端断连时 kill */
  process: import('node:child_process').ChildProcess
}

/**
 * 创建实时音频转码流。
 *
 * 使用 FFmpeg 将音频转码为 AAC（192kbps 立体声），视频流直接复制，
 * 输出为 fragmented MP4 以支持流式传输。
 *
 * @param inputPath  源文件绝对路径，或 http(s)/ftp URL（服务器中转的远程源）
 * @param seekTime   起始时间（秒），用于 seek 支持
 * @param opts       headers：远程源需要的 HTTP 请求头（如 Authorization）
 * @returns 转码流与进程引用
 */
export function createAudioTranscodeStream(
  inputPath: string,
  seekTime: number = 0,
  opts?: { headers?: string },
): TranscodeStreamResult {
  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) throw new Error('FFmpeg 不可用')

  const args: string[] = []

  // seek 到指定时间（放在 -i 之前为快速 seek，精度略低但速度快）
  if (seekTime > 0) {
    args.push('-ss', seekTime.toFixed(3))
  }

  if (opts?.headers) {
    args.push('-headers', opts.headers)
  }

  args.push(
    '-i', inputPath,
    '-c:v', 'copy',          // 视频流直接复制，不重新编码
    '-c:a', 'aac',           // 音频转码为 AAC
    '-b:a', '192k',          // 音频比特率
    '-ac', '2',              // 立体声
    '-f', 'mp4',             // 输出 MP4 容器
    '-movflags', 'frag_keyframe+empty_moov',  // fragmented MP4，支持流式传输
    'pipe:1',
  )

  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return {
    stream: proc.stdout,
    process: proc,
  }
}
