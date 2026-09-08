import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import type { ParsedBill, ParsedTransaction } from '../../../parsers/types';
import { dayOf, dayOfMonthClamped, monthParts, shanghaiMidnight } from '../../../lib/dates';
import { detectAnnualFeeAmount, isAnnualFeeDateEvidence, normalizeCurrency } from '../../../parsers/_util';
import { inferCardRule, normalizeTransactionDate } from '../../../parsers/pipeline';
import { allCardGroups, pickPrimaryId } from '../../../lib/card-groups';

export const REPAIR_PARSERS = ['abc2019', 'abc2026', 'citic2023', 'citic2026', 'bob2026', 'cscb2026', 'hnnxs2026',
  'psbc2022', 'bocom2019', 'bocom2026', 'hxb2020', 'hxb2026', 'cib2026', 'ccb2026', 'boc2020', 'boc2026', 'ceb2016', 'ceb2017', 'cgb2026'];
export const AMOUNT_REPAIR_PARSERS = new Set(['abc2019', 'abc2026', 'citic2026', 'boc2026', 'ceb2016', 'ceb2017']);
export interface RepairCounts {
  correctedBills: number; addedBills: number; addedTransactions: number; correctedTransactions: number;
  removedTransactions: number; restoredRepayments: number; fallbackMinimumBills: number; unavailableMails: number;
}
export const emptyRepairCounts = (): RepairCounts => ({ correctedBills: 0, addedBills: 0, addedTransactions: 0,
  correctedTransactions: 0, removedTransactions: 0, restoredRepayments: 0, fallbackMinimumBills: 0, unavailableMails: 0 });

interface BillRepairEvidence {
  billId: number;
  basis: 'mail-original' | 'legacy-fields';
  before: { amount: number | null; minAmount: number | null; transactions: number } | null;
  after: { amount: number; minAmount: number | null; transactions: number };
  repaymentRestored: boolean;
}

export function repaymentLowerBound(anchor: Date): Date {
  const { year, month } = monthParts(anchor, -1);
  return dayOfMonthClamped(year, month, dayOf(anchor));
}
type PaymentSnapshot = { amount: unknown; paidAmount: unknown; paidStatus: string; paidAt: Date | null; dueDate: Date };
export function restoredPayment(row: PaymentSnapshot, amount: number, lowerBound: Date): { paidStatus: 'unpaid'; paidAt: null; paidAmount: null } | null {
  // 仅修补明细或最低还款时，应还总额未变，不撤销原还款状态。
  if (row.amount != null && Number(row.amount) === amount) return null;
  // 手工还款写入实际操作时刻；旧解析器自动结清写入还款日零点及旧账单金额。
  const automatic = row.paidStatus === 'paid' && row.paidAt?.getTime() === row.dueDate.getTime()
    && row.amount != null && row.paidAmount != null && Number(row.amount) === Number(row.paidAmount);
  return automatic && amount > 0 && row.dueDate >= lowerBound ? { paidStatus: 'unpaid', paidAt: null, paidAmount: null } : null;
}

const oldInclude = { card: true, cards: { include: { card: true } }, transactions: { orderBy: { sequence: 'asc' as const } } };
type OldBill = Prisma.BillGetPayload<{ include: typeof oldInclude }>;

/** 原文不可得时只恢复能由旧字段严格反推的数值。 */
export function fallbackStatement(row: OldBill, parserId: string): ParsedBill {
  let amount = row.amount == null ? null : Number(row.amount);
  let minAmount = row.minAmount == null ? undefined : Number(row.minAmount);
  if (parserId.startsWith('abc')) { amount = amount == null ? null : -amount; minAmount = minAmount == null ? undefined : -minAmount; }
  else if (parserId === 'citic2026') { amount = minAmount ?? null; minAmount = amount ?? undefined; }
  else if (AMOUNT_REPAIR_PARSERS.has(parserId)) throw new Error('原文不可得，无法可靠恢复账单金额');
  if (amount == null || !Number.isFinite(amount)) throw new Error('缺少能够恢复应还金额的原始字段');
  return { bankName: row.card.bankName, cardLast4: row.card.cardLast4, cardLast4s: row.cards.map((c) => c.card.cardLast4),
    amount, minAmount, currency: row.currency, statementDate: row.statementDate, dueDate: row.dueDate, period: row.period };
}

