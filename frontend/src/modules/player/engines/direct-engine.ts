/**
 * Direct 引擎：直接设置 video.src 播放原生支持的格式（mp4/webm/mov/mkv）。
 *
 * 无需 MSE / hls.js / flv.js，浏览器原生解码。
 * Chrome 91+ 支持 MKV 容器（需 H.264/AAC 编码）。
 *
 * B站 MP4 直链场景：CDN 有防盗链（Referer 检查），浏览器 video.src 加载时
 * 发送的是当前页面 Referer 会被 403 拦截。通过 isBilibiliMediaUrl 检测后
 * 包装为后端代理 URL，由后端注入正确的 Referer 绕过防盗链。
 *
 * attach 在 metadata 就绪后 resolve，cleanup 无需额外操作
 * （video 元素本身由调用方管理）。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'
import { isBilibiliMediaUrl, buildProxyUrl } from '../services/url-proxy'

export const directEngine: PlayerEngine = {
  type: 'direct',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)
    // B站 CDN URL 走后端代理绕过防盗链（Referer 检查）
    const targetUrl = isBilibiliMediaUrl(source.url)
      ? buildProxyUrl(source.url)
      : source.url
    video.src = targetUrl
    video.load()
    await waitForMetadata(video)
    return { cleanup: () => {} }
  },
}
