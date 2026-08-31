import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';
import { APP_VERSION } from '../../version';
import { listBusinessRelationshipParsers, tryParse } from '../../parsers/registry';
import { applyParsedBills } from '../../parsers/pipeline';
import { acquireEmailAccountLock, openAccountMailReader, type MailBodyResult } from '../email/email.service';
import { recomputePrimary } from '../../lib/card-groups';

const INSTALLED_VERSION_KEY = 'installedVersion';
const CARD_RELATION_UPGRADE_KEY = 'card-business-relations-v1';
const activeTasks = new Set<number>();

export interface UpgradeTaskView {
  key: string;
  fromVersion: string | null;
  toVersion: string;
  banks: string[];
  status: string;
  total: number;
  processed: number;
  updated: number;
  missing: number;
  failed: number;
  error: string | null;
}

function taskView(task: {
  key: string;
  fromVersion: string | null;
  toVersion: string;
  banks: unknown;
  status: string;
  total: number;
  processed: number;
  updated: number;
  missing: number;
  failed: number;
  error: string | null;
}): UpgradeTaskView {
  return {
    ...task,
    banks: Array.isArray(task.banks) ? task.banks.filter((bank): bank is string => typeof bank === 'string') : [],
  };
}

/** 启动时记录版本，并为首次纳入版本管理的已安装系统建立一次历史修正任务。 */
export async function initializeUpgradeState(installed: boolean): Promise<void> {
  const interrupted = await prisma.upgradeTask.findMany({
    where: { status: 'running' },
    select: { key: true },
  });
  await prisma.upgradeTaskItem.updateMany({ where: { status: 'running' }, data: { status: 'pending' } });
  await prisma.upgradeTask.updateMany({
    where: { status: 'running' },
    data: { status: 'pending', error: null, finishedAt: null },
  });
  const resumeInterrupted = async () => {
    for (const task of interrupted) await startUpgradeTask(task.key);
  };
  if (!installed) {
    await resumeInterrupted();
    return;
  }

  const stored = await prisma.appSetting.findUnique({ where: { key: INSTALLED_VERSION_KEY } });
  if (stored?.value === APP_VERSION) {
    await resumeInterrupted();
    return;
  }

  if (!stored) {
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
    const banks = [...new Set(items.map((item) => item.bankName))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

    await prisma.$transaction(async (tx) => {
      if (items.length > 0) {
        const existing = await tx.upgradeTask.findUnique({ where: { key: CARD_RELATION_UPGRADE_KEY } });
        if (!existing) {
          const task = await tx.upgradeTask.create({
            data: {
              key: CARD_RELATION_UPGRADE_KEY,
              fromVersion: null,
              toVersion: APP_VERSION,
              banks,
              total: items.length,
            },
          });
          await tx.upgradeTaskItem.createMany({
            data: items.map((item) => ({
              taskId: task.id,
              accountId: item.accountId,
              uid: item.uid,
              bankName: item.bankName,
              parserId: item.parserId,
            })),
          });
        }
      }
      await tx.appSetting.upsert({
        where: { key: INSTALLED_VERSION_KEY },
        create: { key: INSTALLED_VERSION_KEY, value: APP_VERSION },
        update: { value: APP_VERSION },
      });
    });
    await resumeInterrupted();
    return;
  }

  await prisma.appSetting.update({ where: { key: INSTALLED_VERSION_KEY }, data: { value: APP_VERSION } });
  await resumeInterrupted();
}

export async function recordInstalledVersion(): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: INSTALLED_VERSION_KEY },
    create: { key: INSTALLED_VERSION_KEY, value: APP_VERSION },
    update: { value: APP_VERSION },
  });
}

export async function getPendingUpgradeTask(): Promise<UpgradeTaskView | null> {
  const task = await prisma.upgradeTask.findFirst({
    where: { status: { in: ['pending', 'running', 'failed'] } },
    orderBy: { createdAt: 'desc' },
  });
  return task ? taskView(task) : null;
}

export async function skipUpgradeTask(key: string): Promise<void> {
  const task = await prisma.upgradeTask.findUnique({ where: { key } });
  if (!task) throw new ApiError(404, '更新任务不存在');
  if (task.status === 'running') throw new ApiError(409, '系统正在更新历史账单');
  await prisma.upgradeTask.update({
    where: { id: task.id },
    data: { status: 'skipped', error: null, finishedAt: new Date() },
  });
}

export async function startUpgradeTask(key: string): Promise<UpgradeTaskView> {
  const task = await prisma.upgradeTask.findUnique({ where: { key } });
  if (!task) throw new ApiError(404, '更新任务不存在');
  if (task.status === 'running' || activeTasks.has(task.id)) throw new ApiError(409, '系统正在更新历史账单');
  if (task.status === 'completed' || task.status === 'skipped') return taskView(task);

  await prisma.upgradeTaskItem.updateMany({
    where: { taskId: task.id, status: 'failed' },
    data: { status: 'pending', error: null, processedAt: null },
  });
  const counts = await countItems(task.id);
  const running = await prisma.upgradeTask.update({
    where: { id: task.id },
    data: {
      status: 'running',
      processed: counts.processed,
      updated: counts.updated,
      missing: counts.missing,
      failed: 0,
      error: null,
      startedAt: task.startedAt ?? new Date(),
      finishedAt: null,
    },
  });
  activeTasks.add(task.id);
  void runUpgradeTask(task.id)
    .catch(async (error) => {
      await prisma.upgradeTask.update({
        where: { id: task.id },
        data: {
          status: 'failed',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 512),
          finishedAt: new Date(),
        },
      });
    })
    .finally(() => activeTasks.delete(task.id));
  return taskView(running);
}

