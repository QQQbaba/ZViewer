/**
 * 视频源管理 Hook（v2 重写）：负责将 WatchTogetherState 中的视频源应用到
 * <video> 元素，包括 MSE DASH 合并、音频同步、以及组件挂载时的源恢复。
 *
 * 底层使用 player 模块的 usePlayerSource 进行引擎选择与 attach。
 * 本 Hook 在其之上扩展：
 * 1. WatchTogetherState → PlayerSource 字段映射
 * 2. 组件挂载时的源恢复（依赖 roomStore，仅观众端或无待加载影片时执行）
 * 3. seek 到未缓冲区域时的 MSE seek / 失败重载
 *
 * 观众端不再独立解析 B站 视频，所有源类型统一使用房主广播的
 * sourceUrl/audioUrl 进行 MSE attach，避免凭证不一致与 CDN 限流。
 * restoredRef 保证每个挂载周期只恢复一次源，避免与 handleLoad / handleState 重复加载。
 *
 * 房主端在挂载时若 roomStore 中存在 currentMovieId，跳过恢复 effect，
 * 交由 useWatchTogether.loadMovie 重新解析 B站 并加载最新地址，
 * 避免两个 effect 并发调用 applySourceToVideo 导致 MSE 互相 abort。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useRoomStore } from '@/store/roomStore'
import { message } from '@/components/ui/message'
import { usePlayerSource } from '@/modules/player'
import type { PlayerSource } from '@/modules/player'
import { waitForMetadata } from '@/modules/player/utils'
import type { WatchTogetherState } from '../types'
import { safePlay } from '../safePlay'
import { executeSeek } from '../services'
import type { SeekToResult } from '../services'

export interface UseVideoSourceOptions {
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  watchTogether: WatchTogetherState
  /** 房主标识 ref。用于在挂载恢复 effect 中跳过房主，由 loadMovie 全权处理加载，
   *  避免恢复 effect 与 loadMovie 并发调用 applySourceToVideo 导致 MSE attach 互相 abort。 */
  isHostRef: MutableRefObject<boolean>
}

export interface UseVideoSourceReturn {
  applySourceToVideo: (
    video: HTMLVideoElement,
    state: WatchTogetherState,
    startTime?: number
  ) => Promise<void>
  cleanupMedia: () => void
  restoredRef: MutableRefObject<boolean>
  /** seek 到目标时间（MSE 流不重建 MediaSource，普通流返回 success=false） */
  seekTo: (video: HTMLVideoElement, targetTime: number) => Promise<SeekToResult>
  /** 重载视频源（重载按钮用）：从当前播放位置附近重新 attach */
  reloadVideo: (video: HTMLVideoElement) => Promise<void>
}

/**
 * WatchTogetherState → PlayerSource 字段映射。
 * PlayerSource 是引擎 attach 所需的最小字段集，从 WatchTogetherState 中抽取。
 */
function toPlayerSource(
  state: WatchTogetherState,
  startTime?: number
): PlayerSource {
  const source: PlayerSource = {
    url: state.sourceUrl,
    audioUrl: state.audioUrl,
    format: state.format,
    videoCodec: state.videoCodec,
    audioCodec: state.audioCodec,
    headers: state.headers,
  }
  if (startTime !== undefined && startTime > 0) {
    source.startTime = startTime
  }
  return source
}

/** 播放状态快照：reloadVideo 前保存，attach 完成后恢复 */
interface PlaybackSnapshot {
  currentTime: number
  playbackRate: number
  volume: number
  muted: boolean
  paused: boolean
}

function takeSnapshot(video: HTMLVideoElement): PlaybackSnapshot {
  return {
    currentTime: video.currentTime,
    playbackRate: video.playbackRate,
    volume: video.volume,
    muted: video.muted,
    paused: video.paused,
  }
}

/** attach 完成后恢复播放状态（倍速 / 音量 / 静音 / 进度 / 播放暂停） */
async function restoreSnapshot(
  video: HTMLVideoElement,
  snapshot: PlaybackSnapshot
): Promise<void> {
  // 等待 metadata 加载完成后再恢复 currentTime，否则 seek 会被浏览器丢弃
  await waitForMetadata(video)

  if (video.playbackRate !== snapshot.playbackRate) {
    video.playbackRate = snapshot.playbackRate
  }
  if (video.volume !== snapshot.volume) {
    video.volume = snapshot.volume
  }
  if (video.muted !== snapshot.muted) {
    video.muted = snapshot.muted
  }
  if (snapshot.currentTime > 0) {
    try {
      video.currentTime = snapshot.currentTime
    } catch {
      /* ignore */
    }
  }
  if (!snapshot.paused) {
    void safePlay(video)
  } else if (!video.paused) {
    video.pause()
  }
}

