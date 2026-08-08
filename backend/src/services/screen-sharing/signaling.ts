import { Server as SocketIOServer, Socket } from 'socket.io';

/** 每个房间当前处于语音聊天中的 socket id 集合 */
const voiceMembers = new Map<string, Set<string>>();

/**
 * 校验 socket 是否已加入指定房间。
 */
function isSocketInRoom(socket: Socket, roomId: string): boolean {
  return socket.rooms.has(roomId);
}

/**
 * 校验双方是否处于同一房间。
 */
async function validateSignalPair(
  io: SocketIOServer,
  fromSocket: Socket,
  toSocketId: string,
): Promise<string | null> {
  const toSocket = io.sockets.sockets.get(toSocketId);
  if (!toSocket) return null;

  const fromRooms = new Set(fromSocket.rooms);
  for (const room of toSocket.rooms) {
    if (room !== toSocket.id && fromRooms.has(room)) {
      return room;
    }
  }
  return null;
}

/**
 * 从房间的语音成员集合中移除指定 socket，并向房间内其他成员广播离开事件。
 */
function leaveVoiceChat(io: SocketIOServer, socket: Socket, roomId: string): void {
  const members = voiceMembers.get(roomId);
  if (!members) return;
  if (!members.has(socket.id)) return;

  members.delete(socket.id);
  socket
    .to(roomId)
    .emit('voice-user-left', { socketId: socket.id });
  console.log(`[voice] ${socket.id} left room ${roomId}`);

  if (members.size === 0) {
    voiceMembers.delete(roomId);
  }
}

// 注册 WebRTC 信令转发相关的事件处理器
// 内部注册 io.on('connection', ...)，所有信令事件均在该处理器内注册
export function registerSignalingHandlers(io: SocketIOServer): void {
  io.on('connection', (socket) => {
    // --- WebRTC 信令：转发 offer ---
    socket.on(
      'signal-offer',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const roomId = await validateSignalPair(io, socket, payload.to);
        if (!roomId) {
          console.warn(
            `[signal-offer] pair validation failed from=${socket.id} to=${payload.to}`,
          );
          return callback?.({ success: false, message: '不在同一房间' });
        }
        console.log(
          `[signal-offer] relay from=${socket.id} to=${payload.to} room=${roomId}`,
        );
        io.to(payload.to).emit('signal-offer', {
          from: socket.id,
          data: payload.data,
        });
        callback?.({ success: true });
      },
    );

    // --- WebRTC 信令：转发 answer ---
    socket.on(
      'signal-answer',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const roomId = await validateSignalPair(io, socket, payload.to);
        if (!roomId) {
          console.warn(
            `[signal-answer] pair validation failed from=${socket.id} to=${payload.to}`,
          );
          return callback?.({ success: false, message: '不在同一房间' });
        }
        console.log(
          `[signal-answer] relay from=${socket.id} to=${payload.to} room=${roomId}`,
        );
        io.to(payload.to).emit('signal-answer', {
          from: socket.id,
          data: payload.data,
        });
        callback?.({ success: true });
      },
    );

    // --- WebRTC 信令：转发 ICE candidate ---
    socket.on(
      'signal-ice-candidate',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const roomId = await validateSignalPair(io, socket, payload.to);
        if (!roomId) {
          console.warn(
            `[signal-ice-candidate] pair validation failed from=${socket.id} to=${payload.to}`,
          );
          return callback?.({ success: false, message: '不在同一房间' });
        }
        io.to(payload.to).emit('signal-ice-candidate', {
          from: socket.id,
          data: payload.data,
        });
        callback?.({ success: true });
      },
    );

    // =====================================================
    // 语音聊天（服务器中转）
    //
    // 不再使用 WebRTC P2P Mesh，改为服务器中转 PCM 音频数据：
    // 客户端通过 AudioWorklet 采集 PCM → Socket.IO 发送到服务器 →
    // 服务器转发给房间内其他语音成员 → 接收端用 Web Audio API 播放。
    // =====================================================

    // --- 加入语音聊天 ---
    socket.on(
      'voice-join',
      (
        payload: { roomId: string },
        callback?: (
          response:
            | { success: true; members: string[] }
            | { success: false; message: string },
        ) => void,
      ) => {
        const { roomId } = payload;
        if (!isSocketInRoom(socket, roomId)) {
          return callback?.({
            success: false,
            message: '不在该房间中',
          });
        }

        let members = voiceMembers.get(roomId);
        if (!members) {
          members = new Set();
          voiceMembers.set(roomId, members);
        }

        if (members.has(socket.id)) {
          return callback?.({
            success: true,
            members: Array.from(members).filter((id) => id !== socket.id),
          });
        }

        members.add(socket.id);
        socket.to(roomId).emit('voice-user-joined', { socketId: socket.id });
        console.log(`[voice] ${socket.id} joined room ${roomId}`);

        callback?.({
          success: true,
          members: Array.from(members).filter((id) => id !== socket.id),
        });
      },
    );

    // --- 离开语音聊天 ---
    socket.on(
      'voice-leave',
      (
        payload: { roomId: string },
        callback?: (response: { success: boolean }) => void,
      ) => {
        leaveVoiceChat(io, socket, payload.roomId);
        callback?.({ success: true });
      },
    );

    // --- 语音音频数据中转 ---
    // 客户端将音频数据（Opus 编码或 PCM 回退）发送到服务器，
    // 服务器转发给房间内其他语音成员。
    // 使用 socket.to(roomId) 广播给房间内除发送者外的所有成员，
    // Socket.IO 会自动处理二进制数据传输。
    socket.on('voice-audio-data', (payload: {
      roomId: string;
      data: ArrayBuffer;
      sampleRate?: number;
      timestamp: number;
      mediaTs?: number;
      encoded?: boolean;
    }) => {
      // 仅转发给同一房间的语音成员
      const members = voiceMembers.get(payload.roomId);
      if (!members || !members.has(socket.id)) return;

      // 转发给房间内其他语音成员（socket.to 不会发回给发送者）
      socket.to(payload.roomId).emit('voice-audio-data', {
        from: socket.id,
        data: payload.data,
        sampleRate: payload.sampleRate,
        timestamp: payload.timestamp,
        mediaTs: payload.mediaTs,
        encoded: payload.encoded,
      });
    });

    // --- 语音编解码器配置转发 ---
    // 发送端在 Opus 编码器首次输出时，将 codec description 发送给房间内其他成员，
    // 接收端使用该 description 配置各自的 AudioDecoder。
    socket.on('voice-codec-config', (payload: { roomId: string; description: ArrayBuffer }) => {
      const members = voiceMembers.get(payload.roomId);
      if (!members || !members.has(socket.id)) return;

      socket.to(payload.roomId).emit('voice-codec-config', {
        from: socket.id,
        description: payload.description,
      });
    });

    // --- 断开连接时自动清理语音聊天状态 ---
    socket.on('disconnect', () => {
      for (const roomId of Array.from(socket.rooms)) {
        if (roomId === socket.id) continue;
        leaveVoiceChat(io, socket, roomId);
      }
    });
  });
}
