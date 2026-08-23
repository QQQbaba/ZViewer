/**
 * 远程源的 FFmpeg 音频转码响应 helper。
 *
 * 供 WebDAV / OpenList / FTP 等中转端点使用：当片源音轨编码浏览器不支持
 * （DTS/AC3/EAC3/TrueHD 等）时，用 FFmpeg 实时转码为 AAC（fMP4）并接管响应；
 * 无需转码或转码不可用时返回 false，由调用方回退到原有直推逻辑。
 *
 * 探测结果按输入 URL 缓存（5 分钟 TTL）：ffprobe 读取远程头部有秒级开销，
 * 播放期间的 seek/重连请求不应重复探测。
 */
import type { Response } from 'express';
import {
  probeMediaInfo,
  needsAudioTranscode,
  isFfmpegTranscodeCapable,
  createAudioTranscodeStream,
} from '../ffmpeg';
import { getSystemSettings } from '../system-settings';

const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
const probeCache = new Map<
  string,
  { needed: boolean; audioCodec: string | null; duration: number | null; expireAt: number }
>();

export interface AudioTranscodeRespondOptions {
  /** 源地址：本地路径或 http(s)/ftp URL（FFmpeg 可直接读取） */
  input: string;
  /** 容器/文件名（用于判定是否值得探测，如 mkv/avi/wmv/ts） */
  fileName: string;
  /** 影片时长（秒），用于 X-Content-Duration 与 seek 位置换算；未知传 null */
  duration: number | null;
  /** HTTP Range 头（用于估算转码起始时间）与总大小 */
  rangeHeader?: string | undefined;
  totalSize?: number | null;
  /** FFmpeg 需要的 HTTP 请求头（远程源鉴权场景） */
  ffmpegHeaders?: string | undefined;
  logTag: string;
}

/** 值得探测音轨的容器类型（mp4/webm 等浏览器原生容器无需检测） */
const TRANSCODE_CHECK_EXTS = /\.(mkv|avi|wmv|ts|flv)$/i;

/**
 * 检测音频是否需要转码；需要且可行时用 FFmpeg 转码流接管响应。
 *
 * @returns true=已接管响应（转码流已 pipe）；false=不需要转码或转码失败，
 *          调用方应继续执行原有的直推逻辑。
 */
export async function respondWithAudioTranscode(
  res: Response,
  opts: AudioTranscodeRespondOptions,
): Promise<boolean> {
  // 仅对可能含不兼容音轨的容器做探测
  if (!TRANSCODE_CHECK_EXTS.test(opts.fileName)) return false;

  // 音频转码总开关（管理后台基础设置）：关闭时一律直推，不探测
  const { audioTranscodeEnabled } = await getSystemSettings();
  if (!audioTranscodeEnabled) return false;

  // 探测结果缓存
  const cached = probeCache.get(opts.input);
  let decision = cached && cached.expireAt > Date.now() ? cached : undefined;
  if (!decision) {
    let needed = false;
    let audioCodec: string | null = null;
    let duration: number | null = null;
    try {
      const probe = await probeMediaInfo(opts.input);
      audioCodec = probe.audioCodec;
      duration = probe.duration;
      if (needsAudioTranscode(audioCodec)) {
        // 精简版 FFmpeg 可能不支持 AAC 编码，需二次确认
        needed = await isFfmpegTranscodeCapable();
      }
    } catch {
      // 探测失败（远程不可达等）：保守回退直推
    }
    decision = { needed, audioCodec, duration, expireAt: Date.now() + PROBE_CACHE_TTL_MS };
    probeCache.set(opts.input, decision);
  }
  if (!decision.needed) return false;

  // seek 起始估算：Range 字节位置 / 总大小 × 时长
  let seekTime = 0;
  if (opts.rangeHeader && opts.totalSize && opts.totalSize > 0) {
    const match = /^bytes=(\d+)-/.exec(opts.rangeHeader.trim());
    if (match) {
      const startByte = parseInt(match[1], 10);
      if (opts.duration && opts.duration > 0) {
        seekTime = (startByte / opts.totalSize) * opts.duration;
      }
    }
  }

  console.log(
    `[${opts.logTag}] 音轨编码 ${decision.audioCodec ?? 'unknown'} 不受浏览器支持，启用 FFmpeg 实时转码为 AAC`
  );

  let transcodeResult;
  try {
    transcodeResult = createAudioTranscodeStream(
      opts.input,
      seekTime,
      opts.ffmpegHeaders ? { headers: opts.ffmpegHeaders } : undefined,
    );
  } catch (err) {
    console.warn(`[${opts.logTag}] FFmpeg 转码不可用，回退直接传输:`, err);
    return false;
  }

  const { stream, process: ffmpegProc } = transcodeResult;

  // 等待 FFmpeg 产出第一块数据（5s 超时视为启动失败）
  const firstChunk = await new Promise<Buffer | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 5000);
    stream.once('data', (chunk: Buffer) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(chunk);
      }
    });
    ffmpegProc.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
      if (code !== 0 && code !== null) {
        console.error(`[${opts.logTag}] FFmpeg 启动失败，退出码 ${code}`);
      }
    });
    ffmpegProc.once('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });

  if (!firstChunk) {
    console.warn(`[${opts.logTag}] FFmpeg 转码未产生数据，回退直接传输`);
    try {
      ffmpegProc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    return false;
  }

  // 转码响应已接管：fMP4 流式输出
  res.setHeader('Content-Type', 'video/mp4');
  if (decision.duration && decision.duration > 0) {
    res.setHeader('X-Content-Duration', decision.duration.toFixed(3));
  }
  res.status(200);

  res.on('close', () => {
    if (!res.writableFinished) {
      try {
        ffmpegProc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  });

  let stderrBuffer = '';
  ffmpegProc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(-2048);
  });
  ffmpegProc.on('error', (err) => {
    console.error(`[${opts.logTag}] FFmpeg 进程错误:`, err);
    if (!res.writableFinished) res.destroy();
  });
  ffmpegProc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(
        `[${opts.logTag}] FFmpeg 退出码 ${code}: ${stderrBuffer.slice(-500)}`
      );
      if (!res.writableFinished) res.destroy();
    }
  });

  res.write(firstChunk);
  stream.pipe(res);
  return true;
}
