/**
 * Direct 引擎：直接设置 video.src 播放原生支持的格式（mp4/webm/mov/mkv）。
 *
 * 无需 MSE / hls.js / flv.js，浏览器原生解码。
 * Chrome 91+ 支持 MKV 容器（需 H.264/AAC 编码）。
 *
 * 代理策略由 url-proxy.ts 统一控制（分离式架构）：
 * - B站 DASH m4s / 带防盗链 headers 的源走服务器代理
 * - 其他源（B站 MP4 直链 / webdav / ftp / 用户直链）直连
 * - 直连失败时（跨域防盗链 / CORS / 403），自动回退到服务器代理重试
 *
 * attach 在 metadata 就绪后 resolve，cleanup 无需额外操作
 * （video 元素本身由调用方管理）。
 *
 * 对于转码流（fragmented MP4），video.duration 可能为 Infinity。
 * 引擎会先发 HEAD 请求获取 X-Content-Duration header，
 * 并存储到 video.dataset.serverDuration 供 useVideoDuration 回退使用。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement } from '../utils'
import {
  resolveProxyUrl,
  buildProxyUrl,
  isLocalUrl,
  isRelativeUrl,
  isCliProxyUrl,
} from '../services/url-proxy'

/**
 * 等待 video metadata 就绪或 error 事件。
 *
 * 与 utils.waitForMetadata 不同，本函数同时监听 error 事件，
 * 加载失败时 reject 而非永久 pending，使调用方可捕获并回退重试。
 */
function waitForMetadataOrError(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
    }
    const onLoaded = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      const code = video.error?.code
      reject(new Error(`video load error (code=${code ?? 'unknown'})`))
    }
    video.addEventListener('loadedmetadata', onLoaded, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
}

/**
 * 判断 URL 是否可以回退到服务器代理。
 *
 * 仅对跨域 URL 有效：
 * - 本站 URL / 相对路径 / blob / data：无需代理
 * - CLI 代理 URL：已是本地代理
 * - 已包装的代理 URL：避免重复代理
 */
function canFallbackToProxy(url: string): boolean {
  if (!url) return false
  if (isLocalUrl(url) || isRelativeUrl(url) || isCliProxyUrl(url)) return false
  if (url.includes('/api/stream/proxy')) return false
  return true
}

export const directEngine: PlayerEngine = {
  type: 'direct',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)
    // 统一代理策略：由 url-proxy.ts 根据 URL 特征与源格式决定
    const targetUrl = resolveProxyUrl(source.url, source.headers, source.format)

    // 先发 HEAD 请求尝试获取 X-Content-Duration（转码流场景）。
    // HEAD 与正式加载并行执行且带 5s 超时：慢代理/挂起的 HEAD 不推迟首帧，
    // 失败或超时静默跳过（转码流时长回退由 X-Content-Duration header 探测路径兜底）。
    // 相对路径直接使用（浏览器用当前页面 origin 解析，同域请求携带 cookie）
    const headPromise = (async () => {
      try {
        const headRes = await fetch(targetUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        })
        const contentDuration = headRes.headers.get('X-Content-Duration')
        if (contentDuration) {
          const d = parseFloat(contentDuration)
          if (Number.isFinite(d) && d > 0) {
            video.dataset.serverDuration = d.toString()
          }
        }
      } catch {
        // HEAD 请求失败（CORS 限制 / 超时），静默跳过
      }
    })()

    // 尝试加载视频：直连失败时回退到服务器代理（绕过跨域防盗链 / CORS）
    const fallback = canFallbackToProxy(targetUrl)

    const loadOnce = async (url: string): Promise<void> => {
      video.src = url
      video.load()
      await waitForMetadataOrError(video)
    }

    try {
      await loadOnce(targetUrl)
    } catch (err) {
      if (!fallback) throw err
      console.warn('[direct-engine] 直连失败，回退到服务器代理:', err)
      resetVideoElement(video)
      const proxyUrl = buildProxyUrl(source.url)
      await loadOnce(proxyUrl)
    }
    // 等待 HEAD 结算（超时上限 5s，不显著阻塞；结果仅写 dataset）
    await headPromise

    return {
      cleanup: () => {
        delete video.dataset.serverDuration
      },
    }
  },
}
