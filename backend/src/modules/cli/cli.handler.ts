/**
 * CLI 代理 Socket 事件处理器。
 *
 * 处理本地 zcontrol-cli 客户端的注册、列表查询与断开通知：
 * - cli-register：CLI 代理注册到房间，广播 cli-agent-available
 * - cli-list-agents：前端查询房间内 CLI 代理列表
 * - disconnect：CLI 断开时广播 cli-agent-unavailable
 *
 * 设计要点：
 * - CLI 代理无需 access_token，由 io.use 中间件按 agent='zcontrol-cli' 放行
 * - 代理信息存储在 socket.data.cliAgent，通过 io.in(roomId).fetchSockets() 聚合
 * - CLI 加入房间后可接收房间事件（watch-together-state 等），便于终端日志展示
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler } from '../socket';

/** CLI 代理信息（下发到前端 cliAgentStore） */
export interface CliAgentInfo {
  socketId: string;
  proxyUrl: string;
  agent?: string;
  version?: string;
}

/** cli-register 事件 payload */
interface CliRegisterPayload {
  roomId: string;
  proxyUrl: string;
  agent?: string;
  version?: string;
}

/**
 * CLI 代理事件处理器。
 */
export class CliHandler implements SocketEventHandler {
  readonly name = 'CliHandler';

  register(socket: Socket, io: SocketIOServer): void {
    // 1. CLI 代理注册
    socket.on(
      'cli-register',
      (payload: CliRegisterPayload) => {
        // 校验是否为 CLI 代理（由 io.use 中间件设置 socket.data.isCliAgent）
        if (!socket.data.isCliAgent) {
          io.to(socket.id).emit('cli-error', {
            message: '未授权的 CLI 代理连接',
          });
          return;
        }

        const { roomId, proxyUrl, agent, version } = payload;
        if (!roomId || !proxyUrl) {
          io.to(socket.id).emit('cli-error', {
            message: '缺少 roomId 或 proxyUrl',
          });
          return;
        }

        // 存储代理信息到 socket.data，供 cli-list-agents 聚合查询
        const agentInfo: CliAgentInfo = {
          socketId: socket.id,
          proxyUrl,
          agent,
          version,
        };
        socket.data.cliAgent = agentInfo;
        socket.data.cliRoomId = roomId;

        // 加入房间：CLI 可接收房间事件用于终端日志展示
        void socket.join(roomId);

        // 通知 CLI 注册成功
        io.to(socket.id).emit('cli-registered', { roomId });

        // 广播给房间内所有成员（含新加入的 CLI 自身作为二次确认）
        io.to(roomId).emit('cli-agent-available', agentInfo);

        console.log(
          `[CLI] 代理注册: socketId=${socket.id} roomId=${roomId} proxyUrl=${proxyUrl}`,
        );
      },
    );

    // 2. 前端查询房间内 CLI 代理列表
    socket.on('cli-list-agents', async (roomId: string) => {
      if (typeof roomId !== 'string' || !roomId) return;
      const agents = await this.getRoomAgents(io, roomId);
      io.to(socket.id).emit('cli-agents', { roomId, agents });
    });

    // 3. 断开连接时通知房间内其他成员
    socket.on('disconnect', () => {
      const agent = socket.data.cliAgent as CliAgentInfo | undefined;
      const roomId = socket.data.cliRoomId as string | undefined;
      if (!agent || !roomId) return;

      io.to(roomId).emit('cli-agent-unavailable', { socketId: agent.socketId });
      console.log(
        `[CLI] 代理下线: socketId=${socket.id} roomId=${roomId}`,
      );
    });
  }

  /**
   * 获取房间内所有已注册的 CLI 代理。
   *
   * 通过 io.in(roomId).fetchSockets() 遍历房间内所有 socket，
   * 筛选出 socket.data.cliAgent 存在的（即已注册的 CLI 代理）。
   */
  private async getRoomAgents(
    io: SocketIOServer,
    roomId: string,
  ): Promise<CliAgentInfo[]> {
    const sockets = await io.in(roomId).fetchSockets();
    const agents: CliAgentInfo[] = [];
    for (const sock of sockets) {
      const agent = sock.data.cliAgent as CliAgentInfo | undefined;
      if (agent) {
        agents.push(agent);
      }
    }
    return agents;
  }
}