function transactionKey(row: { dateText?: string | null; description: string; amount: unknown; currency: string;
  sourceCardLast4?: string | null; cardLast4?: string | null; originalAmount?: unknown; originalCurrency?: string | null }): string {
  return JSON.stringify([row.dateText ?? '', row.description.replace(/\s+/g, ' ').trim(), Number(row.amount), row.currency,
    row.sourceCardLast4 ?? row.cardLast4 ?? '', row.originalAmount == null ? null : Number(row.originalAmount), row.originalCurrency ?? null]);
}
function transactionDifference(old: string[], fresh: string[]) {
  const counts = new Map<string, number>();
  for (const key of old) counts.set(key, (counts.get(key) ?? 0) + 1);
  let added = 0;
  for (const key of fresh) { const count = counts.get(key) ?? 0; if (count) counts.set(key, count - 1); else added++; }
  const removed = [...counts.values()].reduce((a, b) => a + b, 0);
  return { addedTransactions: Math.max(0, added - removed), removedTransactions: Math.max(0, removed - added), correctedTransactions: Math.min(added, removed) };
}

/** 单封邮件外层事务负责提交任务状态；此处不调用全量重拉、不清卡、不改手工设置。 */
export async function repairStatementMail(tx: Prisma.TransactionClient, input: {
  mailLogId: number; billIds: number[]; parserId: string; parsed: ParsedBill[] | null; lowerBound: Date;
}): Promise<RepairCounts & { evidence: BillRepairEvidence[] }> {
  const counts = { ...emptyRepairCounts(), evidence: [] as BillRepairEvidence[] };
  const old = await tx.bill.findMany({ where: { id: { in: input.billIds }, mailLogId: input.mailLogId, source: 'email' }, include: oldInclude });
  if (!old.length) return counts;
  const parsed = input.parsed ?? old.map((row) => fallbackStatement(row, input.parserId));
  if (!input.parsed) { counts.unavailableMails = 1; if (input.parserId === 'citic2026') counts.fallbackMinimumBills = old.length; }
  const used = new Set<number>();
  let sharedSequence = 0;
  const previousShared = input.parsed ? await tx.billTransaction.findMany({ where: { statementMailLogId: input.mailLogId }, orderBy: { sequence: 'asc' } }) : [];
  const sharedData: Prisma.BillTransactionCreateManyInput[] = [];
  const touched = new Set<number>(old.flatMap((bill) => [bill.cardId, ...bill.transactions.flatMap((t) => t.cardId == null ? [] : [t.cardId])]));
  for (const bill of parsed) {
    const currency = normalizeCurrency(bill.currency);
    const same = old.filter((row) => !used.has(row.id) && row.period === bill.period && row.currency === currency);
    const tails = new Set([bill.cardLast4, ...(bill.cardLast4s ?? [])]);
    const exact = same.filter((row) => tails.has(row.card.cardLast4));
    const legacyMissing = input.parserId === 'citic2023' && bill.legacyOmission === 'citic-short-tail' && exact.length === 0;
    const row = exact.length === 1 ? exact[0] : !legacyMissing && same.length === 1 ? same[0] : undefined;
    if (!row && same.length && !legacyMissing) throw new Error('修复结果无法唯一对应已有账单');
    // 原币种里已被用户删除的账单不复活；仅补本计划明确涉及的遗漏外币。
    if (!row && !legacyMissing && (currency === 'CNY' || !['boc2026', 'ceb2017'].includes(input.parserId))) continue;
    if (row) used.add(row.id);
    let owner = await tx.card.findUnique({ where: { bankName_cardLast4: { bankName: bill.bankName, cardLast4: bill.cardLast4 } } });
    if (!owner) owner = await tx.card.create({ data: { bankName: bill.bankName, cardLast4: bill.cardLast4, displayLast4: bill.cardLast4,
      holderName: bill.holderName ?? null, currency, ...inferCardRule(bill.statementDate, bill.dueDate), remindDaysBefore: [3, 1, 0], source: 'email' } });
    if (!row && await tx.bill.findUnique({ where: { cardId_period_currency: { cardId: owner.id, period: bill.period, currency } } })) continue;
    touched.add(owner.id);
    const payment = row && AMOUNT_REPAIR_PARSERS.has(input.parserId) ? restoredPayment(row, bill.amount, input.lowerBound) : null;
    if (payment) counts.restoredRepayments++;
    const memberCards = await tx.card.findMany({ where: { bankName: bill.bankName, cardLast4: { in: [...tails] } } });
    const preferred = memberCards.find((card) => card.primaryManual && card.isPrimary && card.status === 'active')
      ?? memberCards.find((card) => card.isPrimary && card.status === 'active') ?? owner;
    const fields = { cardId: owner.id, amount: bill.amount, minAmount: bill.minAmount ?? null,
      ...(input.parsed ? { annualFeeAmount: detectAnnualFeeAmount(bill.transactions?.filter((t) => !t.statementShared)), hasDetails: !!bill.transactions?.length } : {}), ...(payment ?? {}) };
    let id: number;
    let changed = false;
    if (row) {
      id = row.id;
      changed = row.cardId !== owner.id || Number(row.amount) !== bill.amount
        || (row.minAmount == null ? null : Number(row.minAmount)) !== (bill.minAmount ?? null) || !!payment;
      await tx.bill.update({ where: { id }, data: fields });
    } else {
      const paid = bill.amount <= 0 || bill.dueDate < input.lowerBound;
      const created = await tx.bill.create({ data: { ...fields, period: bill.period, currency, statementDate: shanghaiMidnight(bill.statementDate),
        dueDate: shanghaiMidnight(bill.dueDate), source: 'email', mailLogId: input.mailLogId,
        paidStatus: paid ? 'paid' : 'unpaid', paidAt: paid ? shanghaiMidnight(bill.dueDate) : null, paidAmount: paid ? bill.amount : null } });
      id = created.id; counts.addedBills++;
    }
    if (input.parsed) {
      const memberIds = [...new Set([owner.id, ...memberCards.map((card) => card.id)])];
      await tx.billCard.deleteMany({ where: { billId: id } });
      await tx.billCard.createMany({ data: memberIds.map((cardId) => ({ billId: id, cardId })) });
      const rawTails = [...new Set((bill.transactions ?? []).map((t) => t.cardLast4).filter((tail): tail is string => !!tail))];
      const cards = await tx.card.findMany({ where: { bankName: bill.bankName, cardLast4: { in: rawTails } } });
      const aliases = await tx.cardAlias.findMany({ where: { bankName: bill.bankName, cardLast4: { in: rawTails }, relationDate: { lte: bill.statementDate } }, include: { primaryCard: true } });
      const data: Prisma.BillTransactionCreateManyInput[] = (bill.transactions ?? []).map((t, sequence) => {
        if (normalizeCurrency(t.currency ?? currency) !== currency) throw new Error('修复明细币种与账单不一致');
        const alias = aliases.find((a) => a.cardLast4 === t.cardLast4);
        const card = alias?.primaryCard ?? (t.cardLast4 ? cards.find((c) => c.cardLast4 === t.cardLast4) : preferred);
        if (card) touched.add(card.id);
        const originalCurrency = t.originalCurrency ? normalizeCurrency(t.originalCurrency) : null;
        const usefulOriginal = t.originalAmount != null && originalCurrency != null
          && (originalCurrency !== currency || Math.abs(t.originalAmount) !== Math.abs(t.amount));
        return { billId: t.statementShared ? null : id, ...(t.statementShared ? { statementMailLogId: input.mailLogId } : {}),
          bankName: bill.bankName, cardId: card?.id ?? null, cardLast4: alias?.primaryCard.cardLast4 ?? t.cardLast4 ?? preferred.cardLast4,
          sourceCardLast4: t.sourceCardLast4 ?? t.cardLast4 ?? null, transactionDate: normalizeTransactionDate(t.date, bill.statementDate),
          dateText: t.date?.slice(0, 32) ?? null, description: t.description.slice(0, 512), amount: t.amount, currency,
          originalAmount: usefulOriginal ? t.originalAmount : null, originalCurrency: usefulOriginal ? originalCurrency : null,
          sequence: t.statementShared ? sharedSequence++ : sequence };
      });
      sharedData.push(...data.filter((t) => t.statementMailLogId != null));
      const ownData = data.filter((t) => t.statementMailLogId == null);
      const previous = row?.transactions ?? [];
      const diff = transactionDifference(previous.map(transactionKey), ownData.map(transactionKey));
      counts.addedTransactions += diff.addedTransactions; counts.correctedTransactions += diff.correctedTransactions; counts.removedTransactions += diff.removedTransactions;
      const differs = JSON.stringify(previous.map(transactionKey)) !== JSON.stringify(ownData.map(transactionKey))
        || previous.some((t, i) => t.cardId !== ownData[i]?.cardId);
      changed ||= differs || row?.hasDetails !== (data.length > 0);
      if (differs || !row) {
        await tx.billTransaction.deleteMany({ where: { billId: id } });
        if (ownData.length) await tx.billTransaction.createMany({ data: ownData });
      }
    }
    counts.evidence.push({ billId: id, basis: input.parsed ? 'mail-original' : 'legacy-fields',
      before: row ? { amount: row.amount == null ? null : Number(row.amount), minAmount: row.minAmount == null ? null : Number(row.minAmount),
        transactions: row.transactions.length } : null,
      after: { amount: bill.amount, minAmount: bill.minAmount ?? null,
        transactions: input.parsed ? (bill.transactions ?? []).filter((t) => !t.statementShared).length : row?.transactions.length ?? 0 },
      repaymentRestored: !!payment });
    if (row && changed) counts.correctedBills++;
  }
  if (old.some((row) => !used.has(row.id))) throw new Error('原文未能覆盖已有账单，保留原数据等待复核');
  if (input.parsed) {
    const diff = transactionDifference(previousShared.map(transactionKey), sharedData.map(transactionKey));
    counts.addedTransactions += diff.addedTransactions; counts.correctedTransactions += diff.correctedTransactions; counts.removedTransactions += diff.removedTransactions;
    await tx.billTransaction.deleteMany({ where: { statementMailLogId: input.mailLogId } });
    if (sharedData.length) {
      await tx.billTransaction.createMany({ data: sharedData });
      await tx.bill.updateMany({ where: { mailLogId: input.mailLogId, currency: { in: [...new Set(sharedData.map((row) => row.currency))] } }, data: { hasDetails: true } });
    }
  }
  await refreshDerivedCardValues(tx, [...touched]);
  return counts;
}

