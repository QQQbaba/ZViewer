/**
 * 浏览器端转码核心下载进度（全局轻量 store）。
 *
 * wasm-engine 的 worker 下载 ffmpeg.wasm 核心（约 31MB）时上报进度，
 * 控制栏进度条订阅展示。放在 zustand 而非 React 状态链上：
 * worker → WasmPlayer → engine → usePlayerSource → WatchTogetherCore
 * → PlayerControlBar 的层层透传太深，且仅在 MKV+DTS 场景才激活。
 *
 * - loading=true 时控制栏显示「转码引擎准备中」进度条
 * - progress 为 null 表示未知总量（服务器未回 Content-Length），显示不确定动画
 */
import { create } from 'zustand'

export interface WasmCoreProgress {
  part: 'wasm' | 'js'
  loaded: number
  total: number | null
}

interface WasmCoreProgressState {
  loading: boolean
  /** null=加载已结束；非空为当前下载分片的字节进度 */
  progress: WasmCoreProgress | null
}

interface WasmCoreProgressStore extends WasmCoreProgressState {
  setProgress: (p: WasmCoreProgress | null) => void
}

export const useWasmCoreProgress = create<WasmCoreProgressStore>((set) => ({
  loading: false,
  progress: null,
  setProgress: (p) =>
    set({
      progress: p,
      loading: p !== null,
    }),
}))

/** worker/player 内部调用：更新或结束进度显示 */
export function notifyWasmCoreProgress(p: WasmCoreProgress | null): void {
  useWasmCoreProgress.getState().setProgress(p)
}
