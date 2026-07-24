import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { ICE_SERVERS } from '@/modules/screen-sharing/constants'

export interface VoiceMember {
  socketId: string
  username?: string
  speaking?: boolean
}

export interface UseVoiceChatOptions {
  socket: Socket | null
  roomId: string | undefined
  username?: string
}

export interface UseVoiceChatResult {
  /** 是否已加入语音聊天 */
  joined: boolean
  /** 是否正在加入中 */
  joining: boolean
  /** 本地麦克风是否启用 */
  micEnabled: boolean
  /** 当前语音成员列表（包含自己） */
  members: VoiceMember[]
  /** 全局输出音量 0~1 */
  globalVolume: number
  /** 每个远端成员对应的单独音量 0~1 */
  peerVolumes: Map<string, number>
  /** 每个远端成员对应的延迟（RTT，单位 ms），未采集到时可能不存在 */
  peerLatencies: Map<string, number>
  /** 加入语音聊天 */
  join: () => Promise<void>
  /** 离开语音聊天 */
  leave: () => void
  /** 切换本地麦克风开关 */
  toggleMic: () => void
  /** 设置全局输出音量 */
  setGlobalVolume: (value: number) => void
  /** 设置某个远端成员的单独音量 */
  setPeerVolume: (socketId: string, value: number) => void
  /** 本地麦克风反送（监听）是否开启 */
  monitorEnabled: boolean
  /** 切换本地麦克风反送开关 */
  toggleMonitor: () => void
  /** 本地麦克风输入音量 0~1（影响所有远端用户听到的音量） */
  micVolume: number
  /** 设置本地麦克风输入音量 */
  setMicVolume: (value: number) => void
}

interface SignalPayload<T> {
  from: string
  data: T
}

/**
 * 语音聊天核心 hook（WebRTC Mesh）。
 *
 * 每个加入语音的用户与房间内其他所有语音成员建立 P2P 连接，
 * 仅传输音频 track，实现多人在线语音。
 */
