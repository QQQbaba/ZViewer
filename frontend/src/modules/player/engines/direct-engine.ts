/**
 * Direct 引擎：直接设置 video.src 播放原生支持的格式（mp4/webm/mov/mkv）。
 *
 * 无需 MSE / hls.js / flv.js，浏览器原生解码。
 * Chrome 91+ 支持 MKV 容器（需 H.264/AAC 编码）。
 *
 * 代理策略由 url-proxy.ts 统一控制（分离式架构）：
 * - 智能模式（默认）：B站 CDN / 带防盗链 headers 的源走代理，其他直连
 * - 强制代理模式：所有跨域 URL 走代理（兼容旧方案）
 *
 * attach 在 metadata 就绪后 resolve，cleanup 无需额外操作
 * （video 元素本身由调用方管理）。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'
import { resolveProxyUrl } from '../services/url-proxy'

export const directEngine: PlayerEngine = {
  type: 'direct',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)
    // 统一代理策略：由 url-proxy.ts 根据 forceMediaProxy 开关、URL 特征与源格式决定
    // - B站 MP4 直链（platform=html5 接口，无防盗链）：直连源站，服务器零流量
    // - B站 DASH m4s 流（有防盗链）：走服务器代理
    // - 强制代理模式：所有跨域 URL 走代理
    const targetUrl = resolveProxyUrl(source.url, source.headers, source.format)
    video.src = targetUrl
    video.load()
    await waitForMetadata(video)
    return { cleanup: () => {} }
  },
}
