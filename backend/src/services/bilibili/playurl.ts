import { bilibiliFetch } from './client';
import { getWbiKeys, signParams, clearWbiKeyCache } from './wbi';
import {
  computeFnval,
  QN_QUALITY_MAP,
  DEFAULT_QN,
} from './permission';

export interface DashMediaTrack {
  baseUrl: string;
  /** B站 返回的备用播放地址列表。 */
  backupUrl?: string[];
  bandwidth: number;
  codecs: string;
  id: number;
}

export interface DurlSegment {
  url: string;
  size: number;
  length: number;
}

export interface BilibiliPlayUrlResult {
  /** 返回格式：dash 或 mp4。 */
  format: 'dash' | 'mp4';
  /** DASH 视频轨道，按带宽降序排列。 */
  video?: DashMediaTrack[];
  /** DASH 音频轨道，按带宽降序排列。 */
  audio?: DashMediaTrack[];
  /** MP4 直链分片。 */
  durl?: DurlSegment[];
  /** 最佳视频轨道。 */
  bestVideo?: DashMediaTrack;
  /** 最佳音频轨道。 */
  bestAudio?: DashMediaTrack;
  /** 当前请求的清晰度。 */
  currentQn?: number;
  /** 视频可用清晰度列表。 */
  acceptQuality?: { id: number; label: string; resolution?: string }[];
}

interface RawDashMedia {
  baseUrl?: string;
  base_url?: string;
  /** B站 通常会返回备用播放地址，可能指向不同 CDN。 */
  backupUrl?: string[];
  backup_url?: string[];
  id: number;
  codecs: string;
  bandwidth: number;
}

interface RawAcceptDescription {
  qn: number;
  desc: string;
}

interface RawPlayUrlData {
  durl?: Array<{ url: string; size: number; length: number }>;
  dash?: {
    video?: RawDashMedia[];
    audio?: RawDashMedia[];
  };
  accept_quality?: number[];
  accept_description?: RawAcceptDescription[];
}

export interface GetPlayUrlOptions {
  qn?: number;
  /** 编码偏好：auto / avc / hevc / av1。 */
  codec?: string;
  /** 是否为大会员，用于动态计算 fnval。 */
  isVip?: boolean;
  /** 强制 fnval（仅 MP4 降级用 fnval=1，正常解析不传由 computeFnval 计算）。 */
  fnval?: number;
}

export class NoPermissionError extends Error {
  constructor(message = '无权限播放，可能需要登录或大会员') {
    super(message);
    this.name = 'NoPermissionError';
  }
}

const DEFAULT_FOURK = 1;

function buildQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join('&');
}

function sortByBandwidthDesc<T extends { bandwidth: number }>(tracks?: T[]): T[] {
  if (!tracks) return [];
  return [...tracks].sort((a, b) => b.bandwidth - a.bandwidth);
}

/**
 * 判断 codec 是否为 H.264 (avc)。
 */
function isAvcCodec(codecs?: string): boolean {
  return typeof codecs === 'string' && /^avc\d/i.test(codecs.trim());
}

/**
 * 判断 codec 是否为 HEVC (hvc1/hev1)。
 */
function isHevcCodec(codecs?: string): boolean {
  return typeof codecs === 'string' && /^hvc\d|^hev\d/i.test(codecs.trim());
}

/**
 * 判断 codec 是否为 AV1 (av01)。
 */
function isAv1Codec(codecs?: string): boolean {
  return typeof codecs === 'string' && /^av01/i.test(codecs.trim());
}

/**
 * 检测轨道编码类型，返回标准化名称。
 */
function detectCodec(codecs?: string): 'avc' | 'hevc' | 'av1' | 'unknown' {
  if (isAvcCodec(codecs)) return 'avc';
  if (isHevcCodec(codecs)) return 'hevc';
  if (isAv1Codec(codecs)) return 'av1';
  return 'unknown';
}

/**
 * 对 DASH 轨道按编码偏好排序：
 * - 指定 avc/hevc/av1 时优先返回匹配轨道，按带宽降序
 * - auto 时默认优先 H.264（浏览器兼容性最好），无则回退到原始排序
 * - 匹配失败时回退到全部轨道（按带宽降序）
 */
