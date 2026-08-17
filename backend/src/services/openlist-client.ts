/**
 * AList / OpenList HTTP API 客户端
 *
 * 直接对接 AList HTTP API（/api/auth/login、/api/fs/get、/api/fs/list、/api/fs/search），
 * 不依赖 WebDAV 协议。参考 synctv/vendors/alist 的实现。
 *
 * 关键设计：
 * 1. Authorization 头直接传 token（无 Bearer 前缀，AList 约定）
 * 2. 自动设置 Origin/Referer 为 AList 服务器地址（反防盗链）
 * 3. 支持明文密码（/api/auth/login）和哈希密码（/api/auth/login/hash）两种登录方式
 * 4. 哈希密码规则：SHA-256(password + "-https://github.com/alist-org/alist")
 */
import crypto from 'node:crypto';
import { OpenListError } from './openlist-errors';

/**
 * AList 哈希密码的盐值（与 AList /api/auth/login/hash 端点约定一致）。
 * 参考：synctv/server/handlers/vendors/vendorAlist/login.go
 * AList 源码中固定使用 `-https://github.com/alist-org/alist` 作为盐。
 */
const ALIST_PASSWORD_SALT = '-https://github.com/alist-org/alist';

/**
 * 将明文密码哈希为 AList /api/auth/login/hash 端点所需的格式。
 *
 * 算法：SHA-256(password + salt)，输出 64 位小写十六进制字符串。
 * 与 synctv 及 AList 自身的哈希逻辑完全一致。
 *
 * @param plainPassword 明文密码
 * @returns 64 位十六进制哈希字符串
 */
export function hashAlistPassword(plainPassword: string): string {
  return crypto
    .createHash('sha256')
    .update(plainPassword + ALIST_PASSWORD_SALT)
    .digest('hex');
}

/**
 * 判断字符串是否为 AList 哈希密码格式（64 位十六进制）。
 * 用于 detectLoginMode 启发式识别已存储的哈希密码。
 */
export function isAlistHashedPassword(value: string | undefined): boolean {
  return !!value && /^[a-f0-9]{64}$/i.test(value);
}

/** AList API 响应的通用信封结构 */
export interface AlistResp<T> {
  code: number;
  message: string;
  data: T;
}

/** 登录请求 */
export interface AlistLoginReq {
  username: string;
  password: string;
}

/** 登录响应 */
export interface AlistLoginData {
  token: string;
}

/** FsGet 请求 */
export interface AlistFsGetReq {
  path: string;
  password: string;
  page: number;
  per_page: number;
  refresh: boolean;
}

/** FsGet 响应（文件详情） */
export interface AlistFsGetData {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  created: string;
  sign: string;
  thumb: string;
  type: number;
  provider: string;
  raw_url: string;
  readme: string;
  hash_info: unknown;
  related: AlistFsRelated[];
}

export interface AlistFsRelated {
  name: string;
  size: number;
  is_dir: boolean;
  type: number;
  modified: string;
  sign: string;
  thumb: string;
}

/** FsList 请求 */
export interface AlistFsListReq {
  path: string;
  password: string;
  page: number;
  per_page: number;
  refresh: boolean;
}

/** FsList 响应项 */
export interface AlistFsListEntry {
  name: string;
  size: number;
  is_dir: boolean;
  type: number;
  modified: string;
  sign: string;
  thumb: string;
}

export interface AlistFsListData {
  content: AlistFsListEntry[];
  total: number;
  readme: string;
  provider: string;
  write: boolean;
}

/** FsSearch 请求 */
export interface AlistFsSearchReq {
  parent: string;
  keywords: string;
  password: string;
  scope: number;
  page: number;
  per_page: number;
}

export interface AlistFsSearchEntry {
  parent: string;
  name: string;
  is_dir: boolean;
  size: number;
  type: number;
}

export interface AlistFsSearchData {
  content: AlistFsSearchEntry[];
  total: number;
}

/** Me 响应（用户信息） */
export interface AlistMeData {
  id: number;
  username: string;
  permission: number;
  base_path: string;
  role: number;
  disabled: boolean;
  otp: boolean;
}

/** AList 登录方式 */
export type AlistLoginMode = 'plain' | 'hash';

/** 默认请求 UA（与 B站代理一致的桌面 Chrome UA） */
const ALIST_DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 请求超时（30s，登录类请求应在此时间内完成） */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 规范化 AList 服务器地址为 API 基地址（去掉 /dav 后缀）。
 * 调用方传入的可能是 WebDAV 端点（http://host/dav）或纯域名（http://host），
 * 这里统一去掉末尾的 /dav，得到 HTTP API 基地址。
 */
export function toApiBaseUrl(serverUrl: string): string {
  let url = serverUrl.trim();
  while (url.endsWith('/')) url = url.slice(0, -1);
  if (url.endsWith('/dav')) url = url.slice(0, -4);
  return url;
}

/**
 * 发起 AList HTTP API 请求。
 *
 * @param baseUrl    AList API 基地址（不含 /api 前缀，如 http://host）
 * @param method     HTTP 方法（POST/GET）
 * @param apiPath    API 路径（如 /api/fs/get）
 * @param body       请求体（POST 时传入，GET 传 undefined）
 * @param token      登录 token（可选，匿名访问时为空）
 * @param password   目录密码（可选，部分加密目录需要）
 */
