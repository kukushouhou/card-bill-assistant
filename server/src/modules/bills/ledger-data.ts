import { prisma } from '../../lib/prisma';
import { buildLedger, type LedgerBillInput, type LedgerCard } from './ledger';
import { today } from '../../lib/dates';

export interface LedgerScope {
  cardId?: number;
  cardIds?: number[];
  bank?: string;
}

/** 所有新视图共用现有台账规则；这里只整理查询范围与显示资料。 */
export async function loadLedgerData(scope: LedgerScope = {}, now = today()) {
  const allCards = await prisma.card.findMany();
  const scopeCards = allCards.filter((card) => !card.hidden
    && (scope.cardId == null || card.id === scope.cardId)
    && (!scope.cardIds || scope.cardIds.includes(card.id))
    && (!scope.bank || card.bankName === scope.bank));
  const ids = scopeCards.map((card) => card.id);
  const bills = ids.length ? await prisma.bill.findMany({
    where: { OR: [{ cardId: { in: ids } }, { cards: { some: { cardId: { in: ids } } } }] },
    include: { cards: { select: { cardId: true } } },
  }) : [];
  const toCard = (card: typeof allCards[number]): LedgerCard => ({
    id: card.id, bankName: card.bankName, cardLast4: card.cardLast4,
    currency: card.currency, statementDay: card.statementDay, dueRule: card.dueRule,
    dueDay: card.dueDay, dueOffsetDays: card.dueOffsetDays, status: card.status,
    createdAt: card.createdAt, businessRole: card.businessRole, businessPrimaryId: card.businessPrimaryId,
  });
  const ledgerBills: LedgerBillInput[] = bills.map((bill) => ({
    id: bill.id, cardId: bill.cardId, period: bill.period, statementDate: bill.statementDate,
    dueDate: bill.dueDate, amount: bill.amount == null ? null : Number(bill.amount),
    minAmount: bill.minAmount == null ? null : Number(bill.minAmount), currency: bill.currency,
    paidStatus: bill.paidStatus, paidAt: bill.paidAt, paidAmount: bill.paidAmount == null ? null : Number(bill.paidAmount),
    hasDetails: bill.hasDetails, annualFeeAmount: bill.annualFeeAmount == null ? null : Number(bill.annualFeeAmount),
    source: bill.source, linkedCardIds: [...new Set([bill.cardId, ...bill.cards.map((link) => link.cardId)])],
  }));
  const cardById = new Map(allCards.map((card) => [card.id, card]));
  const billById = new Map(ledgerBills.map((bill) => [bill.id, bill]));
  const rows = buildLedger(scopeCards.map(toCard), allCards.map(toCard), ledgerBills, now).map((row) => {
    const linkedIds = row.id == null ? [row.cardId] : billById.get(row.id)?.linkedCardIds ?? [row.cardId];
    const tails = linkedIds.map((id) => cardById.get(id)).filter((card) => card != null)
      .map((card) => card.displayLast4 || card.cardLast4);
    return { ...row, cardLast4: cardById.get(row.cardId)?.displayLast4 || row.cardLast4, cardTails: tails };
  });
  return { allCards, scopeCards, bills, rows, billById };
}
