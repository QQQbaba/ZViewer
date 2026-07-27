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
   * 强制视频流走服务端代理（兼容旧方案）。
   *
   * - false（默认，SYNCTV 风格无需中转）：智能模式，仅在必须时代理
   *   - B站 CDN URL：走代理（浏览器禁用 Referer / 无 CORS 头，必须代理）
   *   - 带防盗链 headers 的源（如部分番剧源）：走代理
   *   - 其他源（webdav / ftp / 用户直链 / 服务器本地文件）：直连源站或后端相对路径
   * - true（强制代理）：所有跨域 URL 都走服务器代理，服务器承载全部流量
   *   用于应对源站 CORS 严格 / 限流 / 防盗链场景
   */
  @Column({ type: 'boolean', default: false })
  forceMediaProxy!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
