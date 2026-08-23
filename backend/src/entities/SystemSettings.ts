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
   * 内嵌字幕（embedded/muxed 字幕轨道）功能开关。
   * 仅当视频走服务器中转（后端可直接访问视频字节）时内嵌字幕才可用：
   * - server-files：后端本地文件，恒可用
   * - webdav/openlist：仅 directLink=false（服务器中转）时可用，直链不可用
   */
  @Column({ type: 'boolean', default: true })
  embeddedSubtitleEnabled!: boolean;

  /**
   * CDN 代理地址（含协议前缀），如 https://gh-proxy.com。
   * 仅在 cdnAccelerate 为 true 时生效，对所有 GitHub 请求（api.github.com、
   * github.com、objects.githubusercontent.com）统一使用前缀代理方式。
   */
  /**
   * FFmpeg 音频转码开关。
   * 浏览器不支持的音轨编码（DTS/AC3/EAC3/TrueHD 等）在服务器中转时是否由
   * FFmpeg 实时转码为 AAC。默认关闭（手动开启），避免在未安装完整版 FFmpeg 的
   * 环境下对每次请求都做 ffprobe 探测产生额外开销。
   * - true：启用自动转码（需容器命中 + 音轨编码不在浏览器白名单 + FFmpeg 可用）
   * - false：一律直推，浏览器可能无声
   */
  @Column({ type: 'boolean', default: false })
  audioTranscodeEnabled!: boolean;

  @Column({ type: 'text', default: 'https://gh-proxy.com' })
  cdnProxyUrl!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
