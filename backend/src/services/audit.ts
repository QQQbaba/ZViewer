/**
 * 审计日志服务：记录敏感操作（管理员改角色/删用户、登录失败、改密等）。
 *
 * 设计：
 * - 仅追加（append-only），不提供修改/删除 API
 * - 写入失败静默吞掉（审计不应阻断业务主流程），但打印错误日志
 * - 保留策略由外部清理任务决定（此处不主动清理）
 */
import { AppDataSource } from '../data-source';
import { AuditLog } from '../entities/AuditLog';

export interface AuditEntry {
  actorUserId?: number | null;
  actorUsername?: string | null;
  actorRole?: string;
  action: string;
  target?: string | null;
  ip?: string | null;
  success?: boolean;
  detail?: string | null;
}

export function writeAuditLog(entry: AuditEntry): void {
  try {
    const repo = AppDataSource.getRepository(AuditLog);
    const log = repo.create({
      actorUserId: entry.actorUserId ?? null,
      actorUsername: entry.actorUsername ?? null,
      actorRole: entry.actorRole ?? 'system',
      action: entry.action,
      target: entry.target ?? null,
      ip: entry.ip ?? null,
      success: entry.success ?? true,
      detail: entry.detail ?? null,
    });
    // 异步写入，不等待、不阻断主流程
    void repo.save(log).catch((err) => {
      console.error('[audit] write failed:', err);
    });
  } catch (err) {
    console.error('[audit] write failed:', err);
  }
}
