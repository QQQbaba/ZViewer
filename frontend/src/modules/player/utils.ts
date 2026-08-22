/**
 * 播放器工具函数
 *
 * 从旧 msePlayer.ts 抽取的、与具体引擎无关的视频元素操作工具。
 */

/**
 * 在切换 MediaSource / blob URL 前彻底重置 video 元素，
 * 避免旧的 MediaSource 仍在 attached 状态导致 Format error。
 */
export function resetVideoElement(video: HTMLVideoElement): void {
  try {
    video.pause()
  } catch {
    // ignore
  }
  video.removeAttribute('src')
  video.src = ''
  video.load()
}

/**
 * 等待 video 元素 metadata 加载完成（readyState >= 1）。
 *
 * 调用方在 attach 后设置 currentTime 前必须等待 metadata，
 * 否则浏览器会丢弃 currentTime 赋值（readyState < 1 时 seek 无效）。
 *
 * 同时监听 error 事件并附带超时：只触发 error 不触发 loadedmetadata 的加载失败
 * 若不 reject 会让 Promise 永不 settle，进而卡死 attach 串行队列（播放器假死）。
 */
export const METADATA_TIMEOUT_MS = 30_000

export function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      clearTimeout(timer)
    }
    const onLoaded = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(
        new Error(
          `媒体加载失败（code=${video.error?.code ?? 'unknown'}${
            video.error?.message ? `: ${video.error.message}` : ''
          }）`
        )
      )
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('等待媒体 metadata 超时（30s）'))
    }, METADATA_TIMEOUT_MS)

    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('error', onError)
  })
}
