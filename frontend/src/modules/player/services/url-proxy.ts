/**
 * URL 代理策略中心（分离式架构）。
 *
 * 参照 synctv 的设计，将「是否走服务端代理」的决策从各播放引擎中分离出来，
 * 统一集中到本模块。引擎只调用 `resolveProxyUrl(url, headers)` 这一个入口，
 * 由本模块根据全局 `forceMediaProxy` 开关与 URL 特征决定最终地址。
 *
 * 两种模式：
 * 1. 智能模式（forceMediaProxy=false，默认，SYNCTV 风格无需中转）
 *    - B站 DASH m4s 流：走服务器代理（m4s 有防盗链 + 无 CORS，浏览器无法绕过）
 *    - B站 MP4 直链（platform=html5 接口）：直连源站（HTML5 接口无防盗链）
 *    - 带防盗链 headers 的源：走服务器代理
 *    - 其他源（webdav / ftp / 用户直链 / 服务器本地文件 / blob: / data:）：直连源站
 *      → 服务器零流量，仅承载信令与元数据
 * 2. 强制代理模式（forceMediaProxy=true，兼容旧方案）
 *    - 所有跨域 URL 都走服务端代理
 *      → 服务器承载全部视频流流量，适用于源站 CORS 严格 / 限流 / 防盗链场景
 *
 * 设计动机：
 * 旧版本中 `isBilibiliMediaUrl + buildProxyUrl` 逻辑分散在 direct-engine / dash-player，
 * 且只有 B站 一种代理场景。新增「强制代理」开关时，若仍分散实现会导致各引擎重复逻辑。
 * 集中到本模块后，引擎只需调用 `resolveProxyUrl(url, headers)`，策略变更只改本文件。
 */
import { API_URL } from '@/lib/api'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'

/**
 * 判断 URL 是否为 B站 CDN 媒体地址。
 *
 * 覆盖 B站 各类 CDN 域名：官方 bilivideo、P2P/mcdn、第三方边缘节点、akamaized 海外节点等。
 *
 * 注意：B站 URL 是否需要代理取决于请求方式：
 * - DASH m4s 流：有防盗链 + 无 CORS，必须走服务器代理
 * - MP4 直链（platform=html5 接口）：无防盗链，可直接播放
 * 调用方需结合 source.format 判断，本函数仅判断域名。
 */
export function isBilibiliMediaUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin)
    const host = u.hostname.toLowerCase()
    // 本站自身 API 与本地协议直接放行
    if (
      host === window.location.hostname ||
      u.protocol === 'blob:' ||
      u.protocol === 'data:'
    ) {
      return false
    }
    // 已知 B站 CDN/页面域名
    return /(?:bilibili|bilivideo|hdslb|mountaintoys|mcdn|upos|bstatic|akamaized|pili-video|boss-pgc)/i.test(
      host
    )
  } catch {
    return false
  }
}

/**
 * 判断 URL 是否为本站自身地址（API、blob、data 协议等），
 * 这些地址无需代理，直接由浏览器请求。
 */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin)
    if (u.protocol === 'blob:' || u.protocol === 'data:') return true
    return u.hostname.toLowerCase() === window.location.hostname.toLowerCase()
  } catch {
    return false
  }
}

/**
 * 判断 URL 是否为相对路径（如 /api/webdav/...），
 * 相对路径自动走本站后端，无需包装为代理 URL。
 */
export function isRelativeUrl(url: string): boolean {
  if (!url) return false
  return url.startsWith('/') && !url.startsWith('//')
}

/**
 * 将 URL 包装为后端代理 URL。
 * 后端代理会自动添加 Referer/User-Agent 头绕过防盗链，并透传 Range 请求支持断点续传。
 */
export function buildProxyUrl(url: string): string {
  return `${API_URL}/api/stream/proxy?url=${encodeURIComponent(url)}`
}

/**
 * 读取当前「强制代理」开关状态。
 *
 * 从 systemSettingsStore 读取，store 在 App 启动时通过 public-settings 接口拉取，
 * 管理员保存设置后会调用 invalidate 触发重新拉取。
 */