async function refreshDerivedCardValues(tx: Prisma.TransactionClient, ids: number[]) {
  const cards = await tx.card.findMany({ where: { id: { in: ids } } });
  const transactions = await tx.billTransaction.findMany({ where: { cardId: { in: ids }, OR: [{ billId: { not: null } }, { statementMailLogId: { not: null } }] } });
  const summaryBills = await tx.bill.findMany({ where: { cardId: { in: ids }, source: 'email', transactions: { none: {} }, amount: { gt: 0 } } });
  for (const card of cards) {
    const own = transactions.filter((row) => row.cardId === card.id);
    const priority = own.filter((row) => row.sourceCardLast4 && Number(row.amount) > 0).reduce((sum, row) => sum + Number(row.amount), 0)
      + summaryBills.filter((bill) => bill.cardId === card.id).reduce((sum, bill) => sum + Number(bill.amount), 0);
    const annual = own.filter((row) => row.transactionDate && isAnnualFeeDateEvidence({ description: row.description, amount: Number(row.amount) }))
      .sort((a, b) => b.transactionDate!.getTime() - a.transactionDate!.getTime())[0]?.transactionDate ?? null;
    await tx.card.update({ where: { id: card.id }, data: { priority: Math.round(priority * 100) / 100,
      ...(!card.annualFeeDateManual ? { annualFeeDate: annual } : {}) } });
  }
  // 仅重算受影响套卡的自动封面选择，保留手动指定标记和银行业务身份。
  const groups = await allCardGroups(tx);
  for (const members of groups.values()) {
    if (!members.some((id) => ids.includes(id))) continue;
    const group = await tx.card.findMany({ where: { id: { in: members } } });
    const active = group.filter((card) => card.status === 'active' && !card.hidden);
    const preferred = members.length < 2 ? null : active.length === 1 ? active[0]!.id : pickPrimaryId(active.map((card) => card.id), {
      primaryManualIds: active.filter((card) => card.primaryManual).map((card) => card.id),
      priorities: new Map(active.map((card) => [card.id, card.priority])),
    });
    for (const card of group) if (card.isPrimary !== (card.id === preferred)) {
      await tx.card.update({ where: { id: card.id }, data: { isPrimary: card.id === preferred } });
    }
  }
}
