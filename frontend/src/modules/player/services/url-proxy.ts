/**
 * URL 代理策略中心（分离式架构）。
 *
 * 将「是否走服务端代理」的决策从各播放引擎中分离出来，统一集中到本模块。
 * 引擎只调用 `resolveProxyUrl(url, headers, format)` 这一个入口，
 * 由本模块根据 URL 特征决定最终地址。
 *
 * 当前策略：
 * - B站 DASH m4s 流：走服务器代理（m4s 有防盗链 + 无 CORS，浏览器无法绕过）
 * - 带防盗链 headers 的源：走服务器代理（浏览器无法设置 forbidden header）
 * - 其他源（B站 MP4 直链 / webdav / ftp / 用户直链 / 服务器本地文件 / blob / data）：直连
 *   → 服务器零流量，仅承载信令与元数据
 *
 * 设计动机：
 * 旧版本中 `isBilibiliMediaUrl + buildProxyUrl` 逻辑分散在 direct-engine / dash-player，
 * 且只有 B站 一种代理场景。集中到本模块后，引擎只需调用 `resolveProxyUrl(url, headers, format)`，
 * 策略变更只改本文件。
 */
import { API_URL } from '@/lib/api'

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
 * 统一代理策略：根据 URL 特征与源格式决定最终请求地址。
 *
 * 决策矩阵：
 * | URL 类型                | format=mp4            | format=dash / m4s    |
 * |------------------------|----------------------|---------------------|
 * | 本站 API / blob / data | 直连                  | 直连                |
 * | 相对路径（/api/...）     | 直连                  | 直连                |
 * | 带防盗链 headers        | 服务器代理             | 服务器代理           |
 * | B站 CDN URL            | 直连（HTML5 接口无防盗链）| 服务器代理（m4s 有防盗链）|
 * | 其他跨域 URL            | 直连                  | 直连                |
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

  const hasHeaders = !!(headers && Object.keys(headers).length > 0)
  const isBili = isBilibiliMediaUrl(url)

  // 带防盗链 headers：浏览器无法设置 forbidden header，必须走服务器代理
  if (hasHeaders) {
    return buildProxyUrl(url)
  }

  // B站 DASH m4s 流：有防盗链 + 无 CORS，必须走服务器代理
  if (isBili) {
    const isDashStream =
      format === 'dash' ||
      format === 'm4s' ||
      url.toLowerCase().includes('.m4s') ||
      url.toLowerCase().includes('/dash/')

    if (isDashStream) {
      return buildProxyUrl(url)
    }
    // B站 MP4 直链（platform=html5 接口）：无防盗链，可直接播放
    // 服务器零流量
    return url
  }

  // 其他跨域 URL：直连源站，服务器零流量
  return url
}
