/**
 * B站 视频解析与弹幕路由（需登录态，由父路由统一 authenticateToken）。
 *
 *   GET /resolve-bilibili   解析 B站 视频播放地址（NDJSON 流式返回进度）
 *   GET /bilibili/danmaku   获取 B站 弹幕
 *
 * v2 重构：NDJSON 流式响应的头部设置 / 写入 / flush 收敛为 NdjsonWriter，
 * 路由本体只保留参数校验与业务流程。
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { getVideoInfo } from '../../services/bilibili/video';
import { getDanmaku } from '../../services/bilibili/danmaku';
import {
  resolveBilibiliVideo,
  extractBvid,
  normalizeResolveError,
  type ResolveProgress,
} from '../../services/bilibili/resolver';
import { getUserCookie } from './helpers';

const router = Router();

interface ResolveProgressMessage {
  success?: boolean;
  status: 'parsing' | 'done' | 'error';
  step?: string;
  message?: string;
  code?: string;
  title?: string;
  duration?: number;
  cid?: number;
  videoUrl?: string;
  audioUrl?: string;
  videoCodec?: string;
  audioCodec?: string;
  format?: 'dash' | 'mp4';
  loggedIn?: boolean;
  vipStatus?: number;
  currentQn?: number;
  acceptQuality?: { id: number; label: string; resolution?: string }[];
}

/**
 * NDJSON 流式响应写入器。
 *
 * - Content-Type: application/x-ndjson，逐行写入 JSON；
 * - Connection: close：避免浏览器因 keep-alive 连接被服务端提前关闭而报 abort；
 * - X-Accel-Buffering: no：禁用 nginx 缓冲，实时推送解析进度；
 * - 每次写入后尝试 flush（compression 中间件存在时生效）。
 */
class NdjsonWriter {
  constructor(private readonly res: Response) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'close');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Transfer-Encoding', 'chunked');
  }

  send(payload: ResolveProgressMessage): void {
    this.res.write(JSON.stringify(payload) + '\n');
    const flushable = this.res as unknown as { flush?: () => void };
    if (typeof flushable.flush === 'function') {
      flushable.flush();
    }
  }

  /** 发送错误消息并结束响应 */
  fail(message: string, code?: string): void {
    this.send({ success: false, status: 'error', message, code });
    this.res.end();
  }

  end(): void {
    this.res.end();
  }
}

router.get('/resolve-bilibili', async (req: AuthenticatedRequest, res) => {
  const url = req.query.url;
  const userId = req.user?.userId;
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少视频链接' });
    return;
  }

  // 提前校验 BV 号，避免进入流式响应后才返回 400
  if (!extractBvid(url)) {
    res.status(400).json({ success: false, message: '无法解析 B站 BV 号' });
    return;
  }

  const qn =
    typeof req.query.qn === 'string' && req.query.qn.trim()
      ? Number(req.query.qn.trim())
      : undefined;

  const codec =
    typeof req.query.codec === 'string' && req.query.codec.trim()
      ? req.query.codec.trim()
      : undefined;

  const writer = new NdjsonWriter(res);
  const cookie = (await getUserCookie(userId)) || undefined;
  console.log('[bilibili] resolve-bilibili, cookie present:', !!cookie);

  try {
    const result = await resolveBilibiliVideo({
      url,
      userId: userId !== undefined ? String(userId) : undefined,
      cookie,
      qn,
      codec,
      onProgress: (msg: ResolveProgress) => {
        writer.send({ status: msg.status, step: msg.step, message: msg.message });
      },
    });

    writer.send({
      success: true,
      status: 'done',
      title: result.title,
      duration: result.duration,
      cid: result.cid,
      videoUrl: result.videoUrl,
      audioUrl: result.audioUrl,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      format: result.format,
      loggedIn: result.loggedIn,
      vipStatus: result.vipStatus,
      currentQn: result.currentQn,
      acceptQuality: result.acceptQuality,
    });
    writer.end();
  } catch (err) {
    console.error('[bilibili] resolve-bilibili error:', err);
    const normalized = normalizeResolveError(err);
    writer.fail(normalized.message, normalized.code);
  }
});

router.get('/bilibili/danmaku', async (req: AuthenticatedRequest, res) => {
  const cid = req.query.cid;
  const bvidRaw = req.query.bvid;

  let effectiveCid: number | undefined;

  if (typeof cid === 'string' && cid.trim()) {
    effectiveCid = Number(cid);
  } else if (typeof bvidRaw === 'string' && bvidRaw.trim()) {
    const bvid = extractBvid(bvidRaw.trim());
    if (!bvid) {
      res.status(400).json({ success: false, message: '无法解析 BV 号' });
      return;
    }
    try {
      const info = await getVideoInfo(bvid);
      if (!info) {
        res.status(500).json({ success: false, message: '获取视频信息失败' });
        return;
      }
      effectiveCid = info.cid;
    } catch (err) {
      console.error('[bilibili] danmaku video info error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '获取 B站 视频信息失败',
      });
      return;
    }
  }

  if (!effectiveCid) {
    res.status(400).json({ success: false, message: '缺少 cid 或 bvid 参数' });
    return;
  }

  try {
    const danmaku = await getDanmaku(effectiveCid);
    res.json({ success: true, danmaku });
  } catch (err) {
    console.error('[bilibili] danmaku fetch error:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '解析 B站 弹幕失败',
    });
  }
});

export default router;
