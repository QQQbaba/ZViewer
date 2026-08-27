/**
 * Wasm 引擎：对 ffmpeg.wasm 播放控制器（WasmPlayer）的 PlayerEngine 适配。
 *
 * 适用场景：MKV 容器 + 浏览器不支持的音轨编码（DTS/AC3/EAC3 等），
 * 且管理员开启了「浏览器端音频转码」。无论影片是服务器中转还是直链，
 * 字节都由本引擎直接从源地址（或代理回退）读取，在浏览器内完成音频
 * 解码与 AAC 重编码，服务端零参与。
 *
 * attach 失败（不支持的容器/视频轨、MSE 不支持等）会抛错，由上层
 * usePlayerSource 的回退链路切换回原生 direct 引擎播放。
 */
import type {
  PlayerEngine,
  PlayerSource,
  EngineAttachResult,
  PlayerController,
} from '../types'
import { resetVideoElement } from '../utils'
import { WasmPlayer } from './player'

/** 判断当前浏览器是否具备 wasm 转码引擎的运行条件 */
export function isWasmEngineSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'MediaSource' in window &&
    !!window.MediaSource?.isTypeSupported?.(
      'video/mp4; codecs="avc1.640029, mp4a.40.2"'
    ) &&
    'AudioEncoder' in globalThis &&
    typeof (globalThis as { Worker?: unknown }).Worker === 'function'
  )
}

/**
 * 每次调用 start 都创建全新的 WasmPlayer 世代（内部管理 MSE / 字节流）。
 */
class WasmPlayerController implements PlayerController {
  private video: HTMLVideoElement
  private source: PlayerSource
  private current: WasmPlayer | null = null

  constructor(video: HTMLVideoElement, source: PlayerSource) {
    this.video = video
    this.source = source
  }

  get isAttached(): boolean {
    return !!this.current && this.current.isAttached
  }

  get isSeeking(): boolean {
    return false
  }

  async attach(startTime?: number): Promise<string> {
    if (!isWasmEngineSupported()) {
      throw new Error('浏览器不支持 WebCodecs/MSE，无法启用浏览器端转码')
    }
    if (!('createImageBitmap' in window)) {
      // 极旧环境保护（几乎所有支持 AudioEncoder 的浏览器都满足）
      throw new Error('浏览器过旧，无法启用浏览器端转码')
    }
    // 结束旧实例（切换/重载场景）
    this.current?.cleanup()
    resetVideoElement(this.video)
    const fallbackDuration =
      this.source.duration && this.source.duration > 0
        ? this.source.duration
        : this.video.dataset.serverDuration
          ? parseFloat(this.video.dataset.serverDuration)
          : undefined

    const player = new WasmPlayer({
      video: this.video,
      sourceUrl: this.source.url,
      headers: this.source.headers,
      fallbackDurationSec: fallbackDuration,
      // 起播后发生的致命错误（解码崩溃多次恢复失败等）：必须立刻
      // 终止本实例并向上传播——否则旧管线残留的 worker 会继续向已
      // 拆除的 SourceBuffer 写入（InvalidStateError 刷屏），且回退
      // 引擎接手前 video 处于坏死状态。
      onFatal: (err) => {
        console.warn('[wasm-engine] 致命错误，终止当前实例:', err.message)
        if (this.current === player) {
          try {
            player.cleanup()
          } catch {
            /* ignore */
          }
          this.current = null
        }
        throw err
      },
    })
    await player.start(startTime ?? this.source.startTime ?? 0)
    this.current = player
    // 无 blob URL：直接把 MediaSource 接到 video.src
    return ''
  }

  async seekTo(targetTime: number) {
    if (!this.current)
      return { success: false, needReload: true, message: '未挂载' }
    try {
      const r = await this.current.seekTo(targetTime)
      return r.success
        ? { success: true }
        : { success: false, needReload: true, message: '目标位置尚无索引' }
    } catch (err) {
      return {
        success: false,
        needReload: true,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  cleanup(): void {
    try {
      this.current?.cleanup()
    } catch {
      /* ignore */
    }
    this.current = null
  }
}

export const wasmEngine: PlayerEngine = {
  type: 'wasm',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    const controller = new WasmPlayerController(video, source)
    let blobUrl: string
    try {
      blobUrl = await controller.attach(source.startTime ?? 0)
    } catch (err) {
      // attach 半途失败（起播超时/多次跳越失败等）：必须终结半挂载的
      // 实例，否则残留管线的 worker 持续向已拆除的 SourceBuffer 写入，
      // 并与回退引擎竞争 video 元素（InvalidStateError 刷屏的根源）。
      controller.cleanup()
      throw err
    }

    return {
      cleanup: () => controller.cleanup(),
      blobUrl: blobUrl || undefined,
      player: controller,
    }
  },
}
