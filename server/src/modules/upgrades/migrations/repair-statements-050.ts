import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { prisma } from '../../../lib/prisma';
import { ApiError } from '../../../lib/errors';
import { MailboxUnavailableError } from '../../email/mail-reader-error';
import { tryParse, getParserById } from '../../../parsers/registry';
import { acquireEmailAccountLock, openAccountMailReader, type MailBodyResult } from '../../email/email.service';
import type { VersionMigration } from '../migration.types';
import { emptyRepairCounts, REPAIR_PARSERS, repairStatementMail, repaymentLowerBound, type RepairCounts } from './statement-repair';

export const STATEMENT_REPAIR_KEY = 'statement-parser-repair-050-v1';
interface MailItem { mailLogId: number; accountId: number; uid: number; parserId: string; bankName: string; billIds: number[] }
interface BankImpact { bankName: string; billCount: number; mailCount: number }
interface Payload { banks: BankImpact[]; anchor?: string; lowerBound?: string }
const json = (value: unknown) => value as Prisma.InputJsonValue;

async function candidates(db: PrismaClient | Prisma.TransactionClient): Promise<MailItem[]> {
  const logs = await db.mailLog.findMany({ where: { status: 'matched', parserId: { in: REPAIR_PARSERS }, bills: { some: { source: 'email' } } },
    select: { id: true, accountId: true, uid: true, parserId: true, bills: { where: { source: 'email' }, select: { id: true } } },
    orderBy: [{ accountId: 'asc' }, { uid: 'asc' }] });
  return logs.filter((log) => log.bills?.length && REPAIR_PARSERS.includes(log.parserId ?? '')).map((log) => ({ mailLogId: log.id, accountId: log.accountId, uid: log.uid, parserId: log.parserId!,
    bankName: getParserById(log.parserId!)!.bankName, billIds: log.bills.map((bill) => bill.id) }));
}
function bankImpact(items: MailItem[]): BankImpact[] {
  return [...new Set(items.map((item) => item.bankName))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((bankName) => {
    const own = items.filter((item) => item.bankName === bankName);
    return { bankName, billCount: new Set(own.flatMap((item) => item.billIds)).size, mailCount: own.length };
  });
}
function impactText(payload: unknown): string | null {
  const banks = (payload as Payload | null)?.banks;
  if (!Array.isArray(banks) || !banks.length) return null;
  return `需要复核：${banks.map((bank) => `${bank.bankName} ${bank.billCount} 笔现有账单（${bank.mailCount} 封邮件）`).join('；')}。`;
}

export const repairStatements050Migration: VersionMigration = {
  // 历史修复由用户决定，不能按“影响历史金额”把它升级为系统必需迁移。
  key: STATEMENT_REPAIR_KEY, targetVersion: '0.5.0', order: 10, mode: 'optional',
  title: '修复账单金额错误与明细遗漏',
  description: [
    '旧版解析器会误读部分账单的应还金额和最低还款额，包括把应还金额读成负数；还会漏掉部分账单和交易明细。这可能让应还账单显示为“已还清”，造成待还金额和还款提醒不准确。',
    '本次升级会修正错误金额，补齐遗漏的账单和明细。误标为已还清的账单，从修复当天往前一个月起按还款日恢复待还；手动还款记录保留。',
  ].join('\n\n'),
  executeLabel: '确认修复',
  ignoreLabel: '忽略更新',
  ignoreWarning: '忽略后，历史账单的错误金额和遗漏明细会保留；新账单仍按修复后的解析器处理。系统将不再提供本次迁移服务。',
  describeImpact: ({ payload }) => impactText(payload),
  async inspect(db) {
    const items = await candidates(db);
    return items.length ? { total: items.length, payload: json({ banks: bankImpact(items) }) } : null;
  },
  async prepareTask(taskId) {
    const task = await prisma.upgradeTask.findUniqueOrThrow({ where: { id: taskId } });
    const payload = task.payload as unknown as Payload;
    // startedAt 在任务首次执行时写入；失败重试不移动恢复窗口。
    const anchor = new Date(payload.anchor ?? task.startedAt ?? task.approvedAt ?? new Date());
    const lowerBound = payload.lowerBound ?? repaymentLowerBound(anchor).toISOString();
    if (await prisma.upgradeTaskItem.count({ where: { taskId } })) return;
    const items = await candidates(prisma);
    await prisma.$transaction(async (tx) => {
      if (items.length) await tx.upgradeTaskItem.createMany({ data: items.map((item) => ({ taskId,
        itemKey: `mail:${item.accountId}:${item.uid}`, payload: json(item) })), skipDuplicates: true });
      await tx.upgradeTask.update({ where: { id: taskId }, data: { total: items.length,
        payload: json({ banks: bankImpact(items), anchor: anchor.toISOString(), lowerBound }) } });
    });
  },
  async executeTask(taskId) {
    const task = await prisma.upgradeTask.findUniqueOrThrow({ where: { id: taskId } });
    const payload = task.payload as unknown as Payload;
    if (!payload.lowerBound) throw new Error('升级任务缺少固定的还款恢复日期');
    const rows = await prisma.upgradeTaskItem.findMany({ where: { taskId, status: { in: ['pending', 'running', 'failed'] } }, orderBy: { id: 'asc' } });
    for (const accountId of new Set(rows.map((row) => (row.payload as unknown as MailItem).accountId))) {
      const own = rows.filter((row) => (row.payload as unknown as MailItem).accountId === accountId);
      let release: (() => void) | undefined;
      let reader: Awaited<ReturnType<typeof openAccountMailReader>> | undefined;
      try {
        release = acquireEmailAccountLock(accountId);
        reader = await retryRead(() => openAccountMailReader(accountId));
        for (const item of own) {
          const mail = item.payload as unknown as MailItem;
          try {
            const body: MailBodyResult = await reader.fetch(mail.uid);
            const parsed = tryParse({ ...body, date: new Date(body.date), text: body.text ?? undefined,
              html: body.html ?? undefined, pdfText: body.pdfText ?? undefined, attachText: body.attachText ?? undefined }, mail.parserId);
            if (!parsed.matched || !parsed.bills.length) throw new Error('原文无法完整解析');
            await prisma.$transaction(async (tx) => {
              // 状态与修复写在同一事务，宕机后不会二次翻转金额。
              const current = await tx.upgradeTaskItem.findUniqueOrThrow({ where: { id: item.id } });
              if (current.status === 'succeeded' || current.status === 'unchanged') return;
              const result = await repairStatementMail(tx, { mailLogId: mail.mailLogId, billIds: mail.billIds,
                parserId: mail.parserId, parsed: parsed.bills, lowerBound: new Date(payload.lowerBound!) });
              const changed = result.correctedBills + result.addedBills + result.restoredRepayments > 0;
              await tx.upgradeTaskItem.update({ where: { id: item.id }, data: { status: changed ? 'succeeded' : 'unchanged',
                processedAt: new Date(), error: null, payload: json({ ...mail, result }) } });
            }, { timeout: 60_000 });
          } catch (error) {
            if (error instanceof MailboxUnavailableError) throw error;
            // 单封失败直接跳过，尤其不要求用户恢复已删除邮件；原账单和已完成结果保留。
            await prisma.upgradeTaskItem.update({ where: { id: item.id }, data: { status: 'unchanged', processedAt: new Date(),
              error: null, payload: json({ ...mail, result: { ...emptyRepairCounts(), unavailableMails: 1 },
                incompleteReason: '该邮件无法完整修复，已跳过并保留原账单和明细' }) } });
          }
          await updateCounts(taskId);
        }
      } catch (error) {
        const missingAccount = error instanceof ApiError && error.status === 404;
        // 数据库/锁等基础设施错误不等于邮箱配置错误，不能误引导用户修改授权码。
        if (!(error instanceof MailboxUnavailableError) && !missingAccount) throw error;
        // 连接阶段失败或运行中确认断连才需要重新配置；结构化记录对应邮箱，不靠错误文案猜测。
        const unfinished = await prisma.upgradeTaskItem.findMany({ where: { id: { in: own.map((row) => row.id) }, status: { in: ['pending', 'running', 'failed'] } } });
        for (const item of unfinished) await prisma.upgradeTaskItem.update({ where: { id: item.id }, data: {
          status: missingAccount ? 'unchanged' : 'failed', error: missingAccount ? null : '邮箱无法读取，请重新设置邮箱后继续', processedAt: new Date(),
          payload: json({ ...item.payload as unknown as MailItem, ...(missingAccount
            ? { result: { ...emptyRepairCounts(), unavailableMails: 1 }, incompleteReason: '邮箱已解绑，已跳过并保留原账单和明细' }
            : { failureKind: 'mailbox_unavailable' }) }),
        } });
      } finally { await reader?.close().catch(() => undefined); release?.(); }
    }
    const counts = await updateCounts(taskId);
    return { ...counts, error: counts.failed ? '邮箱无法读取，请重新设置邮箱后继续。已完成的修改已保留。' : undefined };
  },
};

async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (error) {
      if (attempt >= 2 || error instanceof ApiError && error.status === 404) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
}
async function updateCounts(taskId: number) {
  const groups = await prisma.upgradeTaskItem.groupBy({ by: ['status'], where: { taskId }, _count: true });
  const get = (status: string) => groups.find((group) => group.status === status)?._count ?? 0;
  const counts = { succeeded: get('succeeded'), unchanged: get('unchanged'), failed: get('failed') };
  await prisma.upgradeTask.update({ where: { id: taskId }, data: { ...counts, processed: counts.succeeded + counts.unchanged + counts.failed } });
  return counts;
}

/**
 * 最近一次完成的升级计划中，历史账单修复的结果。
 * 结果只属于本次升级：最近完成的计划没有执行该修复（未含、被忽略或未完成）时返回 null，
 * 不得把历史上其他升级的修复结果兜底展示。
 */
export async function latestStatementRepairResult() {
  const plan = await prisma.upgradePlan.findFirst({
    where: { status: 'completed' },
    orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
    include: { tasks: true },
  });
  const task = plan?.tasks.find((item) => item.key === STATEMENT_REPAIR_KEY && item.status === 'completed');
  if (!task) return null;
  const counts = emptyRepairCounts();
  const incomplete: Array<{ bankName: string; billCount: number; reason: string }> = [];
  for (const item of task.items) {
    const data = item.payload as unknown as MailItem & { result?: RepairCounts; incompleteReason?: string };
    if (data.result) for (const key of Object.keys(counts) as Array<keyof RepairCounts>) counts[key] += data.result[key] ?? 0;
    if (data.incompleteReason) incomplete.push({ bankName: data.bankName, billCount: data.billIds.length, reason: data.incompleteReason });
  }
  const payload = task.payload as unknown as Payload;
  return { version: task.toVersion, finishedAt: task.finishedAt, banks: payload.banks, lowerBound: payload.lowerBound, counts, incomplete };
}
