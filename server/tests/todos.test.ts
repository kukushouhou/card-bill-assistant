import { describe, expect, it } from 'vitest';
import { fromYmd } from '../src/lib/dates';
import type { LedgerBillInput, LedgerCard } from '../src/modules/bills/ledger';
import { collectTodoItems } from '../src/modules/reminders/todos';

function makeCard(overrides: Partial<LedgerCard> = {}): LedgerCard {
  return {
    id: 1,
    bankName: '招商银行',
    cardLast4: '1234',
    currency: 'CNY',
    statementDay: 5,
    dueRule: 'offset',
    dueDay: null,
    dueOffsetDays: 18,
    status: 'active',
    createdAt: fromYmd('2026-01-01'),
    ...overrides,
  };
}

function makeBill(overrides: Partial<LedgerBillInput> = {}): LedgerBillInput {
  return {
    id: 100,
    cardId: 1,
    period: '2026-08',
    statementDate: fromYmd('2026-08-05'),
    dueDate: fromYmd('2026-08-23'),
    amount: 1000,
    minAmount: 100,
    currency: 'CNY',
    paidStatus: 'unpaid',
    paidAt: null,
    paidAmount: null,
    hasDetails: false,
    annualFeeAmount: null,
    source: 'email',
    linkedCardIds: [1],
    ...overrides,
  };
}

describe('collectTodoItems 今日待办', () => {
  it('纳入逾期的未取得账单，并按实际/规则还款日升序', () => {
    const missingCard = makeCard({ id: 1, cardLast4: '1111' }); // 规则还款日 8-23
    const oldRealCard = makeCard({ id: 2, cardLast4: '2222' });
    const futureRealCard = makeCard({ id: 3, cardLast4: '3333' });
    const bills = [
      makeBill({
        id: 200,
        cardId: 2,
        dueDate: fromYmd('2026-08-10'),
        linkedCardIds: [2],
      }),
      makeBill({
        id: 300,
        cardId: 3,
        dueDate: fromYmd('2026-08-25'),
        linkedCardIds: [3],
      }),
    ];

    const cards = [missingCard, oldRealCard, futureRealCard];
    const items = collectTodoItems(cards, cards, bills, fromYmd('2026-08-24'));

    expect(items.map((item) => item.dueDate.toISOString())).toEqual([
      fromYmd('2026-08-10').toISOString(),
      fromYmd('2026-08-23').toISOString(),
      fromYmd('2026-08-25').toISOString(),
    ]);
    expect(items.map((item) => item.daysOverdue)).toEqual([14, 1, null]);
    expect(items[1]).toMatchObject({
      billId: null,
      cardId: 1,
      missing: true,
      paidStatus: null,
      amount: null,
    });
  });

  it('已手动标记还清的账期不再生成占位待办', () => {
    const card = makeCard();
    const manualPaid = makeBill({
      source: 'manual',
      amount: 0,
      minAmount: null,
      paidStatus: 'paid',
      paidAt: fromYmd('2026-08-24'),
      paidAmount: 0,
    });

    expect(collectTodoItems([card], [card], [manualPaid], fromYmd('2026-08-24'))).toEqual([]);
  });

  it('到期日 +30 天当天仍显示，次日开始隐藏', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 0 });

    const onExpiry = collectTodoItems([card], [card], [], fromYmd('2026-02-04'));
    expect(onExpiry).toHaveLength(1);
    expect(onExpiry[0]).toMatchObject({ missing: true, daysOverdue: 30, period: '2026-01' });

    const afterExpiry = collectTodoItems([card], [card], [], fromYmd('2026-02-05'));
    expect(afterExpiry).toEqual([]);
  });

  it('注销卡不生成占位待办，还款日恰好为今天 +3 天的账单不进待办', () => {
    const closed = makeCard({ id: 1, status: 'closed' });
    const future = makeCard({ id: 2 });
    const futureBill = makeBill({
      id: 200,
      cardId: 2,
      dueDate: fromYmd('2026-08-27'),
      linkedCardIds: [2],
    });
    const cards = [closed, future];

    expect(collectTodoItems(cards, cards, [futureBill], fromYmd('2026-08-24'))).toEqual([]);
  });

  it('冻结卡不生成未取得账单，但保留已收到真实账单的还款待办', () => {
    const frozen = makeCard({ status: 'frozen' });
    expect(collectTodoItems([frozen], [frozen], [], fromYmd('2026-08-24'))).toEqual([]);

    const realBill = makeBill({ source: 'email' });
    const items = collectTodoItems([frozen], [frozen], [realBill], fromYmd('2026-08-24'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ billId: 100, cardId: 1, missing: false });
  });

  it('部分已还达到最低还款额时仍在待办，但不误标逾期', () => {
    const card = makeCard();
    const partial = makeBill({
      dueDate: fromYmd('2026-08-20'),
      paidStatus: 'partial',
      paidAmount: 100,
      minAmount: 100,
    });

    const items = collectTodoItems([card], [card], [partial], fromYmd('2026-08-24'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ paidStatus: 'partial', daysOverdue: null });
  });
});
