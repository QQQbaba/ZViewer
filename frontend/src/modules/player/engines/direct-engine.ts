/**
 * Direct 引擎：直接设置 video.src 播放原生支持的格式（mp4/webm/mov）。
 *
 * 无需 MSE / hls.js / flv.js，浏览器原生解码。
 * attach 在 metadata 就绪后 resolve，cleanup 无需额外操作
 * （video 元素本身由调用方管理）。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'

export const directEngine: PlayerEngine = {
  type: 'direct',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)
    video.src = source.url
    video.load()
    await waitForMetadata(video)
    return { cleanup: () => {} }
  },
}
