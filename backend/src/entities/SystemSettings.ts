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
  @Column({ type: 'boolean', default: false })
  dashDisabled!: boolean;

  /**
   * 更新 CDN 加速开关。
   * - true：更新检测和下载走 CDN 加速域名
   * - false：直连 GitHub
   */
  @Column({ type: 'boolean', default: false })
  cdnAccelerate!: boolean;

  /**
   * GitHub API 加速域名（不含协议前缀），如 api.github.cdn.zero251.xyz。
   * 仅在 cdnAccelerate 为 true 时生效，替换 api.github.com。
   */
  @Column({ type: 'text', default: '' })
  apiCdnDomain!: string;

  /**
   * GitHub Release 下载加速域名（不含协议前缀），如 release.github.cdn.zero251.xyz。
   * 仅在 cdnAccelerate 为 true 时生效，替换 objects.githubusercontent.com。
   */
  @Column({ type: 'text', default: '' })
  releaseCdnDomain!: string;

  /**
   * GitHub 主站加速域名（不含协议前缀），如 main.github.cdn.zero251.xyz。
   * 仅在 cdnAccelerate 为 true 时生效，替换 github.com（Release 下载第一步）。
   */
  @Column({ type: 'text', default: '' })
  mainCdnDomain!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
