import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { prisma } from '../../../lib/prisma';
import { ApiError } from '../../../lib/errors';
import { shanghaiMidnight } from '../../../lib/dates';
import { matchParser, tryParse } from '../../../parsers/registry';
import { applyParsedBillsInTransaction } from '../../../parsers/pipeline';
import type { ParsedBill } from '../../../parsers/types';
import { MailboxUnavailableError } from '../../email/mail-reader-error';
import type { VersionMigration } from '../migration.types';
import { emptyRepairCounts, repairStatementMail } from './statement-repair';
import { executeStatementRepairMails, PENDING_REPAIR_ITEMS } from './statement-repair-execution';

export const PAB_DETAILS_REPAIR_KEY = 'pab-details-repair-085-v1';
export const CMBC_DETAILS_REPAIR_KEY = 'cmbc-details-repair-085-v1';
export const CGB_STATEMENT_RECOVERY_KEY = 'cgb-statement-recovery-085-v1';
type RecoveryKind = 'pab-details' | 'cmbc-details' | 'cgb-statements';
interface Target { id: number; cardId: number; period: string; currency: string }
interface MailItem {
  mailLogId: number; accountId: number; uid: number; bankName: string;
  status: string; processedAt: string; parserId: string | null; billIds: number[]; targets: Target[];
}
interface Payload { anchor: string; banks: Array<{ bankName: string; mailCount: number; billCount: number }>; preserveCardRuleIds?: number[] }
const json = (value: unknown) => value as Prisma.InputJsonValue;

async function candidates(db: PrismaClient | Prisma.TransactionClient, kind: RecoveryKind, anchor: Date): Promise<MailItem[]> {
  const bankName = kind === 'pab-details' ? '平安银行' : kind === 'cmbc-details' ? '民生银行' : '广发银行';
  const where: Prisma.MailLogWhereInput = kind === 'cgb-statements'
    ? { status: 'unmatched', fromAddress: { contains: 'cgbchina.com.cn' }, bills: { none: {} } }
    : { status: 'matched', parserId: { in: kind === 'pab-details' ? ['pab2019', 'pab2026'] : ['cmbc2026'] },
      bills: { some: { source: 'email', currency: 'USD', hasDetails: false, card: { bankName } } } };
  const logs = await db.mailLog.findMany({ where: { ...where, processedAt: { lte: anchor } },
    select: { id: true, accountId: true, uid: true, fromAddress: true, subject: true, parserId: true, status: true, processedAt: true,
      bills: { select: { id: true, cardId: true, period: true, currency: true, card: { select: { bankName: true } } } } },
    orderBy: [{ accountId: 'asc' }, { uid: 'asc' }] });
  return logs.flatMap(log => {
    const match = matchParser(log.fromAddress, log.subject);
    if (kind === 'cgb-statements' && (match?.matchedBy !== 'sender' || match.parser.bankName !== '广发银行')) return [];
    return [{ mailLogId: log.id, accountId: log.accountId, uid: log.uid, bankName,
      parserId: log.parserId, status: log.status, processedAt: log.processedAt.toISOString(), billIds: log.bills.map(bill => bill.id),
      targets: log.bills.map(({ card: _card, ...bill }) => bill) }];
  });
}

function bankImpact(items: MailItem[]): Payload['banks'] {
  return [...new Set(items.map(item => item.bankName))].map(bankName => {
    const own = items.filter(item => item.bankName === bankName);
    return { bankName, mailCount: own.length, billCount: own.reduce((count, mail) => count + mail.billIds.length, 0) };
  });
}

async function inspect(db: PrismaClient | Prisma.TransactionClient, kind: RecoveryKind) {
  const anchor = new Date();
  const items = await candidates(db, kind, anchor);
  return items.length ? { total: items.length, payload: json({ anchor: anchor.toISOString(), banks: bankImpact(items) }) } : null;
}

async function prepare(taskId: number, kind: RecoveryKind) {
  const task = await prisma.upgradeTask.findUniqueOrThrow({ where: { id: taskId } });
  if (await prisma.upgradeTaskItem.count({ where: { taskId } })) return;
  const payload = task.payload as unknown as Payload;
  const items = await candidates(prisma, kind, new Date(payload.anchor));
  const existingCards = kind === 'cgb-statements'
    ? await prisma.card.findMany({ where: { bankName: '广发银行' }, select: { id: true } }) : [];
  await prisma.$transaction(async tx => {
    if (items.length) await tx.upgradeTaskItem.createMany({ data: items.map(mail => ({ taskId,
      itemKey: `mail:${mail.accountId}:${mail.uid}`, payload: json(mail) })), skipDuplicates: true });
    await tx.upgradeTask.update({ where: { id: taskId }, data: { total: items.length,
      payload: json({ ...payload, banks: bankImpact(items), preserveCardRuleIds: existingCards.map(card => card.id) }) } });
  });
}

