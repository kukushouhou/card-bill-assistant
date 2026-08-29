export const ANNUAL_FEE_NOTICE_CURSOR_KEY = 'annualFeeNoticeReadThrough';

const PAID_STATUSES = new Set(['partial', 'paid']);
const CURSOR_ID_WIDTH = 20;

export interface AnnualFeeNoticeCursor {
  createdAt: Date;
  billId: number;
}

export interface AnnualFeeNoticeBillLike {
  id: number;
  cardId: number;
  period: string;
  createdAt: Date;
  annualFeeAmount: unknown;
  hasDetails: boolean;
  paidStatus: string;
  currency: string;
  transactions?: Array<{
    cardId: number | null;
    cardLast4: string | null;
    bankName: string;
    description: string;
    amount: unknown;
    currency: string;
  }>;
}

export interface AnnualFeeNoticeCardLike {
  id: number;
  bankName: string;
  cardLast4: string;
  displayLast4?: string | null;
}

export interface AnnualFeeNotice {
  billCount: number;
  acknowledgeThroughBillId: number;
  items: Array<{
    billId: number;
    bankName: string;
    cardTails: string[];
    period: string;
    currency: string;
    annualFeeAmount: number;
    hasDetails: boolean;
  }>;
  banks: Array<{
    bankName: string;
    billCount: number;
    cardTails: string[];
    totalsByCurrency: Array<{ currency: string; amount: number }>;
  }>;
}

/**
 * 游标使用固定宽度的可排序字符串，数据库可以用字符串大小原子地保证只向后推进。
 * ISO 时间固定为 UTC 毫秒精度；同一毫秒内用账单 ID 打破平局。
 */
export function serializeAnnualFeeNoticeCursor(cursor: AnnualFeeNoticeCursor): string {
  return `${cursor.createdAt.toISOString()}|${String(cursor.billId).padStart(CURSOR_ID_WIDTH, '0')}`;
}

export function parseAnnualFeeNoticeCursor(value: string | null | undefined): AnnualFeeNoticeCursor | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(\d{20})$/.exec(value);
  if (!match) return null;
  const createdAt = new Date(match[1]);
  const billId = Number(match[2]);
  if (Number.isNaN(createdAt.getTime()) || !Number.isSafeInteger(billId) || billId <= 0) return null;
  return { createdAt, billId };
}

export function compareAnnualFeeNoticeCursor(a: AnnualFeeNoticeCursor, b: AnnualFeeNoticeCursor): number {
  const timeDifference = a.createdAt.getTime() - b.createdAt.getTime();
  return timeDifference === 0 ? a.billId - b.billId : timeDifference;
}

export function annualFeeBillCursor(bill: Pick<AnnualFeeNoticeBillLike, 'id' | 'createdAt'>): AnnualFeeNoticeCursor {
  return { createdAt: bill.createdAt, billId: bill.id };
}

export function isAnnualFeeNoticeUnread(
  bill: AnnualFeeNoticeBillLike,
  cursor: AnnualFeeNoticeCursor | null,
): boolean {
  const amount = bill.annualFeeAmount == null ? 0 : Number(bill.annualFeeAmount);
  if (!Number.isFinite(amount) || amount <= 0 || PAID_STATUSES.has(bill.paidStatus)) return false;
  return cursor == null || compareAnnualFeeNoticeCursor(annualFeeBillCursor(bill), cursor) > 0;
}

function displayTail(card: AnnualFeeNoticeCardLike): string {
  return card.displayLast4?.trim() || card.cardLast4;
}

function isAnnualFeeCharge(transaction: { amount: unknown; description: string }): boolean {
  const amount = Number(transaction.amount);
  return Number.isFinite(amount)
    && amount > 0
    && /年费/.test(transaction.description)
    && !/退|返|冲|免|减/.test(transaction.description);
}

