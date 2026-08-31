import { describe, expect, it } from 'vitest';
import {
  buildLedger,
  buildTrend,
  computeRuleCycle,
  periodShift,
  type LedgerBillInput,
  type LedgerCard,
} from '../src/modules/bills/ledger';
import { fromYmd } from '../src/lib/dates';

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

describe('periodShift', () => {
  it('跨年与补零', () => {
    expect(periodShift('2026-01', -1)).toBe('2025-12');
    expect(periodShift('2026-12', 1)).toBe('2027-01');
    expect(periodShift('2026-08', 0)).toBe('2026-08');
  });
});

describe('computeRuleCycle 固定还款日', () => {
  it('还款日早于出账日时落在次月，并在 12 月安全跨年', () => {
    const card = makeCard({ statementDay: 19, dueRule: 'fixed', dueDay: 8, dueOffsetDays: null });
    expect(computeRuleCycle(card, 2026, 8).dueDate.toISOString()).toBe(fromYmd('2026-09-08').toISOString());
    expect(computeRuleCycle(card, 2026, 12).dueDate.toISOString()).toBe(fromYmd('2027-01-08').toISOString());
  });
});

describe('buildLedger 完整台账', () => {
  it('只为上一期已过出账日生成一期未取得账单，不补中间月', () => {
    const card = makeCard();
    // 仅 2026-06 有账单；today 2026-08-10 → 上一期已过出账日是 8-05，只补 8 月一期
    const bill = makeBill({
      period: '2026-06',
      statementDate: fromYmd('2026-06-05'),
      dueDate: fromYmd('2026-06-23'),
    });
    const rows = buildLedger([card], [card], [bill], fromYmd('2026-08-10'));
    const missing = rows.filter((r) => r.missing);
    expect(missing.map((r) => r.period)).toEqual(['2026-08']);
    expect(missing[0]).toMatchObject({
      id: null,
      amount: null,
      remainingAmount: null,
      paidStatus: null,
      source: 'missing',
      cardTails: ['1234'],
      daysOverdue: null,
    });
    expect(missing[0]!.statementDate.toISOString()).toBe(fromYmd('2026-08-05').toISOString());
    expect(missing[0]!.dueDate.toISOString()).toBe(fromYmd('2026-08-23').toISOString());
    const real = rows.find((r) => r.period === '2026-06')!;
    expect(real.id).toBe(100);
    expect(real.missing).toBe(false);
    expect(rows.some((r) => r.period === '2026-07')).toBe(false);
  });

  it('12 月 fixed 跨年占位行生成有效的下一年还款日', () => {
    const card = makeCard({ statementDay: 19, dueRule: 'fixed', dueDay: 8, dueOffsetDays: null });
    const rows = buildLedger([card], [card], [], fromYmd('2026-12-20'));
    const missing = rows.find((row) => row.missing);
    expect(missing?.period).toBe('2026-12');
    expect(missing?.dueDate.toISOString()).toBe(fromYmd('2027-01-08').toISOString());
  });

  it('当期已有真实账单则不生成占位行', () => {
    const card = makeCard();
    const bill = makeBill();
    const rows = buildLedger([card], [card], [bill], fromYmd('2026-08-10'));
    expect(rows.filter((r) => r.missing)).toHaveLength(0);
    expect(rows.find((r) => r.period === '2026-08')!.id).toBe(100);
  });

  it('同一卡同一期的不同币种账单保留为两条独立台账行', () => {
    const card = makeCard();
    const rows = buildLedger([card], [card], [
      makeBill({ id: 100, currency: 'CNY', amount: 8411.9, paidStatus: 'partial', paidAmount: 1000 }),
      makeBill({ id: 101, currency: 'USD', amount: 2.68, minAmount: 0.14, paidStatus: 'unpaid' }),
    ], fromYmd('2026-08-10'));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => ({ id: row.id, currency: row.currency, status: row.paidStatus, remaining: row.remainingAmount }))
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0)))
      .toEqual([
        { id: 100, currency: 'CNY', status: 'partial', remaining: 7411.9 },
        { id: 101, currency: 'USD', status: 'unpaid', remaining: 2.68 },
      ]);
  });

  it('部分还款返回剩余待还金额，并按最低还款额判定逾期', () => {
    const card = makeCard();
    const belowMinimum = buildLedger(
      [card],
      [card],
      [makeBill({ paidStatus: 'partial', paidAmount: 99 })],
      fromYmd('2026-08-24'),
    ).find((row) => !row.missing)!;
    expect(belowMinimum.remainingAmount).toBe(901);
    expect(belowMinimum.daysOverdue).toBe(1);

    const minimumMet = buildLedger(
      [card],
      [card],
      [makeBill({ paidStatus: 'partial', paidAmount: 100 })],
      fromYmd('2026-08-24'),
    ).find((row) => !row.missing)!;
    expect(minimumMet.remainingAmount).toBe(900);
    expect(minimumMet.daysOverdue).toBeNull();
    expect(minimumMet.paidStatus).toBe('partial');
  });

  it('出账日未到的下一期不生成占位行', () => {
    const card = makeCard(); // 出账日 5 号
    // today 8-03：8 月期出账日 8-05 未到 → 上一期为 7 月
    const rows = buildLedger([card], [card], [], fromYmd('2026-08-03'));
    expect(rows.filter((r) => r.period === '2026-08')).toHaveLength(0);
    expect(rows.filter((r) => r.missing).map((r) => r.period)).toEqual(['2026-07']);
  });

  it('过了规则还款日 30 天后不返回占位行', () => {
    // 出账日 5 号、还款日即出账日；1 月还款日 1-05，+30 天 = 2-04
    // today 2-05：上一期仍是 1 月（2 月出账日当天未过），但已过还款日 30 天
    const card = makeCard({ dueOffsetDays: 0 });
    const rows = buildLedger([card], [card], [], fromYmd('2026-02-05'));
    expect(rows.filter((r) => r.missing)).toHaveLength(0);
  });

  it('还款日次日与还款日 +30 当天仍返回占位行（严格大于才移除）', () => {
    // 出账日=还款日 1-05；出账日当天不算已过，次日才生成 1 月占位；+30 当天 2-04 仍保留
    const card = makeCard({ dueOffsetDays: 0 });
    const afterDue = buildLedger([card], [card], [], fromYmd('2026-01-06'));
    expect(afterDue.filter((r) => r.missing).map((r) => r.period)).toEqual(['2026-01']);
    expect(afterDue.find((r) => r.missing)?.daysOverdue).toBe(1);
    const onExpiry = buildLedger([card], [card], [], fromYmd('2026-02-04'));
    expect(onExpiry.filter((r) => r.missing).map((r) => r.period)).toEqual(['2026-01']);
    expect(onExpiry.find((r) => r.missing)?.daysOverdue).toBe(30);
  });

  it.each(['frozen', 'closed'])('%s 卡只保留真实账单，不生成占位行', (status) => {
    const card = makeCard({ status });
    const bill = makeBill();
    const rows = buildLedger([card], [card], [bill], fromYmd('2026-08-10'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(100);
    expect(rows[0]!.missing).toBe(false);
  });

  it('合并账单：主卡行带全部卡尾，副卡不重复占位', () => {
    const main = makeCard({ id: 1, cardLast4: '5888' });
    const second = makeCard({ id: 2, cardLast4: '6666', createdAt: fromYmd('2026-06-01') });
    const jun = makeBill({
      id: 100,
      cardId: 1,
      period: '2026-06',
      statementDate: fromYmd('2026-06-05'),
      dueDate: fromYmd('2026-06-23'),
      linkedCardIds: [1, 2],
    });
    const rows = buildLedger([main, second], [main, second], [jun], fromYmd('2026-07-10'));
    expect(rows.find((r) => r.period === '2026-06')!.cardTails).toEqual(['5888', '6666']);
    const julRows = rows.filter((r) => r.period === '2026-07');
    expect(julRows).toHaveLength(1);
    expect(julRows[0]!.cardId).toBe(1);
    expect(julRows[0]!.missing).toBe(true);
  });

  it('业务副卡和附属卡即使暂无近期账单也不生成独立占位', () => {
    const main = makeCard({ id: 1, cardLast4: '5888', businessRole: 'primary' });
    const secondary = makeCard({
      id: 2,
      cardLast4: '6666',
      businessRole: 'secondary',
      businessPrimaryId: 1,
    });
    const supplementary = makeCard({
      id: 3,
      cardLast4: '7777',
      businessRole: 'supplementary',
      businessPrimaryId: 1,
    });

    const rows = buildLedger(
      [main, secondary, supplementary],
      [main, secondary, supplementary],
      [],
      fromYmd('2026-08-10'),
    );

    expect(rows.filter((row) => row.missing).map((row) => row.cardId)).toEqual([1]);
  });

  it('未还清在前按还款日升序，历史已还在后按还款日倒序；占位行归未还清桶', () => {
    const card = makeCard();
    const unpaid = makeBill({
      id: 101,
      period: '2026-07',
      statementDate: fromYmd('2026-07-05'),
      dueDate: fromYmd('2026-07-23'),
      paidStatus: 'unpaid',
    });
    const paidLate = makeBill({
      id: 100,
      period: '2026-06',
      statementDate: fromYmd('2026-06-05'),
      dueDate: fromYmd('2026-06-23'),
      paidStatus: 'paid',
    });
    const paidRecent = makeBill({
      id: 102,
      period: '2026-05',
      statementDate: fromYmd('2026-05-05'),
      dueDate: fromYmd('2026-05-23'),
      paidStatus: 'paid',
    });
    const rows = buildLedger([card], [card], [unpaid, paidLate, paidRecent], fromYmd('2026-08-10'));
    const unpaidRows = rows.filter((r) => r.paidStatus !== 'paid');
    const paidRows = rows.filter((r) => r.paidStatus === 'paid');
    expect(unpaidRows.map((r) => r.period)).toEqual(['2026-07', '2026-08']);
    expect(unpaidRows.find((r) => r.period === '2026-08')!.missing).toBe(true);
    expect(paidRows.map((r) => r.period)).toEqual(['2026-06', '2026-05']);
    expect(rows.findIndex((r) => r.paidStatus === 'paid')).toBeGreaterThan(
      rows.findIndex((r) => r.period === '2026-08'),
    );
  });
});