async function alistRequest<T>(
  baseUrl: string,
  method: 'GET' | 'POST',
  apiPath: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const url = `${baseUrl}${apiPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'User-Agent': ALIST_DEFAULT_UA,
      // 设置 Origin/Referer 为 AList 服务器地址，反防盗链
      Origin: baseUrl,
      Referer: baseUrl + '/',
      Accept: 'application/json',
    };
    if (token) headers.Authorization = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      // 网络层/HTTP 层错误（非 AList 业务码）
      const code = res.status === 401 ? 'AUTH_FAILED' : res.status === 404 ? 'NOT_FOUND' : 'UNREACHABLE';
      throw new OpenListError(`AList HTTP ${res.status}`, code);
    }

    const data = (await res.json()) as AlistResp<T>;
    if (data.code !== 200) {
      // AList 业务码错误
      const code =
        data.code === 401 || data.code === 403
          ? 'AUTH_FAILED'
          : data.code === 500
            ? 'NOT_FOUND'
            : 'UNREACHABLE';
      // 在错误消息前添加来源标识，帮助用户区分是 AList 服务器返回的错误还是 ZViewer 自身的问题
      // AList 内部存储驱动（如 139Cloud、阿里云盘等）配置问题时会返回 Go 风格的错误
      const rawMessage = data.message || `AList code=${data.code}`;
      throw new OpenListError(`[AList 服务器] ${rawMessage}`, code);
    }

    return data.data;
  } catch (err) {
    if (err instanceof OpenListError) throw err;
    // AbortError（超时）
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OpenListError('AList 请求超时', 'TIMEOUT');
    }
    // 网络错误（DNS 解析失败、连接拒绝等）
    throw new OpenListError(
      `AList 网络错误: ${err instanceof Error ? err.message : String(err)}`,
      'UNREACHABLE',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 登录 AList 获取 token。
 *
 * @param baseUrl   AList API 基地址
 * @param username  用户名
 * @param password  密码（根据 mode 传入明文或哈希值）
 * @param mode      登录方式：plain=明文（/api/auth/login），hash=哈希（/api/auth/login/hash）
 * @returns token 字符串
 */
export async function alistLogin(
  baseUrl: string,
  username: string,
  password: string,
  mode: AlistLoginMode = 'plain',
): Promise<string> {
  const apiPath = mode === 'hash' ? '/api/auth/login/hash' : '/api/auth/login';
  const data = await alistRequest<AlistLoginData>(
    baseUrl,
    'POST',
    apiPath,
    { username, password } satisfies AlistLoginReq,
  );
  if (!data?.token) {
    throw new OpenListError('AList 未返回 token', 'AUTH_FAILED');
  }
  return data.token;
}

/**
 * 匿名访问场景下验证 AList 服务器可用性。
 * 无用户名时不调用 login，直接尝试 /api/me 验证服务在线。
 */
export async function alistPing(baseUrl: string): Promise<void> {
  // AList 匿名访问时无需 token，调用 /api/me 会返回 401 但 HTTP 200，
  // 说明服务器在线。这里调用 /api/fs/list 列出根目录验证匿名访问权限。
  try {
    await alistRequest<AlistFsListData>(
      baseUrl,
      'POST',
      '/api/fs/list',
      { path: '/', password: '', page: 1, per_page: 1, refresh: false } satisfies AlistFsListReq,
    );
  } catch (err) {
    // 401 表示需要登录，但服务器在线
    if (err instanceof OpenListError && err.code === 'AUTH_FAILED') return;
    throw err;
  }
}

/**
 * 获取文件详情（含 raw_url 直链、provider、related 同目录字幕文件）。
 */
export async function alistFsGet(
  baseUrl: string,
  token: string | undefined,
  path: string,
  password: string | undefined,
): Promise<AlistFsGetData> {
  return alistRequest<AlistFsGetData>(
    baseUrl,
    'POST',
    '/api/fs/get',
    { path, password: password || '', page: 1, per_page: 0, refresh: false } satisfies AlistFsGetReq,
    token,
  );
}

/**
 * 列出目录内容（分页）。
 */
export async function alistFsList(
  baseUrl: string,
  token: string | undefined,
  path: string,
  password: string | undefined,
  page: number = 1,
  perPage: number = 100,
  refresh: boolean = false,
): Promise<AlistFsListData> {
  return alistRequest<AlistFsListData>(
    baseUrl,
    'POST',
    '/api/fs/list',
    { path, password: password || '', page, per_page: perPage, refresh } satisfies AlistFsListReq,
    token,
  );
}

/**
 * 搜索文件（按关键词）。
 */
export async function alistFsSearch(
  baseUrl: string,
  token: string | undefined,
  parent: string,
  keywords: string,
  password: string | undefined,
  page: number = 1,
  perPage: number = 100,
): Promise<AlistFsSearchData> {
  return alistRequest<AlistFsSearchData>(
    baseUrl,
    'POST',
    '/api/fs/search',
    {
      parent,
      keywords,
      password: password || '',
      scope: 0,
      page,
      per_page: perPage,
    } satisfies AlistFsSearchReq,
    token,
  );
}

/**
 * 获取当前登录用户信息。
 */
export async function alistMe(
  baseUrl: string,
  token: string,
): Promise<AlistMeData> {
  return alistRequest<AlistMeData>(baseUrl, 'GET', '/api/me', undefined, token);
}