export function useVoiceChat(options: UseVoiceChatOptions): UseVoiceChatResult {
  const { socket, roomId, username } = options

  const [joined, setJoined] = useState(false)
  const [joining, setJoining] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [members, setMembers] = useState<VoiceMember[]>([])
  const [globalVolume, setGlobalVolumeState] = useState(1)
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map())
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [micVolume, setMicVolumeState] = useState(1)
  const [peerLatencies, setPeerLatencies] = useState<Map<string, number>>(
    new Map()
  )

  const localStreamRef = useRef<MediaStream | null>(null)
  const processedStreamRef = useRef<MediaStream | null>(null)
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const remoteAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(
    new Map()
  )
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(
    new Map()
  )
  const localMonitorAudioRef = useRef<HTMLAudioElement | null>(null)
  const socketRef = useRef(socket)
  const roomIdRef = useRef(roomId)
  const usernameRef = useRef(username)
  const globalVolumeRef = useRef(globalVolume)
  const peerVolumesRef = useRef(peerVolumes)
  const micVolumeRef = useRef(micVolume)
  const audioContextRef = useRef<AudioContext | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)

  useEffect(() => {
    globalVolumeRef.current = globalVolume
  }, [globalVolume])

  useEffect(() => {
    peerVolumesRef.current = peerVolumes
  }, [peerVolumes])

  useEffect(() => {
    micVolumeRef.current = micVolume
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = micVolume
    }
  }, [micVolume])

  useEffect(() => {
    socketRef.current = socket
    roomIdRef.current = roomId
    usernameRef.current = username
  }, [socket, roomId, username])

  const applyAudioVolume = useCallback((socketId: string) => {
    const audioEl = remoteAudioElementsRef.current.get(socketId)
    if (!audioEl) return
    const peerVolume = peerVolumesRef.current.get(socketId) ?? 1
    audioEl.volume = Math.max(
      0,
      Math.min(1, globalVolumeRef.current * peerVolume)
    )
  }, [])

  const cleanupPeerConnection = useCallback((socketId: string) => {
    const pc = peerConnectionsRef.current.get(socketId)
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.close()
      peerConnectionsRef.current.delete(socketId)
    }
    pendingIceCandidatesRef.current.delete(socketId)

    const audioEl = remoteAudioElementsRef.current.get(socketId)
    if (audioEl) {
      audioEl.pause()
      audioEl.srcObject = null
      audioEl.remove()
      remoteAudioElementsRef.current.delete(socketId)
    }
  }, [])

  const stopMonitor = useCallback(() => {
    const audioEl = localMonitorAudioRef.current
    if (audioEl) {
      audioEl.pause()
      audioEl.srcObject = null
      audioEl.remove()
      localMonitorAudioRef.current = null
    }
  }, [])

  const startMonitor = useCallback(() => {
    const stream = processedStreamRef.current ?? localStreamRef.current
    if (!stream) return
    let audioEl = localMonitorAudioRef.current
    if (!audioEl) {
      audioEl = document.createElement('audio')
      audioEl.autoplay = true
      audioEl.muted = false
      audioEl.dataset.voiceMonitor = 'self'
      document.body.appendChild(audioEl)
      localMonitorAudioRef.current = audioEl
    }
    if (audioEl.srcObject !== stream) {
      // eslint-disable-next-line react-hooks/immutability
      audioEl.srcObject = stream
    }
  }, [])

  const cleanupAll = useCallback(() => {
    peerConnectionsRef.current.forEach((_, socketId) => {
      cleanupPeerConnection(socketId)
    })
    stopMonitor()
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    processedStreamRef.current = null
    try {
      audioContextRef.current?.close()
    } catch {
      // ignore
    }
    audioContextRef.current = null
    gainNodeRef.current = null
    setMembers([])
    setJoined(false)
    setJoining(false)
    setMicEnabled(true)
    setMonitorEnabled(false)
    setMicVolumeState(1)
    setPeerLatencies(new Map())
  }, [cleanupPeerConnection, stopMonitor])

  const createPeerConnection = useCallback(
    (targetSocketId: string) => {
      const currentSocket = socketRef.current
      if (!currentSocket) return null

      if (peerConnectionsRef.current.has(targetSocketId)) {
        const existing = peerConnectionsRef.current.get(targetSocketId)
        if (
          existing &&
          existing.connectionState !== 'closed' &&
          existing.signalingState !== 'closed'
        ) {
          return existing
        }
        cleanupPeerConnection(targetSocketId)
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      peerConnectionsRef.current.set(targetSocketId, pc)

      // 添加本地音频 track（使用经过 Web Audio 增益处理后的流）
      const localStream = processedStreamRef.current ?? localStreamRef.current
      if (localStream) {
        localStream.getAudioTracks().forEach((track) => {
          pc.addTrack(track, localStream)
        })
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          currentSocket.emit('voice-ice-candidate', {
            to: targetSocketId,
            data: event.candidate,
          })
        }
      }

      pc.ontrack = (event) => {
        const remoteStream = event.streams[0] || new MediaStream([event.track])
        let audioEl = remoteAudioElementsRef.current.get(targetSocketId)
        if (!audioEl) {
          audioEl = document.createElement('audio')
          audioEl.autoplay = true
          audioEl.dataset.voicePeer = targetSocketId
          document.body.appendChild(audioEl)
          remoteAudioElementsRef.current.set(targetSocketId, audioEl)
        }
        if (audioEl.srcObject !== remoteStream) {
          audioEl.srcObject = remoteStream
        }
        applyAudioVolume(targetSocketId)
      }

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'closed' ||
          pc.connectionState === 'disconnected'
        ) {
          setMembers((prev) =>
            prev.filter((m) => m.socketId !== targetSocketId)
          )
        }
      }

      return pc
    },
    [cleanupPeerConnection, applyAudioVolume]
  )

  const createAndSendOffer = useCallback(
    async (targetSocketId: string) => {
      const currentSocket = socketRef.current
      const pc = createPeerConnection(targetSocketId)
      if (!pc || !currentSocket) return

      if (pc.signalingState !== 'stable') {
        console.log('[voice] skip offer, pc not stable:', pc.signalingState)
        return
      }

      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        currentSocket.emit('voice-offer', {
          to: targetSocketId,
          data: offer,
        })
      } catch (err) {
        console.error('[voice] create offer error:', err)
      }
    },
    [createPeerConnection]
  )

  const handleVoiceOffer = useCallback(
    async (payload: SignalPayload<RTCSessionDescriptionInit>) => {
      const currentSocket = socketRef.current
      const pc = createPeerConnection(payload.from)
      if (!pc || !currentSocket) return

      try {
        if (pc.signalingState !== 'stable') {
          console.log('[voice] skip offer in state:', pc.signalingState)
          return
        }
        await pc.setRemoteDescription(new RTCSessionDescription(payload.data))

        const pending = pendingIceCandidatesRef.current.get(payload.from) ?? []
        pendingIceCandidatesRef.current.delete(payload.from)
        for (const candidate of pending) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
          } catch (e) {
            console.error('[voice] add queued ice candidate error:', e)
          }
        }

        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        currentSocket.emit('voice-answer', {
          to: payload.from,
          data: answer,
        })
      } catch (err) {
        console.error('[voice] handle offer error:', err)
      }
    },
    [createPeerConnection]
  )

  const handleVoiceAnswer = useCallback(
    async (payload: SignalPayload<RTCSessionDescriptionInit>) => {
      const pc = peerConnectionsRef.current.get(payload.from)
      if (!pc) return
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.data))

        const pending = pendingIceCandidatesRef.current.get(payload.from) ?? []
        pendingIceCandidatesRef.current.delete(payload.from)
        for (const candidate of pending) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
          } catch (e) {
            console.error('[voice] add queued ice candidate error:', e)
          }
        }
      } catch (err) {
        console.error('[voice] handle answer error:', err)
      }
    },
    []
  )

  const handleVoiceIceCandidate = useCallback(
    async (payload: SignalPayload<RTCIceCandidateInit>) => {
      const pc = peerConnectionsRef.current.get(payload.from)
      if (!pc) return
      try {
        if (!pc.remoteDescription) {
          const pending =
            pendingIceCandidatesRef.current.get(payload.from) ?? []
          pending.push(payload.data)
          pendingIceCandidatesRef.current.set(payload.from, pending)
          return
        }
        await pc.addIceCandidate(new RTCIceCandidate(payload.data))
      } catch (err) {
        console.error('[voice] add ice candidate error:', err)
      }
    },
    []
  )

  const handleVoiceUserJoined = useCallback(
    (payload: { socketId: string }) => {
      const currentSocketId = socketRef.current?.id
      if (!currentSocketId || payload.socketId === currentSocketId) return

      setMembers((prev) => {
        if (prev.some((m) => m.socketId === payload.socketId)) return prev
        return [
          ...prev,
          {
            socketId: payload.socketId,
            username: payload.socketId.slice(0, 6),
          },
        ]
      })

      // 新成员加入时，主动向新成员发送 offer
      void createAndSendOffer(payload.socketId)
    },
    [createAndSendOffer]
  )

  const handleVoiceUserLeft = useCallback(
    (payload: { socketId: string }) => {
      cleanupPeerConnection(payload.socketId)
      setMembers((prev) => prev.filter((m) => m.socketId !== payload.socketId))
    },
    [cleanupPeerConnection]
  )

  const join = useCallback(async () => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (!currentSocket || !currentRoomId) {
      message.error('未连接到房间')
      return
    }
    if (joined || joining) return

    setJoining(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      localStreamRef.current = stream

      // 通过 Web Audio 构建增益链路，让麦克风音量对所有远端用户生效
      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const gainNode = audioContext.createGain()
      gainNode.gain.value = micVolumeRef.current
      source.connect(gainNode)
      const destination = audioContext.createMediaStreamDestination()
      gainNode.connect(destination)
      await audioContext.resume()
      audioContextRef.current = audioContext
      gainNodeRef.current = gainNode
      processedStreamRef.current = destination.stream

      // 触发一次性麦克风权限提示后的音量检测
      stream.getAudioTracks().forEach((track) => {
        track.enabled = micEnabled
      })

      const response = await new Promise<
        | { success: true; members: string[] }
        | { success: false; message: string }
      >((resolve) => {
        currentSocket.emit(
          'voice-join',
          { roomId: currentRoomId },
          (
            res:
              | { success: true; members: string[] }
              | { success: false; message: string }
          ) => resolve(res)
        )
      })

      if ('message' in response) {
        message.error(response.message ?? '加入语音聊天失败')
        stream.getTracks().forEach((track) => track.stop())
        localStreamRef.current = null
        setJoining(false)
        return
      }

      setJoined(true)
      setJoining(false)

      const currentSocketId = currentSocket.id
      const initialMembers: VoiceMember[] = response.members.map((id) => ({
        socketId: id,
        username: id.slice(0, 6),
      }))
      if (currentSocketId) {
        initialMembers.unshift({ socketId: currentSocketId, username })
      }
      setMembers(initialMembers)

      // 向所有已在房间语音中的成员发送 offer
      for (const memberId of response.members) {
        void createAndSendOffer(memberId)
      }
    } catch (err) {
      console.error('[voice] join error:', err)
      message.error('无法获取麦克风权限或加入语音失败')
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
      setJoining(false)
    }
  }, [joined, joining, micEnabled, username, createAndSendOffer])

  const leave = useCallback(() => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (currentSocket && currentRoomId) {
      currentSocket.emit('voice-leave', { roomId: currentRoomId })
    }
    cleanupAll()
  }, [cleanupAll])

  const toggleMic = useCallback(() => {
    setMicEnabled((prev) => {
      const next = !prev
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = next
      })
      return next
    })
  }, [])

  const toggleMonitor = useCallback(() => {
    setMonitorEnabled((prev) => {
      const next = !prev
      if (next) {
        startMonitor()
      } else {
        stopMonitor()
      }
      return next
    })
  }, [startMonitor, stopMonitor])

  // 反送开关状态变化时同步本地监听
  useEffect(() => {
    if (!joined) return
    if (monitorEnabled) {
      startMonitor()
    } else {
      stopMonitor()
    }
  }, [joined, monitorEnabled, startMonitor, stopMonitor])

  const setMicVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    setMicVolumeState(clamped)
    micVolumeRef.current = clamped
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = clamped
    }
  }, [])

  const setGlobalVolume = useCallback(
    (value: number) => {
      const clamped = Math.max(0, Math.min(1, value))
      setGlobalVolumeState(clamped)
      globalVolumeRef.current = clamped
      remoteAudioElementsRef.current.forEach((_, socketId) => {
        applyAudioVolume(socketId)
      })
    },
    [applyAudioVolume]
  )

  const setPeerVolume = useCallback(
    (socketId: string, value: number) => {
      const clamped = Math.max(0, Math.min(1, value))
      setPeerVolumes((prev) => {
        const next = new Map(prev)
        next.set(socketId, clamped)
        return next
      })
      peerVolumesRef.current.set(socketId, clamped)
      applyAudioVolume(socketId)
    },
    [applyAudioVolume]
  )

  // 定时采集每个 PeerConnection 的 RTT，用于展示语音延迟
  const updateLatencies = useCallback(() => {
    const next = new Map<string, number>()
    peerConnectionsRef.current.forEach((pc, socketId) => {
      pc.getStats()
        .then((report) => {
          let activePair: RTCIceCandidatePairStats | null = null
          report.forEach((value) => {
            if (value.type === 'candidate-pair') {
              const pair = value as RTCIceCandidatePairStats
              if (pair.nominated || pair.state === 'succeeded') {
                if (!activePair || (pair.nominated && !activePair.nominated)) {
                  activePair = pair
                }
              }
            }
          })
          const rtt = activePair?.currentRoundTripTime
          if (typeof rtt === 'number' && rtt >= 0) {
            next.set(socketId, Math.round(rtt * 1000))
          }
        })
        .catch((err) => {
          console.error('[voice] getStats error:', err)
        })
    })
    setPeerLatencies(next)
  }, [])

  useEffect(() => {
    if (!joined) return
    const timer = setInterval(updateLatencies, 2000)
    return () => {
      clearInterval(timer)
    }
  }, [joined, updateLatencies])

  // 监听 socket 事件
  useEffect(() => {
    if (!socket) return

    socket.on('voice-offer', handleVoiceOffer)
    socket.on('voice-answer', handleVoiceAnswer)
    socket.on('voice-ice-candidate', handleVoiceIceCandidate)
    socket.on('voice-user-joined', handleVoiceUserJoined)
    socket.on('voice-user-left', handleVoiceUserLeft)

    return () => {
      socket.off('voice-offer', handleVoiceOffer)
      socket.off('voice-answer', handleVoiceAnswer)
      socket.off('voice-ice-candidate', handleVoiceIceCandidate)
      socket.off('voice-user-joined', handleVoiceUserJoined)
      socket.off('voice-user-left', handleVoiceUserLeft)
    }
  }, [
    socket,
    handleVoiceOffer,
    handleVoiceAnswer,
    handleVoiceIceCandidate,
    handleVoiceUserJoined,
    handleVoiceUserLeft,
  ])

  // 组件卸载或房间变化时自动离开
  useEffect(() => {
    return () => {
      if (joined) {
        leave()
      }
    }
  }, [joined, leave])

  return {
    joined,
    joining,
    micEnabled,
    members,
    globalVolume,
    peerVolumes,
    peerLatencies,
    monitorEnabled,
    micVolume,
    join,
    leave,
    toggleMic,
    toggleMonitor,
    setGlobalVolume,
    setPeerVolume,
    setMicVolume,
  }
}
