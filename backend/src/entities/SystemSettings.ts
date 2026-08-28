import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class SystemSettings {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'boolean', default: true })
  autoDeleteInactiveRooms!: boolean;

  @Column({ type: 'integer', default: 24 })
  autoDeleteAfterHours!: number;

  @Column({ type: 'json', nullable: true })
  dataSourceConfig!: Record<string, unknown> | null;

  @Column({ type: 'text', default: 'approval' })
  registrationMode!: 'open' | 'approval' | 'closed';

  /**
   * 房间创建权限模式。
   * - `admin-only`：仅 root/admin 可创建房间（向后兼容旧行为）
   * - `all-users`：所有已登录的 user/admin/root 均可创建房间（guest 始终禁止）
   */
  @Column({ type: 'text', default: 'admin-only' })
  roomCreationMode!: 'admin-only' | 'all-users';

  @Column({ type: 'boolean', default: false })
  betaFeaturesEnabled!: boolean;

  /**
   * 禁用服务器端 DASH 流模式。
   * - true：服务器端 B站 解析强制使用 MP4 模式（preferMp4），不再返回 DASH 流
   * - false：正常 DASH/MP4 自动选择
   * 注意：仅影响服务器端解析，不影响 CLI 代理的 DASH 模式
   */
  @Column({ type: 'boolean', default: true })
  dashDisabled!: boolean;

  /**
   * CDN 加速开关。
   * - true：更新检测和下载走 CDN 代理
   * - false：直连 GitHub
   */
  @Column({ type: 'boolean', default: false })
  cdnAccelerate!: boolean;

  /**
   * 内嵌字幕功能开关（已废弃，仅保留数据库列避免迁移）。
   * 内嵌字幕提取已全部前端化（浏览器端 MKV demux 流式提取），
   * 中转与直链均可用，不再需要服务器开关控制。
   */
  @Column({ type: 'boolean', default: true })
  embeddedSubtitleEnabled!: boolean;

  /**
   * CDN 代理地址（含协议前缀），如 https://gh-proxy.com。
   * 仅在 cdnAccelerate 为 true 时生效，对所有 GitHub 请求（api.github.com、
   * github.com、objects.githubusercontent.com）统一使用前缀代理方式。
   */
  /**
   * 音频转码全局许可开关。
   * 浏览器不支持的音轨编码（DTS/AC3/EAC3/TrueHD 等）：
   * - Emby/Jellyfin 源：开启后由其媒体服务器转码为 AAC HLS 流
   * - 其余来源：仅做许可——需影片级 wasmEngine 标记（添加影片时勾选）
   *   同时满足才启用前端 ffmpeg.wasm 浏览器端转码引擎
   * - false：一律直推，浏览器可能无声
   */
  @Column({ type: 'boolean', default: false })
  audioTranscodeEnabled!: boolean;

  /**
   * ffmpeg.wasm 转码核心（约 32MB wasm 二进制）的下载来源。
   * - author：作者提供的 CDN 直链（不走服务器，减少服务器带宽占用）
   * - server：服务器中转（/ffmpeg 静态路由，兼容性最好）
   * - custom：自定义直链（wasmCoreCustomUrl 指定的完整 URL）
   * ffmpeg-core.js 垫片（约 110KB）恒定从服务器加载，不参与该选择。
   */
  @Column({ type: 'text', default: 'author' })
  wasmCoreSource!: 'author' | 'server' | 'custom';

  /** 自定义 wasm 核心直链（wasmCoreSource=custom 时生效，完整 URL） */
  @Column({ type: 'text', default: '' })
  wasmCoreCustomUrl!: string;

  @Column({ type: 'text', default: 'https://gh-proxy.com' })
  cdnProxyUrl!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
