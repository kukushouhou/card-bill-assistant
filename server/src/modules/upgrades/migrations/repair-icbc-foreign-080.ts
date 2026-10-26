import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { prisma } from '../../../lib/prisma';
import { ApiError } from '../../../lib/errors';
import { MailboxUnavailableError } from '../../email/mail-reader-error';
import { tryParse } from '../../../parsers/registry';
import { icbcRepaymentRows } from '../../../parsers/banks/icbc-2026';
import { flattenHtml, mailText } from '../../../parsers/_util';
import type { MailContext, ParsedBill } from '../../../parsers/types';
import type { VersionMigration } from '../migration.types';
import { emptyRepairCounts, repaymentLowerBound } from './statement-repair';
import { executeStatementRepairMails, PENDING_REPAIR_ITEMS } from './statement-repair-execution';

export const ICBC_FOREIGN_REPAIR_KEY = 'icbc-foreign-amount-repair-080-v1';
interface Target { id: number; cardId: number; period: string; currency: string }
interface MailItem { mailLogId: number; accountId: number; uid: number; parserId: string; bankName: string; billIds: number[]; targets: Target[] }
interface Payload { banks: Array<{ bankName: string; billCount: number; mailCount: number }>; anchor?: string; lowerBound?: string;
  previewAnchor?: string; recentBillCount?: number }
export const emptyIcbcRepairCounts = () => ({ ...emptyRepairCounts(), uncertainRepayments: 0, skippedBills: 0 });
const json = (value: unknown) => value as Prisma.InputJsonValue;
async function candidates(db: PrismaClient | Prisma.TransactionClient) {
  const logs = await db.mailLog.findMany({ where: { status: 'matched', parserId: 'icbc2026',
    bills: { some: { source: 'email', currency: { not: 'CNY' }, card: { bankName: '工商银行' } } } },
    select: { id: true, accountId: true, uid: true, bills: { where: { source: 'email', currency: { not: 'CNY' }, card: { bankName: '工商银行' } },
      select: { id: true, cardId: true, period: true, currency: true, dueDate: true } } }, orderBy: [{ accountId: 'asc' }, { uid: 'asc' }] });
  return logs.filter(log => log.bills.length).map(log => ({ mailLogId: log.id, accountId: log.accountId, uid: log.uid,
    parserId: 'icbc2026', bankName: '工商银行', billIds: log.bills.map(bill => bill.id), targets: log.bills }));
}
function banks(items: MailItem[]): Payload['banks'] {
  return items.length ? [{ bankName: '工商银行', billCount: items.reduce((n, item) => n + item.billIds.length, 0), mailCount: items.length }] : [];
}

