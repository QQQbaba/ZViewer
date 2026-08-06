/**
 * useServerHeartbeat Hook
 *
 * 订阅服务器心跳事件（server-heartbeat）。
 *
 * 旧架构：房主每 2s 广播 host-heartbeat，房主断开后观众 6s 超时暂停。
 * 新架构：服务器每 2s 广播 server-heartbeat（仅房主离线时），观众端继续播放。
 *
 * 行为：
 * - 收到 server-heartbeat 时，更新本地状态（基于服务器推算的进度）
 * - 不再因房主离线而暂停播放
 * - 监听 host-disconnected 仅显示提示，不暂停
 * - 检测 URL 过期后暂停并提示
 */
import { useEffect, useRef, useCallback } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import type { WatchTogetherState } from '@/modules/sync-playback/types'
import { SOCKET_EVENT } from '@/modules/sync-playback/constants'
import { safePlay } from '@/modules/sync-playback/safePlay'
import { shouldSeekToHost } from '@/modules/sync-playback/services'
import type { ServerHeartbeatPayload } from '../types'
import {
  isBilibiliUrlExpired,
  isVideoSourceExpired,
} from '../services/url-expiry'

export interface UseServerHeartbeatOptions {
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  setWatchTogether: (state: WatchTogetherState) => void
  /** 当前播放状态（用于 URL 过期检测） */
  watchTogether: WatchTogetherState
}

export type UseServerHeartbeatReturn = void

export function useServerHeartbeat({
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  watchTogether,
}: UseServerHeartbeatOptions): UseServerHeartbeatReturn {
  const { socket } = useSocket()
  // 防止重复提示"房主已离开"
  const hostLeftNotifiedRef = useRef(false)
  // 房主离线标记：房主离开后观众进入自主控制模式，不再应用服务器心跳
  const hostOfflineRef = useRef(false)
  // URL 过期状态标记
  const urlExpiredRef = useRef(false)
  // 已处理的 video error 签名，避免同一个 error 重复触发过期提示
  const lastErrorSignatureRef = useRef<string | null>(null)
  // 缓存最新的 watchTogether 供 callback 读取
  const watchTogetherRef = useRef(watchTogether)
  useEffect(() => {
    watchTogetherRef.current = watchTogether
  }, [watchTogether])

  // 处理服务器心跳：更新本地状态
  const handleServerHeartbeat = useCallback(
    (payload: ServerHeartbeatPayload) => {
      // 缓冲下载期间跳过：useViewerStateSync/usePlaybackStateRequest 在下载时
      // 设置 suppressEventsRef=true，若此处提前释放会破坏下载期间的抑制标记，
      // 导致旧源触发的 video 事件回环。下载完成后下一帧心跳会自然应用最新状态。
      if (suppressEventsRef.current) return

      // 房主离线后观众进入自主控制模式：不再应用服务器推算的播放状态，
      // 避免 isPlaying/currentTime 强制覆盖观众的 play/pause/seek 操作。
      // URL 过期检测由 video error 事件兜底。
      if (hostOfflineRef.current) return

      const state = payload.state
      suppressEventsRef.current = true
      setWatchTogether(state)

      const video = videoRef.current
      if (!video) {
        suppressEventsRef.current = false
        return
      }

      // URL 过期后不再应用状态（等待房主重连）
      if (urlExpiredRef.current) {
        suppressEventsRef.current = false
        return
      }

      // 缓冲模式下视频从 blob URL 播放，state.sourceUrl（B站 CDN URL）的 deadline
      // 过期不影响实际播放，忽略 deadline 检测。
      // 此处仅通过 URL deadline 做严格过期判断；video.error 的兜底检测在 error
      // 事件监听中处理，避免 MSE/DASH 切换或 transient error 导致误报。
      const isBufferMode = state.bufferMode === true
      if (!isBufferMode && isBilibiliUrlExpired(state.sourceUrl)) {
        urlExpiredRef.current = true
        if (!video.paused) video.pause()
        message.warning('视频源已过期，等待房主重连')
        suppressEventsRef.current = false
        return
      }

      // 自适应 seek 跟随
      if (
        shouldSeekToHost(
          video.currentTime,
          state.currentTime,
          state.playbackRate
        )
      ) {
        try {
          video.currentTime = state.currentTime
        } catch {
          // ignore
        }
      }

      // 同步播放/暂停状态
      if (state.isPlaying && video.paused) {
        void safePlay(video)
      } else if (!state.isPlaying && !video.paused) {
        video.pause()
      }

      // 同步倍速
      if (video.playbackRate !== state.playbackRate) {
        video.playbackRate = state.playbackRate
      }

      suppressEventsRef.current = false
    },
    [videoRef, suppressEventsRef, setWatchTogether]
  )

  // 订阅服务器心跳
  useEffect(() => {
    if (!socket || isHostRef.current) return

    socket.on(SOCKET_EVENT.SERVER_HEARTBEAT, handleServerHeartbeat)

    return () => {
      socket.off(SOCKET_EVENT.SERVER_HEARTBEAT, handleServerHeartbeat)
    }
  }, [socket, isHostRef, handleServerHeartbeat])

  // 监听 host-disconnected：仅提示，不暂停播放
  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleHostDisconnected = () => {
      hostOfflineRef.current = true
      if (hostLeftNotifiedRef.current) return
      hostLeftNotifiedRef.current = true
      // 仅提示，不暂停播放（观众进入自主控制模式）
      message.info('房主已离开，您可以自主控制播放')
    }

    // 房主重连时重置标记（通过 sharer-ready 事件判断）
    const handleHostReconnect = () => {
      hostOfflineRef.current = false
      hostLeftNotifiedRef.current = false
      urlExpiredRef.current = false
    }

    socket.on(SOCKET_EVENT.HOST_DISCONNECTED, handleHostDisconnected)
    socket.on('sharer-ready', handleHostReconnect)

    return () => {
      socket.off(SOCKET_EVENT.HOST_DISCONNECTED, handleHostDisconnected)
      socket.off('sharer-ready', handleHostReconnect)
    }
  }, [socket, isHostRef])

  // 切换视频源后重置过期标记与 error 签名，避免房主添加新视频或观众进入房间时
  // 被旧状态误拦截。
  useEffect(() => {
    urlExpiredRef.current = false
    lastErrorSignatureRef.current = null
  }, [watchTogether.sourceUrl])

  // 监听 video error 事件（URL 过期兜底检测）
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleError = () => {
      if (urlExpiredRef.current) return
      // attach / reload / seek 等操作期间 suppressEventsRef 为 true，此时产生的
      // transient error（如 resetVideoElement、切换 DASH/MP4 引擎）不应被判定为
      // URL 过期，避免误报。
      if (suppressEventsRef.current) return

      const error = video.error
      if (!error) return

      // 同一个 error 不重复处理（MSE/DASH 切换或重试时可能触发相同 error）
      const signature = `${error.code}-${error.message ?? ''}-${video.currentSrc}`
      if (lastErrorSignatureRef.current === signature) return
      lastErrorSignatureRef.current = signature

      const currentState = watchTogetherRef.current
      if (isVideoSourceExpired(currentState.sourceUrl, error, video)) {
        urlExpiredRef.current = true
        if (!video.paused) video.pause()
        message.warning('视频源已过期，等待房主重连')
      }
    }

    video.addEventListener('error', handleError)
    return () => {
      video.removeEventListener('error', handleError)
    }
  }, [videoRef, suppressEventsRef])
}