function findTransactionCard(
  transaction: NonNullable<AnnualFeeNoticeBillLike['transactions']>[number],
  cards: AnnualFeeNoticeCardLike[],
  cardsById: Map<number, AnnualFeeNoticeCardLike>,
): AnnualFeeNoticeCardLike | null {
  if (transaction.cardId != null) return cardsById.get(transaction.cardId) ?? null;
  if (!transaction.cardLast4) return null;
  return cards.find((card) =>
    card.bankName === transaction.bankName
    && (card.cardLast4 === transaction.cardLast4 || displayTail(card) === transaction.cardLast4),
  ) ?? null;
}

/** 首页只持有一条聚合提醒；相同银行合并，金额按币种分开。 */
export function buildAnnualFeeNotice(
  bills: AnnualFeeNoticeBillLike[],
  cards: AnnualFeeNoticeCardLike[],
  cursor: AnnualFeeNoticeCursor | null,
): AnnualFeeNotice | null {
  const unreadBills = bills
    .filter((bill) => isAnnualFeeNoticeUnread(bill, cursor))
    .sort((a, b) => compareAnnualFeeNoticeCursor(annualFeeBillCursor(a), annualFeeBillCursor(b)));
  if (unreadBills.length === 0) return null;

  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const items: AnnualFeeNotice['items'] = [];
  const banks = new Map<string, {
    bankName: string;
    billIds: Set<number>;
    cardTails: Set<string>;
    totalsByCurrency: Map<string, number>;
  }>();

  for (const bill of unreadBills) {
    const owner = cardsById.get(bill.cardId);
    const chargeTransactions = (bill.transactions ?? []).filter(isAnnualFeeCharge);
    const charges = chargeTransactions.length > 0
      ? chargeTransactions.map((transaction) => {
          const card = findTransactionCard(transaction, cards, cardsById) ?? owner ?? null;
          return {
            bankName: card?.bankName ?? transaction.bankName ?? '未识别银行',
            cardTail: card ? displayTail(card) : transaction.cardLast4,
            amount: Number(transaction.amount),
            currency: transaction.currency,
          };
        })
      : [{
          bankName: owner?.bankName ?? '未识别银行',
          cardTail: owner ? displayTail(owner) : null,
          amount: Number(bill.annualFeeAmount),
          currency: bill.currency,
        }];

    items.push({
      billId: bill.id,
      bankName: charges[0]?.bankName ?? owner?.bankName ?? '未识别银行',
      cardTails: [...new Set(charges.map((charge) => charge.cardTail).filter((tail): tail is string => Boolean(tail)))],
      period: bill.period,
      currency: bill.currency,
      annualFeeAmount: Number(bill.annualFeeAmount),
      hasDetails: bill.hasDetails,
    });

    for (const charge of charges) {
      const bank = banks.get(charge.bankName) ?? {
        bankName: charge.bankName,
        billIds: new Set<number>(),
        cardTails: new Set<string>(),
        totalsByCurrency: new Map<string, number>(),
      };
      bank.billIds.add(bill.id);
      if (charge.cardTail) bank.cardTails.add(charge.cardTail);
      bank.totalsByCurrency.set(
        charge.currency,
        (bank.totalsByCurrency.get(charge.currency) ?? 0) + charge.amount,
      );
      banks.set(charge.bankName, bank);
    }
  }

  const through = unreadBills[unreadBills.length - 1];
  return {
    billCount: unreadBills.length,
    acknowledgeThroughBillId: through.id,
    items: items.reverse(),
    banks: [...banks.values()].map((bank) => ({
      bankName: bank.bankName,
      billCount: bank.billIds.size,
      cardTails: [...bank.cardTails],
      totalsByCurrency: [...bank.totalsByCurrency.entries()]
        .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
        .sort((a, b) => (a.currency === 'CNY' ? -1 : b.currency === 'CNY' ? 1 : a.currency.localeCompare(b.currency))),
    })),
  };
}
