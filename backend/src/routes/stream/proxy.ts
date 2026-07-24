/**
 * 媒体代理路由。
 *
 *   imageProxyRouter：GET /proxy-image  B站 图片代理（免认证，须在 authenticateToken 之前挂载）
 *   默认导出：        GET /proxy        B站 CDN 媒体代理（需登录态）
 *
 * 两个端点均基于统一 proxyHttpUpstream 实现，仅声明上游请求头与 CORS 策略差异。
 */

import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { proxyHttpUpstream } from '../../services/proxy';

const BILIBILI_REFERER = 'https://www.bilibili.com';

const allowedImageDomains = [
  'bilibili.com',
  'hdslb.com',
  'bilivideo.com',
  'biliimg.com',
];

function readUrlParam(req: Request, res: Response): string | null {
  const url = req.query.url;
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少 url 参数' });
    return null;
  }
  return url.trim();
}

// 公共图片代理：B站 CDN 图片需要 referer，且 img 标签无法携带认证头，
// 因此提供免认证的 B站 图片代理，仅允许 bilibili 域名的图片地址。
export const imageProxyRouter = Router().get(
  '/proxy-image',
  async (req: Request, res: Response) => {
    const trimmedUrl = readUrlParam(req, res);
    if (!trimmedUrl) return;

    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      res.status(400).json({ success: false, message: '非法的 URL' });
      return;
    }

    const isAllowed = allowedImageDomains.some(
      (domain) =>
        parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
    );
    if (!isAllowed) {
      res.status(403).json({ success: false, message: '仅允许 B站 域名图片' });
      return;
    }

    await proxyHttpUpstream(req, res, {
      url: trimmedUrl,
      headers: { referer: BILIBILI_REFERER },
      // img 标签不携带凭证，CORS 交由全局中间件反射 Origin
      cors: 'global',
      defaultContentType: 'image/jpeg',
      cacheControl: 'public, max-age=3600',
      logTag: 'stream',
      errorMessage: '代理图片失败',
    });
  },
);

// 媒体代理：绕过浏览器对 B站 CDN 的 Referer/UA 限制。
// 前端 fetch 携带凭证（credentials: 'include'），CORS 必须由全局中间件
// 反射 Origin + credentials，不能手动设置 ACAO:*（否则浏览器拒绝响应）。
const router = Router().get(
  '/proxy',
  async (req: AuthenticatedRequest, res: Response) => {
    const trimmedUrl = readUrlParam(req, res);
    if (!trimmedUrl) return;

    await proxyHttpUpstream(req, res, {
      url: trimmedUrl,
      headers: { referer: BILIBILI_REFERER, origin: BILIBILI_REFERER },
      cors: 'global',
      defaultContentType: 'video/mp4',
      logTag: 'stream',
      errorMessage: '代理媒体失败',
    });
  },
);

export default router;