/** 只在当前事务中使用最新还款证据，不保存金额或还款快照。 */
export async function repairIcbcForeignMail(tx: Prisma.TransactionClient, mail: MailItem, parsed: ParsedBill[],
  repaymentRows: ReturnType<typeof icbcRepaymentRows>, lowerBound: Date) {
  const result = emptyIcbcRepairCounts();
  const reasons: string[] = [];
  const log = await tx.mailLog.findUnique({ where: { id: mail.mailLogId } });
  if (!log || log.accountId !== mail.accountId || log.uid !== mail.uid || log.parserId !== 'icbc2026' || log.status !== 'matched') {
    result.skippedBills = mail.billIds.length;
    return { ...result, reasons: ['来源邮件已变更，保留现有账单'] };
  }
  const current = await tx.bill.findMany({ where: { id: { in: mail.billIds } }, include: { card: true } });
  for (const target of mail.targets) {
    const row = current.find(bill => bill.id === target.id);
    if (!row || row.source !== 'email' || row.mailLogId !== mail.mailLogId || row.cardId !== target.cardId
      || row.period !== target.period || row.currency !== target.currency || row.currency === 'CNY' || row.card.bankName !== '工商银行') {
      result.skippedBills++; reasons.push('目标已删除或来源、归属已变更，未补建或覆盖'); continue;
    }
    const matches = parsed.filter(bill => bill.currency === row.currency && bill.period === row.period
      && bill.statementDate.getTime() === row.statementDate.getTime() && bill.dueDate.getTime() === row.dueDate.getTime()
      && [bill.cardLast4, ...(bill.cardLast4s ?? [])].includes(row.card.cardLast4));
    const facts = repaymentRows.filter(fact => fact.currency === row.currency);
    // 交易附着产生的零账单不是金额证据；只修本缺陷能确证的连续币种漏读。
    if (matches.length !== 1 || !facts.length) {
      result.unavailableMails = 1; result.skippedBills++;
      reasons.push(!facts.length ? '原文未明确列出该外币还款金额，保留现有账单' : '原文不能唯一对应现有外币账单，保留原状'); continue;
    }
    if (!facts.some(fact => fact.continued)) continue;
    const bill = matches[0]!;
    const amount = Math.round(facts.reduce((n, fact) => n + fact.amount, 0) * 100) / 100;
    const minimum = Math.round(facts.reduce((n, fact) => n + fact.minAmount, 0) * 100) / 100;
    if (bill.amount !== amount || bill.minAmount !== minimum) {
      result.unavailableMails = 1; result.skippedBills++; reasons.push('还款区块与解析结果不一致，保留原状'); continue;
    }
    if (Number(row.amount) === amount && (row.minAmount == null ? null : Number(row.minAmount)) === minimum) continue;
    const signature = amount > 0 && row.amount != null && Number(row.amount) === 0 && row.paidStatus === 'paid'
      && row.paidAmount != null && Number(row.paidAmount) === 0 && row.paidAt?.getTime() === row.dueDate.getTime();
    const recent = row.dueDate >= lowerBound;
    const restore = signature && recent && row.updatedAt < row.paidAt!;
    // 比较更新防止读取后出现的新还款、删除或修改被覆盖；冲突只跳过该目标。
    const changed = await tx.bill.updateMany({ where: { id: row.id, mailLogId: mail.mailLogId, source: 'email', cardId: row.cardId,
      period: row.period, currency: row.currency, updatedAt: row.updatedAt, amount: row.amount, minAmount: row.minAmount,
      paidStatus: row.paidStatus, paidAt: row.paidAt, paidAmount: row.paidAmount },
      data: { amount, minAmount: minimum, ...(restore ? { paidStatus: 'unpaid', paidAt: null, paidAmount: null } : {}) } });
    if (changed.count !== 1) { result.skippedBills++; reasons.push('账单在修复期间发生变更，保留最新操作'); continue; }
    result.correctedBills++;
    if (restore) result.restoredRepayments++;
    else if (signature && recent) { result.uncertainRepayments++; reasons.push('现有记录不足以确认自动结清来源，保留还款状态'); }
  }
  return { ...result, reasons: [...new Set(reasons)] };
}