function sortDashTracks<T extends { bandwidth: number; codecs: string }>(
  tracks?: T[],
  codec?: string,
): T[] {
  const sorted = sortByBandwidthDesc(tracks);
  if (sorted.length === 0) return sorted;

  const preferred = codec && codec !== 'auto' ? codec : 'avc';
  const matched = sorted.filter((t) => detectCodec(t.codecs) === preferred);

  return matched.length > 0 ? matched : sorted;
}

/**
 * 部分网络环境无法连接 B站 mcdn P2P CDN 的 8082 端口，
 * 去掉该端口让请求走默认 443 端口，提升连通率。
 */
function rewriteMcdnPort(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('.mcdn.bilivideo.cn') && parsed.port === '8082') {
      parsed.port = '';
      return parsed.toString();
    }
  } catch {
    // 非法 URL 直接返回原值
  }
  return url;
}

function normalizeDashMedia(track: RawDashMedia): DashMediaTrack {
  const baseUrl = track.baseUrl ?? track.base_url ?? '';
  const backupUrls = track.backupUrl ?? track.backup_url;
  return {
    baseUrl: rewriteMcdnPort(baseUrl),
    backupUrl: backupUrls?.map(rewriteMcdnPort),
    bandwidth: track.bandwidth,
    codecs: track.codecs,
    id: track.id,
  };
}

function buildAcceptQuality(
  acceptQuality: number[] | undefined,
  acceptDescription: RawAcceptDescription[] | undefined,
  currentQn: number,
): { id: number; label: string; resolution?: string }[] {
  const descMap = new Map<number, string>();
  if (acceptDescription) {
    for (const d of acceptDescription) {
      descMap.set(d.qn, d.desc);
    }
  }

  const qns = acceptQuality?.length
    ? acceptQuality
    : acceptDescription?.length
      ? acceptDescription.map((d) => d.qn)
      : [currentQn];

  return qns.map((qn) => {
    const fallback = QN_QUALITY_MAP[qn];
    const label = descMap.get(qn) ?? fallback?.label ?? String(qn);
    return {
      id: qn,
      label,
      resolution: fallback?.resolution,
    };
  });
}

function normalizePlayUrlData(
  data?: RawPlayUrlData,
  currentQn?: number,
  codec?: string,
): BilibiliPlayUrlResult | null {
  if (!data) return null;

  const qn = currentQn ?? DEFAULT_QN;
  const acceptQuality = buildAcceptQuality(
    data.accept_quality,
    data.accept_description,
    qn,
  );

  if (data.dash?.video?.length) {
    // 诊断日志：记录 B站返回的每个视频轨道的 id(qn)/bandwidth/codecs，
    // 用于定位"切换清晰度后实际分辨率未变化"的问题。
    // B站 DASH 流中 dash.video[].id 即清晰度 qn（80=1080P, 32=480P, 16=360P）。
    console.log(
      '[bilibili-playurl] 请求 qn=%d, B站返回 %d 条视频轨道:',
      qn,
      data.dash.video.length,
      data.dash.video.map((t) => ({
        id: t.id,
        bandwidth: t.bandwidth,
        codecs: t.codecs,
      })),
    );

    // 关键修复：B站 API 请求特定 qn 时，dash.video 数组会返回所有可用清晰度的流，
    // 必须按请求的 qn 过滤，否则 sortDashTracks 按带宽降序后永远选最高清晰度。
    // 例如请求 qn=32(480P)，但返回包含 id=80(1080P)/64(720P)/32(480P)/16(360P)，
    // 不过滤会选到 id=80 的 1080P 流。
    const allTracks = data.dash.video.map(normalizeDashMedia);
    const matchedQnTracks = allTracks.filter((t) => t.id === qn);
    const tracksToSort =
      matchedQnTracks.length > 0 ? matchedQnTracks : allTracks;

    const video = sortDashTracks(tracksToSort, codec);
    const audio = sortByBandwidthDesc(
      data.dash.audio?.map(normalizeDashMedia),
    );
    console.log(
      '[bilibili-playurl] 选定 bestVideo: id=%d bandwidth=%d codecs=%s (期望 qn=%d, 过滤后 %d 条匹配轨道)',
      video[0]?.id,
      video[0]?.bandwidth,
      video[0]?.codecs,
      qn,
      matchedQnTracks.length,
    );
    return {
      format: 'dash',
      video,
      audio,
      bestVideo: video[0],
      bestAudio: audio[0],
      currentQn: qn,
      acceptQuality,
    };
  }

  if (data.durl?.length) {
    return {
      format: 'mp4',
      durl: data.durl.map((d) => ({
        url: d.url,
        size: d.size,
        length: d.length,
      })),
      currentQn: qn,
      acceptQuality,
    };
  }

  throw new NoPermissionError();
}

