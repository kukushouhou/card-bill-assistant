import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { ApiError } from '../../../lib/errors';
import { prisma } from '../../../lib/prisma';
import { recomputePrimary } from '../../../lib/card-groups';
import { applyParsedBills } from '../../../parsers/pipeline';
import { listBusinessRelationshipParsers, tryParse } from '../../../parsers/registry';
import { acquireEmailAccountLock, openAccountMailReader, type MailBodyResult } from '../../email/email.service';
import type { MigrationInspection, TaskExecutionResult, VersionMigration } from '../migration.types';

interface MailTaskPayload {
  accountId: number;
  uid: number;
  bankName: string;
  parserId: string;
}

function readMailPayload(value: unknown): MailTaskPayload {
  if (!value || typeof value !== 'object') throw new Error('升级任务明细缺少邮件参数');
  const row = value as Record<string, unknown>;
  const accountId = Number(row.accountId);
  const uid = Number(row.uid);
  const bankName = typeof row.bankName === 'string' ? row.bankName : '';
  const parserId = typeof row.parserId === 'string' ? row.parserId : '';
  if (!Number.isInteger(accountId) || !Number.isInteger(uid) || !bankName || !parserId) {
    throw new Error('升级任务明细邮件参数无效');
  }
  return { accountId, uid, bankName, parserId };
}

async function inspectBusinessRelations(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<MigrationInspection | null> {
  const parsers = listBusinessRelationshipParsers();
  const byId = new Map(parsers.map((parser) => [parser.id, parser] as const));
  const logs = await db.mailLog.findMany({
    where: { parserId: { in: [...byId.keys()] }, status: 'matched' },
    select: { accountId: true, uid: true, parserId: true },
    orderBy: [{ accountId: 'asc' }, { uid: 'asc' }],
  });
  const items = logs.flatMap((log) => {
    const parser = log.parserId ? byId.get(log.parserId) : null;
    return parser ? [{ ...log, parserId: parser.id, bankName: parser.bankName }] : [];
  });
  if (items.length === 0) return null;
  const banks = [...new Set(items.map((item) => item.bankName))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return { total: items.length, payload: { banks } };
}

/** 可选迁移等待期间邮件可继续同步；真正执行前在这里补齐最新明细。 */
async function prepareBusinessTask(taskId: number): Promise<void> {
  const parsers = listBusinessRelationshipParsers();
  const byId = new Map(parsers.map((parser) => [parser.id, parser] as const));
  const logs = await prisma.mailLog.findMany({
    where: { parserId: { in: [...byId.keys()] }, status: 'matched' },
    select: { accountId: true, uid: true, parserId: true },
    orderBy: [{ accountId: 'asc' }, { uid: 'asc' }],
  });
  const items = logs.flatMap((log) => {
    const parser = log.parserId ? byId.get(log.parserId) : null;
    return parser ? [{ ...log, parserId: parser.id, bankName: parser.bankName }] : [];
  });
  const existing = await prisma.upgradeTaskItem.findMany({ where: { taskId }, select: { itemKey: true } });
  const known = new Set(existing.map((item) => item.itemKey));
  const fresh = items.filter((item) => !known.has(`mail:${item.accountId}:${item.uid}`));
  if (fresh.length > 0) {
    await prisma.upgradeTaskItem.createMany({
      data: fresh.map((item) => ({
        taskId,
        itemKey: `mail:${item.accountId}:${item.uid}`,
        payload: item,
      })),
    });
  }
  const total = await prisma.upgradeTaskItem.count({ where: { taskId } });
  await prisma.upgradeTask.update({ where: { id: taskId }, data: { total } });
}

async function itemCounts(taskId: number) {
  const groups = await prisma.upgradeTaskItem.groupBy({ by: ['status'], where: { taskId }, _count: true });
  const count = (status: string) => groups.find((group) => group.status === status)?._count ?? 0;
  const succeeded = count('succeeded');
  const unchanged = count('unchanged');
  const failed = count('failed');
  return { succeeded, unchanged, failed, processed: succeeded + unchanged + failed };
}

async function updateTaskCounts(taskId: number): Promise<void> {
  await prisma.upgradeTask.update({ where: { id: taskId }, data: await itemCounts(taskId) });
}

async function processItem(
  item: { id: number; taskId: number; payload: unknown },
  fetchBody: (uid: number) => Promise<MailBodyResult>,
): Promise<void> {
  const payload = readMailPayload(item.payload);
  await prisma.upgradeTaskItem.update({ where: { id: item.id }, data: { status: 'running', error: null } });
  try {
    const log = await prisma.mailLog.findUnique({
      where: { accountId_uid: { accountId: payload.accountId, uid: payload.uid } },
      select: { id: true },
    });
    if (!log) {
      await markItem(item, 'unchanged');
      return;
    }
    const body = await fetchBody(payload.uid);
    const result = tryParse({
      from: body.from,
      subject: body.subject,
      date: new Date(body.date),
      text: body.text ?? undefined,
      html: body.html ?? undefined,
      pdfText: body.pdfText ?? undefined,
      attachText: body.attachText ?? undefined,
    }, payload.parserId);
    if (!result.matched || result.bills.length === 0) {
      throw new Error(result.matched ? result.error ?? '账单内容无法识别' : result.reason);
    }
    await applyParsedBills(log.id, result.parserId, result.bills);
    await markItem(item, 'succeeded');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      await markItem(item, 'unchanged');
      return;
    }
    await markItem(item, 'failed', error instanceof Error ? error.message : String(error));
  }
}

async function markItem(
  item: { id: number; taskId: number },
  status: 'succeeded' | 'unchanged' | 'failed',
  error?: string,
): Promise<void> {
  await prisma.upgradeTaskItem.update({
    where: { id: item.id },
    data: { status, error: error?.slice(0, 512) ?? null, processedAt: new Date() },
  });
  await updateTaskCounts(item.taskId);
}

async function executeBusinessTask(taskId: number): Promise<TaskExecutionResult> {
  await prepareBusinessTask(taskId);
  const rows = await prisma.upgradeTaskItem.findMany({
    where: { taskId, status: { in: ['pending', 'failed'] } },
    orderBy: { itemKey: 'asc' },
  });
  const items = rows.map((row) => ({ ...row, decoded: readMailPayload(row.payload) }));
  const accountIds = [...new Set(items.map((item) => item.decoded.accountId))];

  for (const accountId of accountIds) {
    const accountItems = items.filter((item) => item.decoded.accountId === accountId);
    let release: (() => void) | null = null;
    let reader: Awaited<ReturnType<typeof openAccountMailReader>> | null = null;
    try {
      release = acquireEmailAccountLock(accountId);
      reader = await openAccountMailReader(accountId);
      for (const item of accountItems) await processItem(item, reader.fetch);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 512);
      await prisma.upgradeTaskItem.updateMany({
        where: { id: { in: accountItems.map((item) => item.id) }, status: { in: ['pending', 'running'] } },
        data: { status: 'failed', error: message, processedAt: new Date() },
      });
      await updateTaskCounts(taskId);
    } finally {
      await reader?.close().catch(() => undefined);
      release?.();
    }
  }

  const counts = await itemCounts(taskId);
  if (counts.failed === 0) await cleanupSafeOrphans(taskId);
  await recomputePrimary();
  return {
    succeeded: counts.succeeded,
    unchanged: counts.unchanged,
    failed: counts.failed,
    error: counts.failed > 0 ? '部分历史账单更新失败，请重试' : undefined,
  };
}