/** 每封来源的账单变化与任务完成标记在同一事务提交。 */
export async function repairBankStatementMail(
  tx: Prisma.TransactionClient, kind: RecoveryKind, mail: MailItem, parsed: ParsedBill[], parserId: string,
  preserveCardRuleIds: number[] = [],
) {
  const counts = emptyRepairCounts();
  const log = await tx.mailLog.findUnique({ where: { id: mail.mailLogId }, include: {
    bills: { include: { card: true, transactions: true } },
  } });
  if (!log || log.accountId !== mail.accountId || log.uid !== mail.uid || log.status !== mail.status
    || log.parserId !== mail.parserId || log.processedAt.toISOString() !== mail.processedAt) {
    return { ...counts, reason: '来源邮件已变更，本次跳过' };
  }
  const old = log.bills;
  if (old.length !== mail.targets.length || old.some(bill => !mail.targets.some(target => target.id === bill.id
    && target.cardId === bill.cardId && target.period === bill.period && target.currency === bill.currency))) {
    return { ...counts, reason: '账单已删除或归属已变更，本次跳过' };
  }
  if (kind === 'cgb-statements') {
    const existing = await tx.bill.findMany({ where: { card: { bankName: '广发银行' }, period: { in: parsed.map(bill => bill.period) } }, include: { card: true } });
    const fresh = parsed.filter(bill => !existing.some(row => row.card.cardLast4 === bill.cardLast4
      && row.period === bill.period && row.currency === bill.currency));
    if (fresh.length) {
      // 失败续跑期间可能已经同步了新卡的新账单，旧邮件也不能覆盖它们的当前规则。
      const newerCards = await tx.card.findMany({ where: { bankName: '广发银行',
        bills: { some: { statementDate: { gt: fresh[0]!.statementDate } } } }, select: { id: true } });
      const protectedRules = new Set([...preserveCardRuleIds, ...newerCards.map(card => card.id)]);
      const ids = await applyParsedBillsInTransaction(tx, mail.mailLogId, parserId, fresh, protectedRules);
      counts.addedBills = new Set(ids).size;
      counts.addedTransactions = await tx.billTransaction.count({ where: { billId: { in: ids } } });
    }
  } else {
    // 仅修复原文可完整对应的现有账单，金额和还款决定不受明细修复影响。
    const sameSummary = old.every(bill => {
      const matches = parsed.filter(row => row.bankName === bill.card.bankName && row.period === bill.period && row.currency === bill.currency);
      const fresh = matches[0];
      return bill.source === 'email' && matches.length === 1 && fresh!.statementDate.getTime() === bill.statementDate.getTime()
        && fresh!.dueDate.getTime() === bill.dueDate.getTime() && fresh!.amount === Number(bill.amount)
        && (fresh!.minAmount ?? null) === (bill.minAmount == null ? null : Number(bill.minAmount));
    });
    if (!sameSummary) return { ...counts, unavailableMails: 1, reason: '原文摘要无法完整对应现有账单，本次跳过' };
    const ownCurrencies = new Set(old.map(bill => bill.currency));
    const fresh = parsed.filter(bill => ownCurrencies.has(bill.currency));
    if (!fresh.some(bill => bill.currency === 'USD' && bill.transactions?.length)) return counts;
    // 同期新来源已有目标卡账单时，保留该来源，避免改挂造成唯一键冲突。
    for (const bill of fresh) {
      const conflict = await tx.bill.findFirst({ where: { card: { bankName: bill.bankName, cardLast4: bill.cardLast4 },
        period: bill.period, currency: bill.currency, id: { notIn: mail.billIds } } });
      if (conflict) return { ...counts, reason: '同一账期已有其他来源账单，本次跳过' };
    }
    const result = await repairStatementMail(tx, { mailLogId: mail.mailLogId, billIds: mail.billIds,
      parserId, parsed: fresh, lowerBound: shanghaiMidnight(new Date()), preserveRepayments: true });
    Object.assign(counts, result);
    // 民生的错误人民币行迁入美元账户，合并计为币种修正，避免同时显示新增和移除。
    if (mail.bankName === '民生银行') {
      const available = old.filter(bill => bill.currency === 'CNY').flatMap(bill => bill.transactions);
      let moved = 0;
      for (const row of fresh.filter(bill => bill.currency === 'USD').flatMap(bill => bill.transactions ?? [])) {
        const index = available.findIndex(previous => previous.dateText === row.date
          && previous.description.replace(/\s+/g, ' ').trim() === row.description.replace(/\s+/g, ' ').trim()
          && Number(previous.amount) === row.amount);
        if (index >= 0) { available.splice(index, 1); moved++; }
      }
      const corrected = Math.min(moved, counts.addedTransactions, counts.removedTransactions);
      counts.addedTransactions -= corrected;
      counts.removedTransactions -= corrected;
      counts.correctedTransactions += corrected;
    }
  }
  await tx.mailLog.update({ where: { id: mail.mailLogId }, data: { status: 'matched', parserId, error: null, processedAt: new Date() } });
  return counts;
}

