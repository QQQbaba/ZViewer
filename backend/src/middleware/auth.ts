import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

import type { UserRole } from '../entities/User';

export interface JwtPayload {
  userId: number;
  role: UserRole;
  username?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

const JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production';
const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-production';
const JWT_ACCESS_EXPIRES_IN: jwt.SignOptions['expiresIn'] =
  (process.env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '1h';
const JWT_REFRESH_EXPIRES_IN: jwt.SignOptions['expiresIn'] =
  (process.env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '30d';

/** access_token cookie 有效期（毫秒）。比 JWT 短 5 秒避免边界过期。 */
const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 1000; // 1 小时
/** refresh_token cookie 有效期（毫秒）。 */
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 天

const IS_PROD = process.env.NODE_ENV === 'production';

export function generateTokens(userId: number, role: UserRole, username?: string) {
  const payload: JwtPayload = { userId, role, username };
  const accessToken = jwt.sign(payload, JWT_ACCESS_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRES_IN,
  });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
  });
  return { accessToken, refreshToken };
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_ACCESS_SECRET) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_REFRESH_SECRET) as JwtPayload;
}

/**
 * 判断当前请求是否为 HTTPS（含反向代理终止 TLS 的场景）。
 * 用于动态决定 cookie 的 secure 属性：
 * - HTTPS 请求 → secure: true（浏览器才允许设置 Secure cookie）
 * - HTTP 请求 → secure: false（否则浏览器会直接丢弃 Secure cookie，导致登录态丢失）
 *
 * 依赖 app.set('trust proxy', true) 才能正确读取 X-Forwarded-Proto 头。
 */
function isRequestSecure(req: Request): boolean {
  // req.secure 在直连场景下反映真实 TLS；反向代理后需信任 X-Forwarded-Proto
  if (req.secure) return true;
  const xfp = req.headers['x-forwarded-proto'];
  if (typeof xfp === 'string' && xfp.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }
  return false;
}

/** 将 access_token / refresh_token 写入 httpOnly cookie。 */
export function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
): void {
  const secure = isRequestSecure(req);
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    path: '/',
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: REFRESH_COOKIE_MAX_AGE,
    path: '/',
  });
}

/** 仅更新 access_token cookie（refresh 不轮换）。 */
export function setAccessTokenCookie(
  req: Request,
  res: Response,
  accessToken: string,
): void {
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: isRequestSecure(req),
    sameSite: 'lax',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    path: '/',
  });
}

/** 清除 auth cookie（登出）。 */
export function clearAuthCookies(res: Response): void {
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/' });
}

/** 从 cookie 或 Authorization Header 读取 access token。 */
export function extractAccessToken(req: Request): string | undefined {
  // 优先从 cookie 读取（前端 fetch credentials: 'include' 自动携带）
  const cookieToken = req.cookies?.access_token;
  if (typeof cookieToken === 'string' && cookieToken) return cookieToken;
  // 兼容旧 Authorization: Bearer <token> 头
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.split(' ')[1];
  if (headerToken) return headerToken;
  return undefined;
}

export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const token = extractAccessToken(req);

  if (!token) {
    res.status(401).json({ success: false, message: '未提供认证令牌' });
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch (err) {
    res.status(403).json({ success: false, message: '认证令牌无效或已过期' });
  }
}

/** 仅允许 root 超级管理员访问的路由中间件。 */
export function requireRoot(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  if (req.user?.role !== 'root') {
    res.status(403).json({ success: false, message: '无权限：仅超级管理员可操作' });
    return;
  }
  next();
}