async function cleanupSafeOrphans(taskId: number): Promise<void> {
  const items = await prisma.upgradeTaskItem.findMany({ where: { taskId }, select: { payload: true, status: true } });
  const decoded = items.map((item) => ({ ...item, payload: readMailPayload(item.payload) }));
  const banks = [...new Set(decoded.map((item) => item.payload.bankName))];
  for (const bankName of banks) {
    if (decoded.some((item) => item.payload.bankName === bankName && item.status !== 'succeeded')) continue;
    const cards = await prisma.card.findMany({
      where: { bankName, source: 'email' },
      include: {
        _count: { select: { bills: true, billCards: true, transactions: true, businessChildren: true, aliases: true } },
      },
    });
    for (const card of cards) {
      if (Object.values(card._count).some((count) => count > 0)) continue;
      const userData = !!(
        card.nickname
        || card.cardNoFullEnc
        || card.expDateEnc
        || card.cvvEnc
        || card.annualFeeDateManual
        || card.displayLast4 !== card.cardLast4
      );
      if (userData) {
        if (!card.hidden) {
          await prisma.card.update({
            where: { id: card.id },
            data: { hidden: true, isPrimary: false, primaryManual: false },
          });
        }
      } else {
        await prisma.card.delete({ where: { id: card.id } });
      }
    }
  }
}

export const cardBusinessRelationsMigration: VersionMigration = {
  key: 'card-business-relations-v1',
  targetVersion: '0.3.1',
  order: 10,
  mode: 'optional',
  title: '更新历史账单的卡片关系',
  description: '系统可以重新识别历史账单中的主卡、副卡、附属卡和手机信用卡，减少重复账单和还款提醒。',
  executeLabel: '现在执行',
  ignoreLabel: '忽略迁移',
  inspect: inspectBusinessRelations,
  prepareTask: prepareBusinessTask,
  executeTask: executeBusinessTask,
};