export const repairIcbcForeign080Migration: VersionMigration = {
  key: ICBC_FOREIGN_REPAIR_KEY, targetVersion: '0.8.0', order: 10, mode: 'optional', title: '修正工行外币账单',
  description: '旧版本可能漏读工行账单的外币应还金额和最低还款额，并把零金额账单标为已还。\n金额修正：重新读取现有外币账单对应的全部历史来源邮件，修正受影响账单，纠正统计；不补建已不存在的账单。\n恢复待还与提醒：仅处理从首次执行日往前一个月起、按还款日筛选且符合自动误结清特征的账单。更早历史账单只修金额，保留还款状态。',
  executeLabel: '确认修复', ignoreLabel: '忽略更新',
  ignoreWarning: '忽略后，尚未修正的历史外币金额会继续影响统计，近期错误的已还状态也会保留；后续新邮件按修复后的规则处理。系统将不再提供本次迁移服务。',
  describeImpact: ({ payload }) => {
    const data = payload as Payload | null;
    const bank = data?.banks?.[0];
    if (!bank) return null;
    const anchor = new Date(data?.anchor ?? data?.previewAnchor ?? new Date());
    const date = (value: Date) => value.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const lower = new Date(data?.lowerBound ?? repaymentLowerBound(anchor));
    return `全部历史需复核：工商银行 ${bank.billCount} 笔外币账单／${bank.mailCount} 封邮件。\n近一个月候选恢复待还：${data?.recentBillCount ?? 0} 笔（按 ${date(anchor)} 执行，还款日从 ${date(lower)} 起）。\n以上是候选数量，实际修正和恢复以原文复核结果为准。`;
  },
  async inspect(db) {
    const items = await candidates(db);
    const anchor = new Date();
    return items.length ? { total: items.length, payload: json({ banks: banks(items), previewAnchor: anchor.toISOString(),
      recentBillCount: items.flatMap(item => item.targets).filter(target => target.dueDate >= repaymentLowerBound(anchor)).length }) } : null;
  },
  async prepareTask(taskId) {
    const task = await prisma.upgradeTask.findUniqueOrThrow({ where: { id: taskId } });
    const payload = task.payload as unknown as Payload;
    if (await prisma.upgradeTaskItem.count({ where: { taskId } })) {
      if (!payload.lowerBound) throw new Error('升级任务缺少固定的还款恢复日期');
      return;
    }
    const anchor = new Date(payload.anchor ?? task.startedAt ?? new Date());
    const items = await candidates(prisma);
    await prisma.$transaction(async tx => {
      if (items.length) await tx.upgradeTaskItem.createMany({ data: items.map(item => ({ taskId,
        itemKey: `mail:${item.accountId}:${item.uid}`, payload: json({ ...item,
          targets: item.targets.map(({ dueDate: _dueDate, ...identity }) => identity) }) })), skipDuplicates: true });
      await tx.upgradeTask.update({ where: { id: taskId }, data: { total: items.length,
        payload: json({ banks: banks(items), anchor: anchor.toISOString(), lowerBound: payload.lowerBound ?? repaymentLowerBound(anchor).toISOString(),
          recentBillCount: items.flatMap(item => item.targets).filter(target => target.dueDate >= repaymentLowerBound(anchor)).length }) } });
    });
  },
  async executeTask(taskId) {
    const task = await prisma.upgradeTask.findUniqueOrThrow({ where: { id: taskId } });
    const payload = task.payload as unknown as Payload;
    if (!payload.lowerBound) throw new Error('升级任务缺少固定的还款恢复日期');
    return executeStatementRepairMails<MailItem>(taskId, async (item, mail, reader) => {
      let bills: ParsedBill[] = [];
      let facts: ReturnType<typeof icbcRepaymentRows> = [];
      let unavailableReason: string | undefined;
      try {
        const body = await reader.fetch(mail.uid);
        const context: MailContext = { ...body, date: new Date(body.date), text: body.text ?? undefined,
          html: body.html ?? undefined, pdfText: body.pdfText ?? undefined, attachText: body.attachText ?? undefined };
        const parsed = tryParse(context, 'icbc2026');
        if (!parsed.matched || !parsed.bills.length) throw new Error('原文无法完整解析');
        bills = parsed.bills;
        facts = icbcRepaymentRows([mailText(context), flattenHtml(context.attachText ?? '')].join('\n'));
        if (!facts.length) throw new Error('原文缺少明确还款区块');
      } catch (error) {
        if (error instanceof MailboxUnavailableError) throw error;
        unavailableReason = error instanceof ApiError && error.status === 404 ? '邮件已删除或原文为空，相关账单保留原状'
          : error instanceof Error && ['原文无法完整解析', '原文缺少明确还款区块'].includes(error.message)
            ? `${error.message}，相关账单保留原状` : '单封邮件正文无法完整读取，相关账单保留原状';
      }
      // 数据库和事务错误交框架失败流程，不吞成单封原文跳过。
      await prisma.$transaction(async tx => {
        await tx.$queryRawUnsafe('SELECT `id` FROM `UpgradeTaskItem` WHERE `id` = ? FOR UPDATE', item.id);
        const latest = await tx.upgradeTaskItem.findUniqueOrThrow({ where: { id: item.id } });
        if (!PENDING_REPAIR_ITEMS.includes(latest.status)) return;
        const result = unavailableReason ? { ...emptyIcbcRepairCounts(), unavailableMails: 1, reasons: [unavailableReason] }
          : await repairIcbcForeignMail(tx, mail, bills, facts, new Date(payload.lowerBound!));
        await tx.upgradeTaskItem.update({ where: { id: item.id }, data: { status: result.correctedBills ? 'succeeded' : 'unchanged',
          processedAt: new Date(), error: null, payload: json({ ...mail, result,
            ...(result.unavailableMails ? { incompleteReason: result.reasons[0] } : {}) }) } });
      });
    }, mail => json({ ...mail, result: { ...emptyIcbcRepairCounts(), unavailableMails: 1 }, incompleteReason: '邮箱已解绑，相关账单保留原状' }));
  },
};