export function useVideoSource({
  videoRef,
  suppressEventsRef,
  watchTogether,
  isHostRef,
}: UseVideoSourceOptions): UseVideoSourceReturn {
  const { attachSource, cleanup, seekTo, forceReload } = usePlayerSource({
    videoRef,
  })
  const restoredRef = useRef(false)

  const cleanupMedia = cleanup

  // 将指定状态中的视频源应用到 video 元素（含 MSE DASH 处理）。
  // 供房主加载、观众同步以及组件重新挂载时恢复使用。
  // 所有源类型（包括 bilibili）统一逻辑：
  //   - DASH / 含 audioUrl：使用 MSE 合并 videoUrl + audioUrl
  //   - 其他格式（如 mp4）：直接设置 video.src
  // 观众端不再独立调用 B站 解析接口，直接复用房主广播的地址。
  const applySourceToVideo = useCallback(
    async (
      video: HTMLVideoElement,
      state: WatchTogetherState,
      startTime?: number
    ) => {
      if (!state.sourceUrl) return
      await attachSource(video, toPlayerSource(state, startTime))
    },
    [attachSource]
  )

  // 组件重新挂载（或 videoRef 首次可用）时，从 roomStore 恢复视频源。
  // 通过 restoredRef 保证每个挂载周期只恢复一次，避免与 handleLoad / handleState 重复加载。
  //
  // 房主端：若 roomStore 中存在 currentMovieId，跳过恢复 effect，交由
  // useWatchTogether.loadMovie 重新解析 B站 并加载最新地址。
  // 否则恢复 effect 与 loadMovie 会并发调用 applySourceToVideo，
  // 后者的 resetVideoElement 会 abort 前者的 MSE attach，导致黑屏。
  useEffect(() => {
    const video = videoRef.current
    const storeState = useRoomStore.getState()
    const state = storeState.watchTogether
    if (!video || !state.sourceUrl || restoredRef.current) return

    // 房主有待加载的影片时，让 loadMovie effect 全权处理
    if (isHostRef.current && storeState.currentMovieId) {
      restoredRef.current = true
      return
    }

    restoredRef.current = true
    suppressEventsRef.current = true
    // 传入 state.currentTime 作为 startTime：页面刷新后恢复播放进度时，
    // MsePlayer 从该时间对应的字节偏移开始下载，而非从文件头顺序下载。
    // 否则恢复后需要从头加载到 currentTime 才能播放。
    const startTime = state.currentTime > 0 ? state.currentTime : undefined
    void applySourceToVideo(video, state, startTime)
      .then(() => {
        if (state.currentTime > 0) {
          video.currentTime = state.currentTime
        }
        if (video.playbackRate !== state.playbackRate) {
          video.playbackRate = state.playbackRate
        }
        if (state.isPlaying && video.paused) {
          // 组件挂载恢复源时同样需要处理自动播放策略
          void safePlay(video)
        }
        suppressEventsRef.current = false
      })
      .catch((err: unknown) => {
        // MSE attach 失败时必须释放 suppressEventsRef，否则房主端
        // play/pause/seek/timeupdate 事件全部被吞，无法广播 state 给观众，
        // 导致观众端永久黑屏。
        console.error('[useVideoSource] 恢复视频源失败:', err)
        suppressEventsRef.current = false
        // 向用户展示错误（如不支持的视频格式），避免黑屏无反馈
        message.error(err instanceof Error ? err.message : '视频源加载失败')
      })
  }, [
    watchTogether.sourceUrl,
    applySourceToVideo,
    videoRef,
    suppressEventsRef,
    isHostRef,
  ])

  // 重载视频源：重载按钮调用 + MSE seek 失败时的恢复手段。
  // 从当前播放位置附近重新 attach（MSE 引擎通过 startTime 计算 Range 下载起点），
  // 完成后恢复到原播放位置。用于视频卡死、花屏、缓冲异常等场景的手动恢复。
  // 也用于 MSE seek 失败（video.error）时：创建全新 MsePlayer 实例，
  // 用最新 state URL 重新加载，避免旧实例的 video.error / URL 过期问题。
  const reloadVideo = useCallback(
    async (video: HTMLVideoElement) => {
      // 在重载前快照当前播放状态（避免 attach 异步期间状态变化）
      const snapshot = takeSnapshot(video)

      // 获取最新 state，确保使用最新 URL（避免 URL 过期）
      const state = useRoomStore.getState().watchTogether
      if (!state.sourceUrl) return

      suppressEventsRef.current = true
      useRoomStore.getState().setReloadingState(true, snapshot.currentTime)
      try {
        await forceReload(video, toPlayerSource(state, snapshot.currentTime))
        await restoreSnapshot(video, snapshot)
      } catch (err) {
        console.error('[useVideoSource] 重载视频源失败:', err)
        message.error(err instanceof Error ? err.message : '视频重载失败')
      } finally {
        suppressEventsRef.current = false
        useRoomStore.getState().setReloadingState(false, null)
      }
    },
    [forceReload, suppressEventsRef]
  )

  // seek 到未缓冲区域时的处理：
  // 当用户回退到 SourceBuffer 中已被清理的位置时，视频会卡死（没有数据可播放）。
  // 调用 executeSeek → MsePlayer.seekTo（不重建 MediaSource，清空 SourceBuffer + Range 下载）。
  // 仅对 MSE 流（DASH / 含 audioUrl）生效，普通 mp4 直链由浏览器原生处理。
  // MSE seek 失败时（如 video.error），executeSeek 会调用 onSeekFailed → reloadVideo
  // 创建全新 MsePlayer 实例（用最新 state URL）重新加载。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const isReloadingRef = { current: false }

    const handleSeeking = () => {
      if (suppressEventsRef.current) return

      // 注意：不在此处检查 isReloadingRef——锁占用期间到达的 seek 目标
      // 由 executeSeek 记录为待处理目标，锁释放后接续处理（连续拖拽不丢目标）
      const targetTime = video.currentTime
      const state = useRoomStore.getState().watchTogether

      void executeSeek({
        video,
        targetTime,
        state,
        seekTo,
        suppressEventsRef,
        isReloadingRef,
        onSeekFailed: reloadVideo,
      })
    }

    video.addEventListener('seeking', handleSeeking)
    return () => {
      video.removeEventListener('seeking', handleSeeking)
    }
  }, [videoRef, seekTo, suppressEventsRef, reloadVideo])

  return {
    applySourceToVideo,
    cleanupMedia,
    restoredRef,
    seekTo,
    reloadVideo,
  }
}