async function countItems(taskId: number) {
  const groups = await prisma.upgradeTaskItem.groupBy({
    by: ['status'],
    where: { taskId },
    _count: true,
  });
  const count = (status: string) => groups.find((group) => group.status === status)?._count ?? 0;
  const updated = count('updated');
  const missing = count('missing');
  const failed = count('failed');
  return { updated, missing, failed, processed: updated + missing + failed };
}

async function updateTaskCounts(taskId: number): Promise<void> {
  const counts = await countItems(taskId);
  await prisma.upgradeTask.update({ where: { id: taskId }, data: counts });
}

async function runUpgradeTask(taskId: number): Promise<void> {
  const items = await prisma.upgradeTaskItem.findMany({
    where: { taskId, status: 'pending' },
    orderBy: [{ accountId: 'asc' }, { uid: 'asc' }],
  });
  const accountIds = [...new Set(items.map((item) => item.accountId))];

  for (const accountId of accountIds) {
    const accountItems = items.filter((item) => item.accountId === accountId);
    let release: (() => void) | null = null;
    let reader: Awaited<ReturnType<typeof openAccountMailReader>> | null = null;
    try {
      release = acquireEmailAccountLock(accountId);
      reader = await openAccountMailReader(accountId);
      for (const item of accountItems) await processUpgradeItem(item, reader.fetch);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 512);
      await prisma.upgradeTaskItem.updateMany({
        where: { id: { in: accountItems.map((item) => item.id) }, status: 'pending' },
        data: { status: 'failed', error: message, processedAt: new Date() },
      });
      await updateTaskCounts(taskId);
    } finally {
      await reader?.close().catch(() => undefined);
      release?.();
    }
  }

  const counts = await countItems(taskId);
  const status = counts.failed > 0 ? 'failed' : 'completed';
  await prisma.upgradeTask.update({
    where: { id: taskId },
    data: {
      ...counts,
      status,
      error: counts.failed > 0 ? '部分历史账单更新失败，请重试' : null,
      finishedAt: new Date(),
    },
  });
  if (status === 'completed') await cleanupSafeOrphans(taskId);
  await recomputePrimary();
}

async function processUpgradeItem(item: {
  id: number;
  taskId: number;
  accountId: number;
  uid: number;
  parserId: string;
}, fetchBody: (uid: number) => Promise<MailBodyResult>): Promise<void> {
  await prisma.upgradeTaskItem.update({ where: { id: item.id }, data: { status: 'running', error: null } });
  try {
    const log = await prisma.mailLog.findUnique({
      where: { accountId_uid: { accountId: item.accountId, uid: item.uid } },
      select: { id: true },
    });
    if (!log) {
      await markItem(item, 'missing');
      return;
    }
    const body = await fetchBody(item.uid);
    const result = tryParse({
      from: body.from,
      subject: body.subject,
      date: new Date(body.date),
      text: body.text ?? undefined,
      html: body.html ?? undefined,
      pdfText: body.pdfText ?? undefined,
      attachText: body.attachText ?? undefined,
    }, item.parserId);
    if (!result.matched || result.bills.length === 0) {
      throw new Error(result.matched ? result.error ?? '账单内容无法识别' : result.reason);
    }
    await applyParsedBills(log.id, result.parserId, result.bills);
    await markItem(item, 'updated');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      await markItem(item, 'missing');
      return;
    }
    await markItem(item, 'failed', error instanceof Error ? error.message : String(error));
  }
}

async function markItem(
  item: { id: number; taskId: number },
  status: 'updated' | 'missing' | 'failed',
  error?: string,
): Promise<void> {
  await prisma.upgradeTaskItem.update({
    where: { id: item.id },
    data: { status, error: error?.slice(0, 512) ?? null, processedAt: new Date() },
  });
  await updateTaskCounts(item.taskId);
}

/** 仅完整重解析成功的银行允许清理无引用、无用户数据的邮件自动建卡。 */
async function cleanupSafeOrphans(taskId: number): Promise<void> {
  const items = await prisma.upgradeTaskItem.findMany({ where: { taskId }, select: { bankName: true, status: true } });
  const banks = [...new Set(items.map((item) => item.bankName))];
  for (const bankName of banks) {
    if (items.some((item) => item.bankName === bankName && item.status !== 'updated')) continue;
    const cards = await prisma.card.findMany({
      where: { bankName, source: 'email' },
      include: {
        _count: { select: { bills: true, billCards: true, transactions: true, businessChildren: true, aliases: true } },
      },
    });
    for (const card of cards) {
      const referenced = Object.values(card._count).some((count) => count > 0);
      if (referenced) continue;
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
