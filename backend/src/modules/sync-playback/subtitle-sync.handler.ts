/**
 * 字幕状态同步处理器。
 *
 * 处理 subtitle-update：房主加载/切换/开关字幕时下发，后端转发给房间内其他成员。
 * payload 含完整的轨道数据（tracks + cues），观众端 useSubtitles 监听同一事件
 * 并直接合并到本地状态，实现字幕实时同步。
 *
 * 此 handler 修复了前端 emit subtitle-update 但后端从不转发的 bug：
 * socket.io 不会自动广播客户端 emit 的事件，必须由服务端显式转发。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { roomStateService } from '../room/room-state.service';

export class SubtitleSyncHandler implements SocketEventHandler {
  readonly name = 'SubtitleSyncHandler';

  register(socket: Socket, _io: SocketIOServer): void {
    socket.on(
      'subtitle-update',
      async (payload: unknown, callback?: AckCallback) => {
        try {
          const data = payload as { roomId?: string } | undefined;
          if (!data?.roomId) {
            return safeAck(callback, {
              success: false,
              message: '缺少 roomId',
            });
          }

          // 仅房主可广播字幕状态
          if (
            !(await roomPermissionService.isRoomHost(socket, data.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '无权限更新字幕状态',
            });
          }

          // 缓存最近一次字幕状态：观众中途加入/刷新时补发，
          // 否则观众只能在房主下次变更字幕时才收到（加入前已加载的字幕无法同步）
          roomStateService.setSubtitle(data.roomId, payload);

          // 转发给房间内其他成员（不含发送者，房主本地状态已是最新）
          socket.to(data.roomId).emit('subtitle-update', payload);
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[subtitle-update] error:', err);
          safeAck(callback, { success: false, message: '字幕状态转发失败' });
        }
      },
    );

    // 观众挂载字幕监听器后主动拉取：加入时立即回发的 subtitle-update
    // 早于观众前端 useEffect 挂载而丢失，此处回发房主缓存的当前状态。
    socket.on('subtitle-request', (payload: unknown) => {
      try {
        const data = payload as { roomId?: string } | undefined;
        if (!data?.roomId) return;
        const cached = roomStateService.getSubtitle(data.roomId);
        if (cached != null) {
          socket.emit('subtitle-update', cached);
        }
      } catch (err) {
        console.error('[subtitle-request] error:', err);
      }
    });
  }
}
