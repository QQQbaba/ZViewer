import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type UserRole = 'root' | 'admin' | 'user' | 'guest';
export type UserStatus = 'active' | 'pending';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  username!: string;

  @Column()
  passwordHash!: string;

  @Column({ type: 'simple-enum', enum: ['root', 'admin', 'user', 'guest'], default: 'guest' })
  role!: UserRole;

  @Column({ type: 'simple-enum', enum: ['active', 'pending'], default: 'pending' })
  status!: UserStatus;

  /**
   * 头像 URL（相对路径，如 '/uploads/avatars/1-1716840000000.jpg'）。
   * 为 null 时前端使用默认头像（root 用 /root-avatar.jpg，其他用 User 图标）。
   */
  @Column({ type: 'varchar', nullable: true })
  avatar!: string | null;

  /**
   * Token 失效时间戳：早于该时间签发的 JWT 一律拒绝。
   * 修改密码时更新为当前时间——使改密前签发的所有旧 token（含被盗的
   * refresh token）全部失效。null 表示未设置过失效要求。
   */
  @Column({ type: 'datetime', nullable: true })
  tokenInvalidBefore!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
