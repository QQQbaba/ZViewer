/**
 * 影片音轨编码探测（入库期补齐）。
 *
 * 音频转码已迁移至浏览器端（ffmpeg.wasm）：前端需要预先知道影片的音轨
 * 编码（如 DTS/AC3）才能决定是否启用浏览器内转码。本模块在影片创建或
 * 更新后异步用 ffprobe 探测 MKV 容器的 audioCodec 并持久化到
 * Movie.audioCodec，每个影片仅探测一次（已有值时跳过）。
 *
 * 探测为 fire-and-forget：失败静默忽略（audioCodec 保持 null，前端
 * 按未知编码回退直推，行为与旧版一致）。probeMediaInfo 自带 10s 超时
 * 与结果缓存。
 */
import fs from 'node:fs';
import { AppDataSource } from '../data-source';
import { Movie } from '../entities/Movie';
import { UserMount } from '../entities/UserMount';
import { probeMediaInfo } from './ffmpeg';
import { buildWebDAVDirectUrl } from './webdav';
import { normalizeOpenListServerUrl } from './openlist-errors';
import { detectMediaFormat } from './mediaFormat';
import { loadRootRegistry, resolveSafePath } from './server-files/pathResolver';

/** 需要探测音轨的容器格式（第一期仅 MKV；DTS 音轨实际只出现在 MKV/TS 中） */
const PROBE_FORMATS: ReadonlySet<string> = new Set(['mkv']);

/** 探测中跳过的源类型：远端媒体库自管转码判定，B站流无静态文件可探 */
const SKIPPED_SOURCES = new Set(['emby', 'jellyfin', 'bilibili', 'anime']);

/**
 * 回退查询 UserMount 补全影片缺失的凭证
 * （与 routes/subtitles.ts 的 fillCredentialsFromMount 逻辑一致）。
 */
async function resolveCredentials(
  movie: Movie,
): Promise<{ username?: string; password?: string }> {
  if (movie.username && movie.password) {
    return { username: movie.username, password: movie.password };
  }
  const source = (movie.source || '').toLowerCase();
  if (!movie.serverUrl) return {};
  const mountType =
    source === 'openlist' ? 'openlist' : source === 'ftp' ? 'ftp' : 'webdav';
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    serverUrl: movie.serverUrl,
    type: mountType as 'webdav' | 'openlist' | 'ftp',
  });
  return {
    username: movie.username || mount?.username || undefined,
    password: movie.password || mount?.password || undefined,
  };
}

/**
 * 计算本次探测的输入（本地绝对路径或 FFmpeg 可读取的 URL）。
 * 返回 null 表示该影片无需/无法探测。
 */
async function resolveProbeInput(movie: Movie): Promise<string | null> {
  const source = (movie.source || '').toLowerCase();
  if (SKIPPED_SOURCES.has(source)) return null;

  // 格式判定：优先显式 format 字段，旧数据从 path/url 扩展名推断
  const fmt = movie.format || detectMediaFormat(movie.path || movie.url);
  if (!fmt || !PROBE_FORMATS.has(fmt)) return null;

  if (source === 'server-files') {
    if (!movie.path) return null;
    try {
      const roots = await loadRootRegistry();
      const { abs } = resolveSafePath(movie.path, roots);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return null;
      return abs;
    } catch {
      return null;
    }
  }

  if (source === 'webdav') {
    if (!movie.serverUrl || !movie.path) return null;
    const creds = await resolveCredentials(movie);
    return buildWebDAVDirectUrl(movie.serverUrl, movie.path, creds.username, creds.password);
  }

  if (source === 'openlist') {
    if (!movie.serverUrl || !movie.path) return null;
    const creds = await resolveCredentials(movie);
    // OpenList 兼容 WebDAV 协议（自动补 http:// 前缀与 /dav 路径）
    return buildWebDAVDirectUrl(
      normalizeOpenListServerUrl(movie.serverUrl),
      movie.path,
      creds.username,
      creds.password,
    );
  }

  if (source === 'ftp') {
    if (!movie.serverUrl || !movie.path) return null;
    const creds = await resolveCredentials(movie);
    try {
      const hostWithPort = movie.serverUrl.replace(/^ftp:\/\//i, '');
      const auth =
        creds.username || creds.password
          ? `${encodeURIComponent(creds.username ?? '')}:${encodeURIComponent(creds.password ?? '')}@`
          : '';
      const filePath = movie.path.startsWith('/') ? movie.path : `/${movie.path}`;
      return `ftp://${auth}${hostWithPort}${filePath}`;
    } catch {
      return null;
    }
  }

  // 直链模式或其他未标记源：URL 本身是真实可访问地址时直接探测
  if (/^https?:\/\//i.test(movie.url)) return movie.url;

  return null;
}

/** 对单个影片执行探测并持久化结果（audioCodec / 缺失的 duration） */
async function runProbe(movieId: number): Promise<void> {
  const repo = AppDataSource.getRepository(Movie);
  const movie = await repo.findOneBy({ id: movieId });
  if (!movie) return;
  if (movie.audioCodec) return; // 已有值，跳过

  const input = await resolveProbeInput(movie);
  if (!input) return;

  const probe = await probeMediaInfo(input);
  if (!probe.audioCodec) return;

  const update: Partial<Movie> = { audioCodec: probe.audioCodec };
  // duration 缺失时顺带补齐（wasm 引擎的时长回退依赖它）
  if (!movie.duration && probe.duration && probe.duration > 0) {
    update.duration = Math.round(probe.duration);
  }
  await repo.update({ id: movieId }, update);
  console.log(
    `[movie-audio-probe] 影片 ${movieId} 音轨编码: ${probe.audioCodec} (${input.slice(0, 80)})`
  );
}

/**
 * 异步调度音轨探测（fire-and-forget，不阻塞创建/更新响应）。
 * 探测延迟完成后再拉一次影片列表也不会有问题——前端下次进入房间即拿到 audioCodec。
 */
export function scheduleAudioCodecProbe(movieId: number): void {
  void runProbe(movieId).catch((err) => {
    console.warn(`[movie-audio-probe] 影片 ${movieId} 探测失败:`,
      err instanceof Error ? err.message : err);
  });
}
