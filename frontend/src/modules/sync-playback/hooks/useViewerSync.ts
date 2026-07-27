/**
 * useViewerSync Hook
 *
 * 观众侧同步编排 Hook：组合所有观众需要的同步子 hook，提供统一入口。
 *
 * 组合的子 hook：
 * - useViewerStateSync: 接收房主 state/control 事件（房主在线时）
 * - usePlaybackStateRequest: 从服务器请求初始状态（ack 直返，房主离线时也能获取）
 * - useServerHeartbeat: 订阅服务器心跳（房主离线时服务器接管广播）
 *
 * 新架构设计：
 * - 房主在线时：通过 watch-together-state / watch-together-control 实时同步
 * - 房主离线时：服务器每 2s 广播 server-heartbeat，观众继续播放
 * - 观众加入时：优先从服务器获取推算后的状态（不依赖房主响应）
 *
 * 调用方（useWatchTogether）只需调用一次 useViewerSync 即可启用所有观众同步逻辑。
 *
 * 该 hook 无返回值：观众端不需要主动调用同步 API，所有逻辑通过副作用执行。
 */
import type { RefObject, MutableRefObject } from 'react'
import type { WatchTogetherState } from '../types'
import type { SeekToResult } from '../services'
import { useViewerStateSync, useViewerHeartbeat } from './useViewerStateSync'
import {
  useServerHeartbeat,
  usePlaybackStateRequest,
} from '@/modules/playback-memory'

export interface UseViewerSyncOptions {
  roomId: string
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  setWatchTogether: (state: WatchTogetherState) => void
  applySourceToVideo: (
    video: HTMLVideoElement,
    state: WatchTogetherState,
    startTime?: number
  ) => Promise<void>
  /** 当前播放状态（用于服务器心跳的 URL 过期检测） */
  watchTogether: WatchTogetherState
  /** seek 到目标时间（MSE 流不重建 MediaSource，由 useVideoSource 提供） */
  seekTo: (video: HTMLVideoElement, targetTime: number) => Promise<SeekToResult>
  /** MSE seek 失败时调用（如 video.error），用 forceReload 重新加载 */
  reloadVideo: (video: HTMLVideoElement) => Promise<void>
}

export type UseViewerSyncReturn = void

export function useViewerSync({
  roomId,
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  applySourceToVideo,
  watchTogether,
  seekTo,
  reloadVideo,
}: UseViewerSyncOptions): UseViewerSyncReturn {
  // 1. 接收房主实时状态（房主在线时）
  useViewerStateSync({
    roomId,
    isHostRef,
    videoRef,
    suppressEventsRef,
    setWatchTogether,
    applySourceToVideo,
    seekTo,
    reloadVideo,
  })

  // 2. 订阅房主心跳（房主在线时，每 5s 校正进度漂移）
  useViewerHeartbeat({
    isHostRef,
    videoRef,
    suppressEventsRef,
  })

  // 3. 从服务器请求初始状态（加入房间时，ack 直返）
  usePlaybackStateRequest({
    roomId,
    isHostRef,
    videoRef,
    suppressEventsRef,
    setWatchTogether,
    applySourceToVideo,
  })

  // 4. 订阅服务器心跳（房主离线时服务器接管广播，观众继续播放）
  useServerHeartbeat({
    isHostRef,
    videoRef,
    suppressEventsRef,
    setWatchTogether,
    watchTogether,
  })
}
