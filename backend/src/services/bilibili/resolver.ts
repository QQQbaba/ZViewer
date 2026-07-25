/**
 * B站 视频解析独立编排模块。
 *
 * 分离架构核心：
 * - 路由层（stream.ts）只负责 HTTP 参数解析与 NDJSON 输出，不感知解析细节。
 * - 本模块对外暴露 resolveBilibiliVideo，封装完整解析流程：VIP 校验、视频信息、播放地址、清晰度匹配、CDN 选择、MP4 降级。
 * - 信号源层（video/playurl/vip）保持单一职责；本模块负责编排与错误归一。
 *
 * 效率优化：
 * - VIP 校验与视频信息获取并行（无依赖），节省 1 个 RTT。
 * - 视频信息短期缓存，重复解析同一 BV 号时跳过 nav/view 调用。
 * - CDN 健康检查使用 race 模式，先返回的可达 URL 立即采用。
 */

import { getVideoInfo } from './video';
import {
  getPlayUrl,
  NoPermissionError,
  type BilibiliPlayUrlResult,
} from './playurl';
import {
  getVipStatus,
  filterQualitiesByVip,
  computeFnval,
  getDefaultQn,
  VIP_ONLY_QNS,
} from './permission';
import { findReachableMediaUrl } from './cdn';
import {
  getCachedVideoInfo,
  setCachedVideoInfo,
} from './cache';

export interface ResolveProgress {
  status: 'parsing' | 'done' | 'error';
  step?: string;
  message?: string;
}

export interface ResolveOptions {
  /** 原始输入：BV 号 / av 号 / 完整 URL。 */
  url: string;
  /** 当前用户 ID，用于读取 B站 Cookie。 */
  userId?: string;
  /** B站 Cookie（由上层从 credential 取出后传入，避免本模块直接访问 DB）。 */
  cookie?: string;
  /** 指定清晰度 qn。 */
  qn?: number;
  /** 编码偏好：auto / avc / hevc / av1。 */
  codec?: string;
  /** 解析进度回调，用于 NDJSON 流式输出。 */
  onProgress?: (msg: ResolveProgress) => void;
}

export interface ResolveResult {
  title: string;
  duration: number;
  cid: number;
  videoUrl: string;
  audioUrl?: string;
  videoCodec?: string;
  audioCodec?: string;
  format: 'dash' | 'mp4';
  loggedIn: boolean;
  vipStatus: number;
  currentQn?: number;
  acceptQuality?: { id: number; label: string; resolution?: string }[];
}

export class ResolveError extends Error {
  code: string;
  constructor(message: string, code: string = 'RESOLVE_FAILED') {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
  }
}

/** 从任意输入提取 BV 号或 av 号。 */
export function extractBvid(input: string): string | null {
  const bvMatch = input.match(/BV[0-9A-Za-z]{10}/);
  if (bvMatch) return bvMatch[0];
  const avMatch = input.match(/av(\d+)/i);
  if (avMatch) return avMatch[1];
  return null;
}

async function fetchVideoInfo(bvid: string, cookie?: string) {
  const cached = getCachedVideoInfo(bvid);
  if (cached) {
    console.log('[bilibili-resolver] video info served from cache:', bvid);
    return cached;
  }
  let info: import('./video').BilibiliVideoInfo | null = null;
  try {
    info = await getVideoInfo(bvid, cookie);
  } catch (err) {
    // 将 B站 API 业务错误转换为对用户更友好的 ResolveError
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('[-404]')) {
      throw new ResolveError(
        `视频不存在或已被删除（${bvid}），请检查 BV 号是否正确`,
        'VIDEO_NOT_FOUND',
      );
    }
    if (msg.includes('[-101]')) {
      throw new ResolveError(
        'B站账号未登录或登录已过期，请重新扫码登录',
        'NOT_LOGGED_IN',
      );
    }
    if (msg.includes('[-403]') || msg.includes('[-514]')) {
      throw new ResolveError(
        '无权限访问该视频，可能为会员专享或地区限制',
        'NO_PERMISSION',
      );
    }
    // 其他未知错误保留原始消息
    throw new ResolveError(
      `获取视频信息失败: ${msg}`,
      'INFO_FAILED',
    );
  }
  if (!info) {
    throw new ResolveError('获取视频信息失败', 'INFO_FAILED');
  }
  setCachedVideoInfo(bvid, info);
  return info;
}

