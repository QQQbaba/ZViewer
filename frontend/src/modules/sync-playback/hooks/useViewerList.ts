import { useEffect } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { useAuthStore } from '@/store/authStore'
import { message } from '@/components/ui/message'
import type { ViewerJoinedPayload, ViewerLeftPayload } from '../types'
import { SOCKET_EVENT } from '../constants'

export type UseViewerListOptions = Record<string, never>

export type UseViewerListReturn = void

/**
 * 观众在线列表同步 Hook：房主与观众均监听 `viewer-joined` / `viewer-left` 事件，
 * 更新 useRoomStore.viewers 以驱动房主端 RoomInfoPanel 的在线观众列表。
 *
 * 后端在观众加入/离开房间时广播这两个事件（详见 routes/room.ts）。
 */
export function useViewerList(): UseViewerListReturn {
  const { socket } = useSocket()

  useEffect(() => {
    if (!socket) return

    const handleViewerJoined = (payload: ViewerJoinedPayload) => {
      if (!payload?.viewerSocketId) return
      // 自己加入不提示
      const me = useAuthStore.getState().user
      if (me && payload.userId != null && me.id === payload.userId) return
      useRoomStore.getState().addViewer({
        socketId: payload.viewerSocketId,
        userId: payload.userId,
        username: payload.username,
        role: payload.role,
      })
      const name = payload.username?.trim() || '有观众'
      message.info(`${name} 加入了房间`)
    }
    const handleViewerLeft = (payload: ViewerLeftPayload) => {
      if (!payload?.viewerSocketId) return
      const me = useAuthStore.getState().user
      useRoomStore.getState().removeViewer(payload.viewerSocketId)
      if (me && payload.userId != null && me.id === payload.userId) return
      message.info('有观众离开了房间')
    }

    socket.on(SOCKET_EVENT.VIEWER_JOINED, handleViewerJoined)
    socket.on(SOCKET_EVENT.VIEWER_LEFT, handleViewerLeft)

    return () => {
      socket.off(SOCKET_EVENT.VIEWER_JOINED, handleViewerJoined)
      socket.off(SOCKET_EVENT.VIEWER_LEFT, handleViewerLeft)
    }
  }, [socket])
}