/**
 * 使用 WBI 签名调用 /x/player/wbi/playurl 获取播放地址。
 */
async function getPlayUrlWbi(
  bvid: string,
  cid: number,
  cookie?: string,
  options?: GetPlayUrlOptions,
): Promise<BilibiliPlayUrlResult | null> {
  const isVip = options?.isVip ?? false;
  const effectiveQn = options?.qn ?? DEFAULT_QN;
  const effectiveFnval = options?.fnval ?? computeFnval(isVip, effectiveQn);
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const signed = signParams(
    {
      bvid,
      cid: String(cid),
      qn: String(effectiveQn),
      fnver: '0',
      fnval: String(effectiveFnval),
      fourk: String(DEFAULT_FOURK),
    },
    imgKey,
    subKey,
  );
  const query = buildQueryString(signed);

  const res = await bilibiliFetch<RawPlayUrlData>(
    `https://api.bilibili.com/x/player/wbi/playurl?${query}`,
    { cookie },
  );

  const result = normalizePlayUrlData(res.data, effectiveQn, options?.codec);
  return result;
}

/**
 * 使用未签名接口 /x/player/playurl 作为降级方案。
 */
async function getPlayUrlLegacy(
  bvid: string,
  cid: number,
  cookie?: string,
  options?: GetPlayUrlOptions,
): Promise<BilibiliPlayUrlResult | null> {
  const isVip = options?.isVip ?? false;
  const effectiveQn = options?.qn ?? DEFAULT_QN;
  const effectiveFnval = options?.fnval ?? computeFnval(isVip, effectiveQn);
  const params = new URLSearchParams({
    bvid,
    cid: String(cid),
    qn: String(effectiveQn),
    fnver: '0',
    fnval: String(effectiveFnval),
    fourk: String(DEFAULT_FOURK),
  });

  const res = await bilibiliFetch<RawPlayUrlData>(
    `https://api.bilibili.com/x/player/playurl?${params.toString()}`,
    { cookie },
  );

  const result = normalizePlayUrlData(res.data, effectiveQn, options?.codec);
  return result;
}

function isPermissionError(err: unknown): boolean {
  if (err instanceof NoPermissionError) return true;
  const message = String(err instanceof Error ? err.message : err);
  // -101（账号未登录）不是权限错误，未登录用户可访问 480P 及以下清晰度。
  // 若把"账号未登录"误判为权限错误，会导致 getPlayUrlWbi 失败后不降级到
  // getPlayUrlLegacy（未签名接口支持匿名访问），未登录用户完全无法解析视频。
  if (message.includes('-101') || message.includes('账号未登录')) return false;
  const permissionKeywords = ['大会员', '付费', '无权限', '购买', '权限'];
  if (permissionKeywords.some((k) => message.includes(k))) return true;
  if (message.includes('-10403')) return true;
  return false;
}

/**
 * 获取 B站 视频播放地址。
 * 优先使用 WBI 签名接口，失败时自动降级到未签名接口。
 */
export async function getPlayUrl(
  bvid: string,
  cid: number,
  cookie?: string,
  options?: GetPlayUrlOptions,
): Promise<BilibiliPlayUrlResult | null> {
  try {
    return await getPlayUrlWbi(bvid, cid, cookie, options);
  } catch (err) {
    if (isPermissionError(err)) {
      throw new NoPermissionError();
    }
    console.warn('[bilibili] WBI playurl 失败，降级到未签名接口:', err);
    clearWbiKeyCache();
    try {
      return await getPlayUrlLegacy(bvid, cid, cookie, options);
    } catch (err2) {
      if (isPermissionError(err2)) {
        throw new NoPermissionError();
      }
      throw err2;
    }
  }
}