/**
 * 在 DASH 所有 CDN 均不可达时降级为 MP4 直链。
 */
async function fallbackToMp4(
  bvid: string,
  cid: number,
  cookie: string | undefined,
  qn: number | undefined,
  isVip: boolean,
): Promise<{ videoUrl: string } | null> {
  const mp4PlayUrl = await getPlayUrl(bvid, cid, cookie, {
    qn,
    fnval: 1,
    isVip,
  });
  if (mp4PlayUrl?.format === 'mp4' && mp4PlayUrl.durl?.[0]?.url) {
    const mp4Url = await findReachableMediaUrl({
      baseUrl: mp4PlayUrl.durl[0].url,
    });
    if (mp4Url) return { videoUrl: mp4Url };
  }
  return null;
}

/**
 * 编排完整解析流程。失败时抛出 ResolveError，调用方负责捕获并转成 NDJSON 错误消息。
 */
export async function resolveBilibiliVideo(
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const { url, cookie, qn, codec, onProgress } = opts;

  const bvid = extractBvid(url);
  if (!bvid) {
    throw new ResolveError('无法解析 B站 BV 号', 'INVALID_INPUT');
  }

  const emit = (step: string, message: string) => {
    onProgress?.({ status: 'parsing', step, message });
  };

  // 并行：VIP 校验（从缓存或 nav 接口）与视频信息获取（view 接口）
  emit('vip', '正在检查大会员状态...');
  const [isVip, info] = await Promise.all([
    getVipStatus(cookie),
    (async () => {
      emit('info', '正在解析视频信息...');
      return fetchVideoInfo(bvid, cookie);
    })(),
  ]);

  // 根据会员状态和登录态确定默认清晰度
  // 未登录 B站 时默认 480P（B站对未登录用户限制为 480P 及以下）
  const hasCookie = !!cookie;
  const defaultQn = getDefaultQn(isVip, hasCookie);
  const requestedQn = qn ?? defaultQn;

  // 播放地址
  emit('playurl', '正在获取播放地址...');
  let playUrl: BilibiliPlayUrlResult | null;
  try {
    playUrl = await getPlayUrl(
      info.bvid,
      info.cid,
      cookie,
      { qn: requestedQn, codec, isVip },
    );
  } catch (err) {
    // 权限错误：逐级降级重试
    // 未登录时请求 480P 仍可能失败（部分视频限制），降级到 360P
    // 已登录非会员请求 1080P 失败时，降级到 480P
    // 已登录会员请求 4K 失败时，降级到 1080P
    if (err instanceof NoPermissionError) {
      const fallbackQn = requestedQn > 32 ? 32 : 16;
      if (fallbackQn !== requestedQn) {
        emit('playurl', `当前清晰度无权限，降级到 ${fallbackQn === 32 ? '480P' : '360P'}...`);
        playUrl = await getPlayUrl(
          info.bvid,
          info.cid,
          cookie,
          { qn: fallbackQn, codec, isVip },
        );
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
  if (!playUrl) {
    throw new ResolveError('无法获取播放地址，可能需要登录或大会员', 'NO_PERMISSION');
  }

  // 清晰度匹配：若请求的 qn 不在 acceptQuality 中，回退到首个可用清晰度
  let acceptQuality = filterQualitiesByVip(playUrl.acceptQuality, isVip, hasCookie);
  let effectiveQn = playUrl.currentQn;
  if (effectiveQn && !acceptQuality.some((q) => q.id === effectiveQn)) {
    effectiveQn = acceptQuality[0]?.id ?? playUrl.currentQn;
  }

  if (effectiveQn && effectiveQn !== playUrl.currentQn) {
    emit('quality', '正在匹配可用清晰度...');
    try {
      const refetched = await getPlayUrl(info.bvid, info.cid, cookie, {
        qn: effectiveQn,
        codec,
        isVip,
      });
      if (refetched) {
        playUrl = refetched;
        acceptQuality = filterQualitiesByVip(playUrl.acceptQuality, isVip, hasCookie);
      }
    } catch (err) {
      // 权限错误时保持当前清晰度
      if (err instanceof NoPermissionError) {
        console.warn('[bilibili-resolver] 清晰度匹配权限错误，保持当前清晰度:', effectiveQn);
      } else {
        throw err;
      }
    }
  }

  emit('finish', '解析完成，正在加载播放器...');

  // DASH 路径：选择可达视频/音频 URL
  if (playUrl.format === 'dash' && playUrl.bestVideo) {
    emit('cdn', '正在选择可用 CDN...');

    const [videoUrl, audioUrl] = await Promise.all([
      findReachableMediaUrl({
        baseUrl: playUrl.bestVideo.baseUrl,
        backupUrl: playUrl.bestVideo.backupUrl,
      }),
      playUrl.bestAudio
        ? findReachableMediaUrl({
            baseUrl: playUrl.bestAudio.baseUrl,
            backupUrl: playUrl.bestAudio.backupUrl,
          })
        : Promise.resolve(null),
    ]);

    if (!videoUrl) {
      emit('fallback', 'DASH 地址不可用，尝试 MP4 直链...');
      const mp4 = await fallbackToMp4(info.bvid, info.cid, cookie, effectiveQn, isVip);
      if (mp4) {
        return {
          title: info.title,
          duration: info.duration,
          cid: info.cid,
          videoUrl: mp4.videoUrl,
          format: 'mp4',
          loggedIn: !!cookie,
          vipStatus: isVip ? 1 : 0,
          currentQn: playUrl.currentQn,
          acceptQuality,
        };
      }
      throw new ResolveError(
        '当前网络无法访问 B站 媒体服务器，请稍后重试',
        'CDN_UNREACHABLE',
      );
    }

    return {
      title: info.title,
      duration: info.duration,
      cid: info.cid,
      videoUrl,
      audioUrl: audioUrl ?? undefined,
      videoCodec: playUrl.bestVideo.codecs,
      audioCodec: playUrl.bestAudio?.codecs,
      format: 'dash',
      loggedIn: !!cookie,
      vipStatus: isVip ? 1 : 0,
      currentQn: playUrl.currentQn,
      acceptQuality,
    };
  }

  // MP4 直链路径
  if (playUrl.format === 'mp4' && playUrl.durl?.length) {
    emit('cdn', '正在选择可用 CDN...');
    const mp4Url = await findReachableMediaUrl({
      baseUrl: playUrl.durl[0].url,
    });
    if (!mp4Url) {
      throw new ResolveError(
        '当前网络无法访问 B站 媒体服务器，请稍后重试',
        'CDN_UNREACHABLE',
      );
    }
    return {
      title: info.title,
      duration: info.duration,
      cid: info.cid,
      videoUrl: mp4Url,
      format: 'mp4',
      loggedIn: !!cookie,
      vipStatus: isVip ? 1 : 0,
      currentQn: playUrl.currentQn,
      acceptQuality,
    };
  }

  throw new ResolveError('未找到可用播放地址', 'NO_PLAYURL');
}

/**
 * 将底层异常归一化为 ResolveError，便于上层统一处理。
 */
export function normalizeResolveError(err: unknown): ResolveError {
  if (err instanceof ResolveError) return err;
  if (err instanceof NoPermissionError) {
    return new ResolveError(err.message, 'NO_PERMISSION');
  }
  const message = err instanceof Error ? err.message : '解析失败';
  return new ResolveError(message, 'RESOLVE_FAILED');
}
