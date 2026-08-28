/**
 * 引擎选择器
 *
 * 根据源格式与音频轨信息选择合适的播放引擎。
 *
 * 选择逻辑：
 * 1. format='dash' 或 含 audioUrl → DASH 引擎（dash.js，动态生成 MPD 包装 m4s）
 * 2. format='hls' → HLS 引擎
 * 3. format='flv' → FLV 引擎
 * 4. format='mkv' 且音轨编码浏览器不支持（DTS/AC3 等）且功能开关开启
 *    → Wasm 引擎（ffmpeg.wasm 浏览器内转码，中转/直链通用）
 * 5. 其他 → Direct 引擎（浏览器原生播放 mp4/webm 等）
 *
 * 注：自研 MSE 引擎已移除（曾长期不可达：所有含独立音频轨的源统一由
 *    dash.js 引擎处理，失败时降级为 direct + audio-sync）。
 */
import type { PlayerEngine, PlayerSource } from './types'
import { dashEngine } from './engines/dash-engine'
import { hlsEngine } from './engines/hls-engine'
import { flvEngine } from './engines/flv-engine'
import { directEngine } from './engines/direct-engine'
import { wasmEngine, isWasmEngineSupported } from './wasm-engine/engine'
import { needsWasmAudioTranscode } from '@/lib/audioCodecs'

/** 所有引擎实例（单例，无需重复创建） */
const ENGINES: Record<string, PlayerEngine> = {
  dash: dashEngine,
  hls: hlsEngine,
  flv: flvEngine,
  direct: directEngine,
  wasm: wasmEngine,
}

export interface EngineSelectionContext {
  /**
   * 浏览器端音频转码的实际触发条件（usePlayerSource 已完成判定后传入）：
   * 全局开关（systemSettingsStore.audioTranscodeEnabled，仅做许可）&&
   * 影片级 wasmEngine 标记（添加影片时勾选并检测到需要）。
   * 任一不满足时永不选择 wasm 引擎（直推、可能无声）。
   */
  wasmAudioTranscodeEnabled?: boolean
}

/**
 * 根据源数据选择合适的播放引擎。
 *
 * 注意：MKV 且 audioCodec 未知的源也会选 wasm 引擎——后端可能没有
 * ffprobe（探测失败返回 null），此时无法预知音轨编码。wasm 引擎内部
 * 解析出真实 CodecID 后自行决策：
 * - 音轨是 AAC → 纯 remux（不加载 wasm 核心，无额外开销）
 * - 其他编码（DTS/AC3…）→ 浏览器内转码
 * 这比走 direct 引擎无声更符合预期；视频轨不支持等失败场景由
 * usePlayerSource 的回退链路降级原生播放。
 */
export function selectEngine(
  source: PlayerSource,
  ctx: EngineSelectionContext = {}
): PlayerEngine {
  // DASH 源或含独立音频轨 → dash.js 引擎
  // （自研 MSE 引擎暂时禁用，统一由 dash.js 处理双轨合并）
  if (source.format === 'dash' || source.audioUrl) {
    return ENGINES.dash
  }
  if (source.format === 'hls') {
    return ENGINES.hls
  }
  if (source.format === 'flv') {
    return ENGINES.flv
  }
  // MKV + 开关开启 → 浏览器端 ffmpeg.wasm 转码引擎
  // 已知不支持的编码（dts/ac3…）或编码未知（后端无 ffprobe）都交给 wasm；
  // 已知受支持编码（aac/mp3 等）仍走 direct 原生播放。
  if (
    source.format === 'mkv' &&
    ctx.wasmAudioTranscodeEnabled === true &&
    isWasmEngineSupported()
  ) {
    const knownUnsupported =
      source.audioCodec != null && needsWasmAudioTranscode(source.audioCodec)
    const unknownCodec = source.audioCodec == null || source.audioCodec === ''
    if (knownUnsupported || unknownCodec) {
      return ENGINES.wasm
    }
  }
  return ENGINES.direct
}
