import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/** 管理员/用户敏感操作审计日志（仅追加，不修改不删除）。 */
@Entity('audit_logs')
@Index(['createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 操作者用户 ID（guest 为 0；系统操作为 null） */
  @Column({ type: 'integer', nullable: true })
  actorUserId!: number | null;

  /** 操作者用户名（冗余存储，用户被删除后仍可追溯） */
  @Column({ type: 'varchar', nullable: true })
  actorUsername!: string | null;

  /** 操作者角色（root/admin/user/guest/system） */
  @Column({ type: 'varchar', default: 'system' })
  actorRole!: string;

  /** 动作标识：login_failed / login / password_changed / user_deleted /
   *  role_changed / user_approved / room_deleted / rooms_batch_deleted 等 */
  @Column({ type: 'varchar' })
  action!: string;

  /** 操作对象类型与描述（自由文本，如 'user:3 (alice)'） */
  @Column({ type: 'varchar', nullable: true })
  target!: string | null;

  /** 请求来源 IP */
  @Column({ type: 'varchar', nullable: true })
  ip!: string | null;

  /** 是否成功 */
  @Column({ type: 'boolean', default: true })
  success!: boolean;

  /** 补充详情（失败原因等，可选） */
  @Column({ type: 'varchar', nullable: true })
  detail!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