describe('buildTrend 金额走势', () => {
  it('近 N 月逐月填充，无数据月 total=null', () => {
    const bill = makeBill({ period: '2026-06', amount: 500 });
    const items = buildTrend([bill], 3, fromYmd('2026-08-10'));
    expect(items).toEqual([
      { period: '2026-06', total: 500, count: 1 },
      { period: '2026-07', total: null, count: 0 },
      { period: '2026-08', total: null, count: 0 },
    ]);
  });

  it('同月多卡合计，金额 null 的账单不计入合计但计数', () => {
    const b1 = makeBill({ id: 1, period: '2026-08', amount: 100 });
    const b2 = makeBill({ id: 2, cardId: 2, period: '2026-08', amount: null });
    const items = buildTrend([b1, b2], 1, fromYmd('2026-08-10'));
    expect(items[0]).toEqual({ period: '2026-08', total: 100, count: 2 });
  });

  it('金额合计保留两位小数', () => {
    const b1 = makeBill({ id: 1, period: '2026-08', amount: 0.1 });
    const b2 = makeBill({ id: 2, cardId: 2, period: '2026-08', amount: 0.2 });
    const items = buildTrend([b1, b2], 1, fromYmd('2026-08-10'));
    expect(items[0]!.total).toBe(0.3);
  });

  it('按所选币种独立汇总走势图', () => {
    const bills = [
      makeBill({ id: 1, amount: 100, currency: 'CNY' }),
      makeBill({ id: 2, amount: 2.68, currency: 'USD' }),
    ];
    expect(buildTrend(bills, 1, fromYmd('2026-08-10'), 'CNY')[0]).toEqual({
      period: '2026-08', total: 100, count: 1,
    });
    expect(buildTrend(bills, 1, fromYmd('2026-08-10'), 'USD')[0]).toEqual({
      period: '2026-08', total: 2.68, count: 1,
    });
  });

  it('months 上限 60，下限 1', () => {
    const items = buildTrend([], 100, fromYmd('2026-08-10'));
    expect(items).toHaveLength(60);
    expect(buildTrend([], 0, fromYmd('2026-08-10'))).toHaveLength(1);
  });
});