function isForceMediaProxyEnabled(): boolean {
  return useSystemSettingsStore.getState().forceMediaProxy
}

/**
 * 统一代理策略：根据 URL 特征、源格式与全局开关决定最终请求地址。
 *
 * 决策矩阵（forceMediaProxy=false，智能模式，默认）：
 * | URL 类型                | format=mp4            | format=dash / m4s    |
 * |------------------------|----------------------|---------------------|
 * | 本站 API / blob / data | 直连                  | 直连                |
 * | 相对路径（/api/...）     | 直连                  | 直连                |
 * | 带防盗链 headers        | 服务器代理             | 服务器代理           |
 * | B站 CDN URL            | 直连（HTML5 接口无防盗链）| 服务器代理（m4s 有防盗链）|
 * | 其他跨域 URL            | 直连                  | 直连                |
 *
 * 决策矩阵（forceMediaProxy=true，强制代理模式）：
 * | URL 类型                | 任意 format           |
 * |------------------------|----------------------|
 * | 本站 API / blob / data | 直连                  |
 * | 相对路径（/api/...）     | 直连                  |
 * | 带防盗链 headers        | 服务器代理             |
 * | B站 CDN URL            | 服务器代理             |
 * | 其他跨域 URL            | 服务器代理             |
 *
 * @param url 原始视频流 URL
 * @param headers 可选的防盗链 headers（由后端 resolve 返回）
 * @param format 源格式（'mp4' / 'dash' / 'm4s' / 'm3u8' / 'flv' 等），影响 B站 URL 代理决策
 * @returns 实际请求的 URL（原 URL 或代理 URL）
 */
export function resolveProxyUrl(
  url: string,
  headers?: Record<string, string>,
  format?: string
): string {
  if (!url) return url

  // 本站 URL / blob / data 协议：永不代理
  if (isLocalUrl(url)) return url

  // 相对路径（/api/webdav/...）：自动走本站后端，无需包装
  if (isRelativeUrl(url)) return url

  const forceProxy = isForceMediaProxyEnabled()
  const hasHeaders = !!(headers && Object.keys(headers).length > 0)
  const isBili = isBilibiliMediaUrl(url)

  // 带防盗链 headers：浏览器无法设置 forbidden header，必须走服务器代理
  if (hasHeaders) {
    return buildProxyUrl(url)
  }

  // 强制代理模式：所有跨域 URL 都走服务器代理（兼容旧方案）
  if (forceProxy) {
    return buildProxyUrl(url)
  }

  // 智能模式（默认，SYNCTV 风格无需中转）
  if (isBili) {
    // B站 DASH m4s 流：有防盗链 + 无 CORS，必须走服务器代理
    // 判断依据：format 为 dash / m4s，或 URL 路径包含 .m4s
    const isDashStream =
      format === 'dash' ||
      format === 'm4s' ||
      url.toLowerCase().includes('.m4s') ||
      url.toLowerCase().includes('/dash/');

    if (isDashStream) {
      return buildProxyUrl(url);
    }
    // B站 MP4 直链（platform=html5 接口）：无防盗链，可直接播放
    // 服务器零流量
    return url;
  }

  // 其他跨域 URL：直连源站，服务器零流量
  return url
}

/**
 * 判断 URL 是否需要走代理（用于诊断 / 日志 / 引擎降级判断）。
 */
export function needsProxy(
  url: string,
  headers?: Record<string, string>,
  format?: string
): boolean {
  if (!url) return false
  if (isLocalUrl(url) || isRelativeUrl(url)) return false
  if (headers && Object.keys(headers).length > 0) return true
  if (isForceMediaProxyEnabled()) return true
  if (isBilibiliMediaUrl(url)) {
    // B站 DASH m4s 需要代理，MP4 直链不需要
    const isDashStream =
      format === 'dash' ||
      format === 'm4s' ||
      url.toLowerCase().includes('.m4s') ||
      url.toLowerCase().includes('/dash/');
    return isDashStream;
  }
  return false
}
