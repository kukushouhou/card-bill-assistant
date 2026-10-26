import type { Prisma, UpgradeTaskItem } from '../../../generated/prisma/client';
import { prisma } from '../../../lib/prisma';
import { ApiError } from '../../../lib/errors';
import { MailboxUnavailableError } from '../../email/mail-reader-error';
import { acquireEmailAccountLock, openAccountMailReader } from '../../email/email.service';

export const PENDING_REPAIR_ITEMS = ['pending', 'running', 'failed'];
type MailReader = Awaited<ReturnType<typeof openAccountMailReader>>;
interface RepairMail { accountId: number; uid: number }

/** 两项账单修复共用邮箱与进度生命周期；逐封业务和事务仍由原迁移承担。 */
export async function executeStatementRepairMails<Mail extends RepairMail>(
  taskId: number,
  repairMail: (item: UpgradeTaskItem, mail: Mail, reader: MailReader) => Promise<void>,
  missingAccountPayload: (mail: Mail) => Prisma.InputJsonValue,
  openReader = openAccountMailReader,
) {
  const rows = await prisma.upgradeTaskItem.findMany({ where: { taskId, status: { in: PENDING_REPAIR_ITEMS } }, orderBy: { id: 'asc' } });
  for (const accountId of new Set(rows.map(row => (row.payload as unknown as Mail).accountId))) {
    const own = rows.filter(row => (row.payload as unknown as Mail).accountId === accountId);
    let release: (() => void) | undefined;
    let reader: MailReader | undefined;
    try {
      release = acquireEmailAccountLock(accountId);
      reader = await openReader(accountId);
      for (const item of own) {
        await repairMail(item, item.payload as unknown as Mail, reader);
        await updateCounts(taskId);
      }
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      // 数据库、锁等错误由框架失败流程承接，不能误报邮箱配置故障。
      if (!(error instanceof MailboxUnavailableError) && !missing) throw error;
      const unfinished = await prisma.upgradeTaskItem.findMany({ where: { id: { in: own.map(row => row.id) }, status: { in: PENDING_REPAIR_ITEMS } } });
      for (const item of unfinished) await prisma.upgradeTaskItem.update({ where: { id: item.id }, data: {
        status: missing ? 'unchanged' : 'failed', error: missing ? null : '邮箱无法读取，请重新设置邮箱后继续', processedAt: new Date(),
        payload: missing ? missingAccountPayload(item.payload as unknown as Mail)
          : { ...item.payload as Prisma.JsonObject, failureKind: 'mailbox_unavailable' },
      } });
    } finally { await reader?.close().catch(() => undefined); release?.(); }
  }
  const counts = await updateCounts(taskId);
  return { ...counts, error: counts.failed ? '邮箱无法读取，请重新设置邮箱后继续。已完成的修改已保留。' : undefined };
}

async function updateCounts(taskId: number) {
  const groups = await prisma.upgradeTaskItem.groupBy({ by: ['status'], where: { taskId }, _count: true });
  const count = (status: string) => groups.find(group => group.status === status)?._count ?? 0;
  const result = { succeeded: count('succeeded'), unchanged: count('unchanged'), failed: count('failed') };
  await prisma.upgradeTask.update({ where: { id: taskId }, data: { ...result, processed: result.succeeded + result.unchanged + result.failed } });
  return result;
}
