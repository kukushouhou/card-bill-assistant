import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { prisma } from '../../../lib/prisma';
import { ApiError } from '../../../lib/errors';
import { MailboxUnavailableError } from '../../email/mail-reader-error';
import { tryParse, getParserById } from '../../../parsers/registry';
import { openAccountMailReader, type MailBodyResult } from '../../email/email.service';
import type { VersionMigration } from '../migration.types';
import { emptyRepairCounts, REPAIR_PARSERS, repairStatementMail, repaymentLowerBound } from './statement-repair';
import { executeStatementRepairMails } from './statement-repair-execution';

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
    return executeStatementRepairMails<MailItem>(taskId, async (item, mail, reader) => {
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
        // 保持0.5既有单封失败处理；公共helper只承担邮箱级生命周期。
        await prisma.upgradeTaskItem.update({ where: { id: item.id }, data: { status: 'unchanged', processedAt: new Date(),
          error: null, payload: json({ ...mail, result: { ...emptyRepairCounts(), unavailableMails: 1 },
            incompleteReason: '该邮件无法完整修复，已跳过并保留原账单和明细' }) } });
      }
    }, mail => json({ ...mail, result: { ...emptyRepairCounts(), unavailableMails: 1 },
      incompleteReason: '邮箱已解绑，已跳过并保留原账单和明细' }), accountId => retryRead(() => openAccountMailReader(accountId)));
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
