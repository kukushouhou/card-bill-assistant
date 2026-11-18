import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { prisma } from '../../../lib/prisma';
import { ApiError } from '../../../lib/errors';
import { shanghaiMidnight } from '../../../lib/dates';
import { tryParse } from '../../../parsers/registry';
import type { ParsedBill } from '../../../parsers/types';
import { MailboxUnavailableError } from '../../email/mail-reader-error';
import type { VersionMigration } from '../migration.types';
import { emptyRepairCounts, repairStatementMail } from './statement-repair';
import { executeStatementRepairMails, PENDING_REPAIR_ITEMS } from './statement-repair-execution';

export const ABC_STATEMENT_REPAIR_KEY = 'abc-statement-repair-084-v1';
interface Target { id: number; cardId: number; cardLast4: string; period: string; currency: string }
interface MailItem {
  mailLogId: number; accountId: number; uid: number; bankName: string; parserId: string;
  status: string; processedAt: string; billIds: number[]; targets: Target[];
}
interface Payload {
  anchor: string;
  banks: Array<{ bankName: string; billCount: number; mailCount: number }>;
}
const json = (value: unknown) => value as Prisma.InputJsonValue;

async function candidates(db: PrismaClient | Prisma.TransactionClient, anchor: Date): Promise<MailItem[]> {
  const logs = await db.mailLog.findMany({ where: {
    processedAt: { lte: anchor },
    OR: [
      { status: 'error', parserId: { in: ['abc2026', 'abc2019'] } },
      { status: 'matched', parserId: 'abc2026', bills: { some: { source: 'email', card: { bankName: '农业银行' } } } },
    ],
  }, select: { id: true, accountId: true, uid: true, parserId: true, status: true, processedAt: true,
    bills: { select: { id: true, cardId: true, period: true, currency: true, card: { select: { cardLast4: true } } } } },
  orderBy: [{ accountId: 'asc' }, { uid: 'asc' }] });
  return logs.map(log => ({ mailLogId: log.id, accountId: log.accountId, uid: log.uid, parserId: log.parserId!,
    bankName: '农业银行', status: log.status, processedAt: log.processedAt.toISOString(),
    billIds: log.bills.map(bill => bill.id),
    targets: log.bills.map(({ card, ...bill }) => ({ ...bill, cardLast4: card.cardLast4 })) }));
}

function banks(items: MailItem[]): Payload['banks'] {
  return items.length ? [{ bankName: '农业银行', mailCount: items.length,
    billCount: items.reduce((count, mail) => count + mail.billIds.length, 0) }] : [];
}

/** 只在持有任务项和来源邮件锁的事务内恢复，保留用户已作出的还款、删除和重拉决定。 */
export async function repairAbcStatementMail(tx: Prisma.TransactionClient, mail: MailItem, parsed: ParsedBill[], parserId: string) {
  const counts = emptyRepairCounts();
  const log = await tx.mailLog.findUnique({ where: { id: mail.mailLogId }, include: {
    bills: { include: { card: true } },
  } });
  if (!log || log.accountId !== mail.accountId || log.uid !== mail.uid || log.status !== mail.status
    || log.parserId !== mail.parserId || log.processedAt.toISOString() !== mail.processedAt) {
    return { ...counts, reason: '来源邮件已变更，本次跳过' };
  }
  const existing = log.bills;
  if (existing.length !== mail.targets.length || existing.some(bill => !mail.targets.some(target => target.id === bill.id
    && target.cardId === bill.cardId && target.cardLast4 === bill.card.cardLast4
    && target.period === bill.period && target.currency === bill.currency))) {
    return { ...counts, reason: '账单已删除或归属已变更，本次跳过' };
  }
  if (existing.some(bill => bill.source !== 'email' || !parsed.some(fresh => fresh.bankName === bill.card.bankName
    && fresh.cardLast4 === bill.card.cardLast4 && fresh.period === bill.period && fresh.currency === bill.currency
    && fresh.statementDate.getTime() === bill.statementDate.getTime() && fresh.dueDate.getTime() === bill.dueDate.getTime()))) {
    return { ...counts, unavailableMails: 1, reason: '原文无法完整对应现有账单' };
  }
  // 已成功的旧正文只可能漏外币；已失败的整封邮件可补齐全部原文账单。
  const missingCurrencies = parsed.filter(bill => mail.status === 'error'
    || bill.currency !== 'CNY' && existing.some(old => old.card.cardLast4 === bill.cardLast4 && old.period === bill.period))
    .map(bill => bill.currency);
  const result = await repairStatementMail(tx, { mailLogId: mail.mailLogId, billIds: mail.billIds,
    parserId, parsed, lowerBound: shanghaiMidnight(new Date()), allowMissingCurrencies: missingCurrencies, preserveRepayments: true });
  await tx.mailLog.update({ where: { id: mail.mailLogId }, data: { status: 'matched', parserId, error: null, processedAt: new Date() } });
  return result;
}