async function execute(taskId: number, kind: RecoveryKind) {
  const task = await prisma.upgradeTask.findUniqueOrThrow({ where: { id: taskId } });
  const payload = task.payload as unknown as Payload;
  return executeStatementRepairMails<MailItem>(taskId, async (item, mail, reader) => {
    let bills: ParsedBill[] = [];
    let parserId = '';
    let reason: string | undefined;
    try {
      const body = await reader.fetch(mail.uid);
      const parsed = tryParse({ ...body, date: new Date(body.date), text: body.text ?? undefined,
        html: body.html ?? undefined, pdfText: body.pdfText ?? undefined, attachText: body.attachText ?? undefined });
      if (!parsed.matched || !parsed.bills.length || parsed.bills.some(bill => bill.bankName !== mail.bankName)) reason = '原文无法完整解析';
      else { bills = parsed.bills; parserId = parsed.parserId; }
    } catch (error) {
      if (error instanceof MailboxUnavailableError) throw error;
      reason = error instanceof ApiError && error.status === 404 ? '来源邮件已删除或原文为空' : '单封邮件无法完整读取';
    }
    await prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT `id` FROM `UpgradeTaskItem` WHERE `id` = ? FOR UPDATE', item.id);
      const current = await tx.upgradeTaskItem.findUniqueOrThrow({ where: { id: item.id } });
      if (!PENDING_REPAIR_ITEMS.includes(current.status)) return;
      await tx.$queryRawUnsafe('SELECT `id` FROM `MailLog` WHERE `id` = ? FOR UPDATE', mail.mailLogId);
      const result = reason ? { ...emptyRepairCounts(), unavailableMails: 1, reason }
        : await repairBankStatementMail(tx, kind, mail, bills, parserId, payload.preserveCardRuleIds);
      const incompleteReason = 'reason' in result ? result.reason : undefined;
      await tx.upgradeTaskItem.update({ where: { id: item.id }, data: {
        status: result.addedBills || result.correctedBills ? 'succeeded' : 'unchanged', processedAt: new Date(), error: null,
        payload: json({ ...mail, result, ...(incompleteReason ? { incompleteReason } : {}) }),
      } });
    }, { isolationLevel: 'Serializable', timeout: 30000 });
  }, mail => json({ ...mail, result: { ...emptyRepairCounts(), unavailableMails: 1 }, incompleteReason: '邮箱已解绑' }));
}

const describeImpact: NonNullable<VersionMigration['describeImpact']> = ({ payload }) => {
  const banks = (payload as Payload)?.banks;
  return banks?.length ? `需要复核 ${banks.map(bank => `${bank.bankName} ${bank.mailCount} 封邮件`).join('、')}，实际修复数量以原文核对结果为准。` : null;
};

export const pabDetails085Migration: VersionMigration = {
  key: PAB_DETAILS_REPAIR_KEY, targetVersion: '0.8.5', order: 10, mode: 'optional',
  title: '补齐平安美元明细',
  description: '重新读取平安现有美元账单的来源邮件，补齐遗漏的美元交易及原币金额。保留已有还款记录。',
  executeLabel: '现在执行', ignoreLabel: '忽略迁移',
  ignoreWarning: '忽略后，平安历史美元明细的遗漏会保留。新邮件按新版规则解析。系统将不再提供本次迁移服务。', describeImpact,
  inspect: db => inspect(db, 'pab-details'), prepareTask: id => prepare(id, 'pab-details'), executeTask: id => execute(id, 'pab-details'),
};

export const cmbcDetails085Migration: VersionMigration = {
  key: CMBC_DETAILS_REPAIR_KEY, targetVersion: '0.8.5', order: 20, mode: 'optional',
  title: '修正民生美元明细',
  description: '重新读取民生现有美元账单的来源邮件，将错记为人民币的美元交易归回美元账户，并补齐原币金额和币种。保留已有还款记录。',
  executeLabel: '现在执行', ignoreLabel: '忽略迁移',
  ignoreWarning: '忽略后，民生历史美元明细的币种错误及原币信息遗漏会保留。新邮件按新版规则解析。系统将不再提供本次迁移服务。', describeImpact,
  inspect: db => inspect(db, 'cmbc-details'), prepareTask: id => prepare(id, 'cmbc-details'), executeTask: id => execute(id, 'cmbc-details'),
};

export const cgbStatements085Migration: VersionMigration = {
  key: CGB_STATEMENT_RECOVERY_KEY, targetVersion: '0.8.5', order: 30, mode: 'optional',
  title: '补录广发历史账单',
  description: '重新读取已记录为未匹配的广发账单邮件，补录促销式标题下遗漏的账单和明细。同卡、同账期、同币种已经存在的账单会保留。',
  executeLabel: '现在执行', ignoreLabel: '忽略迁移',
  ignoreWarning: '忽略后，这批历史广发账单将继续缺失。新邮件按新版标题规则识别。系统将不再提供本次迁移服务。', describeImpact,
  inspect: db => inspect(db, 'cgb-statements'), prepareTask: id => prepare(id, 'cgb-statements'), executeTask: id => execute(id, 'cgb-statements'),
};