export const repairAbcStatements084Migration: VersionMigration = {
  key: ABC_STATEMENT_REPAIR_KEY, targetVersion: '0.8.4', order: 10, mode: 'optional',
  title: '补齐农行历史账单',
  description: '重新读取农行解析失败的邮件和旧版已识别的常规账单，补齐遗漏的外币账单及补寄 PDF 账单，核对交易明细。已有还款记录保留，单封邮件无法读取时会记录原因并继续处理其他邮件。',
  executeLabel: '现在执行', ignoreLabel: '忽略迁移',
  ignoreWarning: '忽略后，历史遗漏的农行账单和明细会保留当前状态。此后收到的新邮件按新版规则解析。',
  describeImpact: ({ payload }) => {
    const bank = (payload as Payload)?.banks?.[0];
    return bank ? `农业银行共 ${bank.mailCount} 封历史邮件、${bank.billCount} 笔现有账单需要复核，实际补齐数量以原文读取结果为准。` : null;
  },
  async inspect(db) {
    const anchor = new Date();
    const items = await candidates(db, anchor);
    return items.length ? { total: items.length, payload: json({ anchor: anchor.toISOString(), banks: banks(items) }) } : null;
  },
  async prepareTask(taskId) {
    const task = await prisma.upgradeTask.findUniqueOrThrow({ where: { id: taskId } });
    if (await prisma.upgradeTaskItem.count({ where: { taskId } })) return;
    const payload = task.payload as unknown as Payload;
    const items = await candidates(prisma, new Date(payload.anchor));
    await prisma.$transaction(async tx => {
      if (items.length) await tx.upgradeTaskItem.createMany({ data: items.map(mail => ({ taskId,
        itemKey: `mail:${mail.accountId}:${mail.uid}`, payload: json(mail) })), skipDuplicates: true });
      await tx.upgradeTask.update({ where: { id: taskId }, data: { total: items.length,
        payload: json({ ...payload, banks: banks(items) }) } });
    });
  },
  async executeTask(taskId) {
    return executeStatementRepairMails<MailItem>(taskId, async (item, mail, reader) => {
      let bills: ParsedBill[] = [];
      let parserId = mail.parserId;
      let unavailableReason: string | undefined;
      try {
        const body = await reader.fetch(mail.uid);
        const parsed = tryParse({ ...body, date: new Date(body.date), text: body.text ?? undefined,
          html: body.html ?? undefined, pdfText: body.pdfText ?? undefined, attachText: body.attachText ?? undefined });
        if (!parsed.matched || !parsed.bills.length || parsed.bills.some(bill => bill.bankName !== '农业银行')) {
          unavailableReason = '农行原文无法完整解析';
        } else { bills = parsed.bills; parserId = parsed.parserId; }
      } catch (error) {
        if (error instanceof MailboxUnavailableError) throw error;
        unavailableReason = error instanceof ApiError && error.status === 404 ? '来源邮件已删除或原文为空' : '单封邮件无法完整读取';
      }
      await prisma.$transaction(async tx => {
        await tx.$queryRawUnsafe('SELECT `id` FROM `UpgradeTaskItem` WHERE `id` = ? FOR UPDATE', item.id);
        const current = await tx.upgradeTaskItem.findUniqueOrThrow({ where: { id: item.id } });
        if (!PENDING_REPAIR_ITEMS.includes(current.status)) return;
        await tx.$queryRawUnsafe('SELECT `id` FROM `MailLog` WHERE `id` = ? FOR UPDATE', mail.mailLogId);
        const result = unavailableReason ? { ...emptyRepairCounts(), unavailableMails: 1, reason: unavailableReason }
          : await repairAbcStatementMail(tx, mail, bills, parserId);
        const reason = 'reason' in result ? result.reason : undefined;
        await tx.upgradeTaskItem.update({ where: { id: item.id }, data: {
          status: result.addedBills || result.correctedBills ? 'succeeded' : 'unchanged', processedAt: new Date(), error: null,
          payload: json({ ...mail, result, ...(reason ? { incompleteReason: reason } : {}) }),
        } });
      });
    }, mail => json({ ...mail, result: { ...emptyRepairCounts(), unavailableMails: 1 }, incompleteReason: '邮箱已解绑' }));
  },
};
