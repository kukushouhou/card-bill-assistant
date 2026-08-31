import { describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  card: { findMany: vi.fn() },
  bill: { findMany: vi.fn() },
  customReminder: { findMany: vi.fn() },
  customReminderOccurrence: { findMany: vi.fn(), createMany: vi.fn() },
}));
vi.mock('../src/lib/prisma', () => ({ prisma }));
import {
  annualFeeSchedule,
  collectCardEvents,
  collectCustomEvents,
  collectUpcoming,
  collectTodayEvents,
  computeCycle,
  type CardLike,
  type CustomReminderLike,
} from '../src/modules/reminders/reminder.engine';
import { fromYmd, today } from '../src/lib/dates';

function makeCard(overrides: Partial<CardLike> = {}): CardLike {
  return {
    id: 1,
    bankName: '招商银行',
    cardLast4: '1234',
    statementDay: 5,
    dueRule: 'offset',
    dueDay: null,
    dueOffsetDays: 18,
    remindDaysBefore: [3, 1, 0],
    status: 'active',
    ...overrides,
  };
}

function makeCustomReminder(overrides: Partial<CustomReminderLike> = {}): CustomReminderLike {
  return {
    id: 1,
    name: '房租',
    businessType: 'general',
    type: 'monthly',
    interval: 1,
    anchorDate: fromYmd('2026-08-01'),
    dayOfWeek: null,
    dayOfMonth: 10,
    monthOfYear: null,
    specificDate: null,
    daysBefore: [3, 0],
    fixedAmount: null,
    note: '',
    enabled: true,
    ...overrides,
  };
}

describe('computeCycle', () => {
  it('无账单时按 出账日+偏移天数 推算还款日', () => {
    const card = makeCard({ statementDay: 5, dueRule: 'offset', dueOffsetDays: 18 });
    const cycle = computeCycle(card, 2026, 8, null);
    expect(cycle.statementDate.toISOString()).toBe(fromYmd('2026-08-05').toISOString());
    expect(cycle.dueDate.toISOString()).toBe(fromYmd('2026-08-23').toISOString());
    expect(cycle.hasBill).toBe(false);
  });

  it('固定还款日模式：dayOfMonth 超过当月天数时取月末', () => {
    const card = makeCard({ statementDay: 31, dueRule: 'fixed', dueDay: 31 });
    const cycle = computeCycle(card, 2026, 2, null); // 2026 年 2 月共 28 天
    expect(cycle.statementDate.toISOString()).toBe(fromYmd('2026-02-28').toISOString());
    expect(cycle.dueDate.toISOString()).toBe(fromYmd('2026-02-28').toISOString());
  });

  it('固定还款日早于出账日时使用次月，12 月正确跨到下一年', () => {
    const card = makeCard({ statementDay: 19, dueRule: 'fixed', dueDay: 8, dueOffsetDays: null });
    expect(computeCycle(card, 2026, 8, null).dueDate.toISOString()).toBe(fromYmd('2026-09-08').toISOString());
    expect(computeCycle(card, 2026, 12, null).dueDate.toISOString()).toBe(fromYmd('2027-01-08').toISOString());
  });

  it('有真实账单时以账单还款日为准', () => {
    const card = makeCard({ statementDay: 5, dueRule: 'offset', dueOffsetDays: 18 });
    const bill = {
      cardId: 1,
      period: '2026-08',
      dueDate: fromYmd('2026-08-25'),
      amount: 1000,
      minAmount: 100,
      currency: 'CNY',
      paidStatus: 'unpaid',
    };
    const cycle = computeCycle(card, 2026, 8, bill);
    expect(cycle.dueDate.toISOString()).toBe(fromYmd('2026-08-25').toISOString());
    expect(cycle.hasBill).toBe(true);
  });
});

describe('collectCardEvents', () => {
  it('还款日当天提醒（无账单时提示未取得账单，不出现推算字样）', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 }); // 8月还款日 8-23
    const events = collectCardEvents(card, [], fromYmd('2026-08-23'));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('card_due');
    expect(events[0].body).toContain('今天还款日');
    expect(events[0].body).toContain('未取得账单');
    expect(events[0].body).not.toContain('推算');
    // 结构化字段：缺账单场景供前端弹窗标记
    expect(events[0]).toMatchObject({
      cardId: 1,
      bankName: '招商银行',
      cardLast4: '1234',
      period: '2026-08',
      billId: null,
      hasBill: false,
      amount: null,
      paidStatus: null,
      linkedCount: 1,
    });
  });

  it('提前 3 天提醒并带出账单金额与结构化字段', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });
    const bill = {
      id: 55,
      cardId: 1,
      period: '2026-08',
      dueDate: fromYmd('2026-08-23'),
      amount: 5432.1,
      minAmount: 543.21,
      currency: 'CNY',
      paidStatus: 'unpaid',
    };
    const events = collectCardEvents(card, [bill], fromYmd('2026-08-20'));
    expect(events).toHaveLength(1);
    expect(events[0].body).toContain('CNY ¥5,432.10');
    expect(events[0].body).toContain('543.21');
    expect(events[0].body).toContain('还有 3 天');
    expect(events[0]).toMatchObject({
      billId: 55,
      hasBill: true,
      amount: 5432.1,
      minAmount: 543.21,
      currency: 'CNY',
      paidStatus: 'unpaid',
    });
  });

  it('同一期多币种账单分别使用各自账单 ID、金额和最低还款额提醒', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });
    const events = collectCardEvents(card, [
      {
        id: 55,
        cardId: 1,
        period: '2026-08',
        dueDate: fromYmd('2026-08-23'),
        amount: 8411.9,
        minAmount: 421,
        currency: 'CNY',
        paidStatus: 'unpaid',
      },
      {
        id: 56,
        cardId: 1,
        period: '2026-08',
        dueDate: fromYmd('2026-08-23'),
        amount: 2.68,
        minAmount: 0.14,
        currency: 'USD',
        paidStatus: 'unpaid',
      },
    ], fromYmd('2026-08-20'));

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.billId)).toEqual([55, 56]);
    expect(events[0]).toMatchObject({ refId: 55, currency: 'CNY', amount: 8411.9, minAmount: 421 });
    expect(events[0].body).toContain('CNY ¥8,411.90');
    expect(events[1]).toMatchObject({ refId: 56, currency: 'USD', amount: 2.68, minAmount: 0.14 });
    expect(events[1].body).toContain('USD $2.68');
  });

  it('金额 null 的账单提示金额未取得，不显示 ¥0.00', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });
    const bill = {
      id: 56,
      cardId: 1,
      period: '2026-08',
      dueDate: fromYmd('2026-08-23'),
      amount: null,
      minAmount: null,
      currency: 'CNY',
      paidStatus: 'unpaid',
    };
    const events = collectCardEvents(card, [bill], fromYmd('2026-08-20'));
    expect(events).toHaveLength(1);
    expect(events[0].body).toContain('账单金额未取得');
    expect(events[0].body).not.toContain('0.00');
  });

  it('已还清的账单不再催还', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });
    const bill = {
      cardId: 1,
      period: '2026-08',
      dueDate: fromYmd('2026-08-23'),
      amount: 100,
      minAmount: null,
      currency: 'CNY',
      paidStatus: 'paid',
    };
    const events = collectCardEvents(card, [bill], fromYmd('2026-08-23'));
    expect(events).toHaveLength(0);
  });

  it('出账日当天发出出账提醒', () => {
    const card = makeCard({ statementDay: 5 });
    const events = collectCardEvents(card, [], fromYmd('2026-08-05'));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('card_statement');
    expect(events[0].body).toContain('今日出账');
    expect(events[0].body).not.toContain('未取得账单');
  });

  it('冻结/注销的卡不提醒', () => {
    const card = makeCard({ status: 'frozen' });
    const events = collectCardEvents(card, [], fromYmd('2026-08-23'));
    expect(events).toHaveLength(0);
  });

  it('跨月边界：上月账期在本月初到期', () => {
    // 7月账期：出账 7-05，还款 7-23；今天 8-01 时不再提醒 7 月期
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });
    const events = collectCardEvents(card, [], fromYmd('2026-08-01'));
    expect(events).toHaveLength(0);
  });

  it('合并账单：归属其他活跃卡的账单不重复提醒', () => {
    // 卡 2 关联到卡 1 的合并账单（bill.cardId=1）
    const card2 = makeCard({ id: 2, cardLast4: '6666' });
    const mergedBill = {
      id: 70,
      cardId: 1,
      period: '2026-08',
      dueDate: fromYmd('2026-08-23'),
      amount: 800,
      minAmount: null,
      currency: 'CNY',
      paidStatus: 'unpaid',
      linkedCardIds: [2],
    };
    const activeCardIds = new Set([1, 2]);
    const events = collectCardEvents(card2, [mergedBill], fromYmd('2026-08-23'), activeCardIds);
    // 副卡不重复触发主卡已覆盖的账单提醒（无账单期也不补发）
    expect(events.filter((e) => e.period === '2026-08')).toHaveLength(0);
  });

  it('业务副卡和附属卡不生成独立出账或还款提醒', () => {
    const child = makeCard({ id: 2, cardLast4: '6666', businessPrimaryId: 1 });
    expect(collectCardEvents(child, [], fromYmd('2026-08-05'))).toEqual([]);
    expect(collectCardEvents(child, [], fromYmd('2026-08-23'))).toEqual([]);
    expect(collectUpcoming([child], new Map(), [], fromYmd('2026-08-01'), 30)).toEqual([]);
  });

  it('合并账单主卡事件 linkedCount 为共享卡数', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });
    const mergedBill = {
      id: 70,
      cardId: 1,
      period: '2026-08',
      dueDate: fromYmd('2026-08-23'),
      amount: 800,
      minAmount: null,
      currency: 'CNY',
      paidStatus: 'unpaid',
      linkedCardIds: [2, 3],
    };
    const events = collectCardEvents(card, [mergedBill], fromYmd('2026-08-20'));
    expect(events[0].linkedCount).toBe(3);
  });
});

describe('annualFeeSchedule / card_fee 年费提醒', () => {
  // 出账日 5 号、offset+18：8 月期出账 8-05 还款 8-23
  const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });

  it('年费日在出账日之前 → 计入当月账期，前一期为上月', () => {
    // 年费日 2026-08-02（8月2日 ≤ 出账日 5 号）→ 计入 2026-08 期，前一期 2026-07
    const feeCard = makeCard({ statementDay: 5, dueOffsetDays: 18, annualFeeDate: fromYmd('2024-08-02') });
    const schedule = annualFeeSchedule(feeCard, [], fromYmd('2026-06-01'));
    expect(schedule).not.toBeNull();
    expect(schedule!.feePeriod).toBe('2026-08');
    expect(schedule!.prevPeriod).toBe('2026-07');
    // 7 月期无账单 → 按规则推算还款日 7-23
    expect(schedule!.prevDue.toISOString()).toBe(fromYmd('2026-07-23').toISOString());
  });

  it('年费日在出账日之后 → 计入次月账期，前一期为当月', () => {
    // 年费日 2026-08-20（20 > 5）→ 计入 2026-09 期，前一期 2026-08
    const feeCard = makeCard({ statementDay: 5, dueOffsetDays: 18, annualFeeDate: fromYmd('2024-08-20') });
    const schedule = annualFeeSchedule(feeCard, [], fromYmd('2026-06-01'));
    expect(schedule!.feePeriod).toBe('2026-09');
    expect(schedule!.prevPeriod).toBe('2026-08');
  });

  it('前一期有真实账单时以账单还款日为提醒锚点', () => {
    const feeCard = makeCard({ statementDay: 5, dueOffsetDays: 18, annualFeeDate: fromYmd('2024-08-20') });
    const prevBill = {
      id: 80,
      cardId: 1,
      period: '2026-08',
      dueDate: fromYmd('2026-08-27'),
      amount: 100,
      minAmount: null,
      currency: 'CNY',
      paidStatus: 'unpaid',
    };
    const schedule = annualFeeSchedule(feeCard, [prevBill], fromYmd('2026-06-01'));
    expect(schedule!.prevDue.toISOString()).toBe(fromYmd('2026-08-27').toISOString());
  });

  it('年费账单已出则顺延至明年', () => {
    // 年费计入 2026-09 期，该期账单已存在 → 本次不再提示，顺延 2027
    const feeCard = makeCard({ statementDay: 5, dueOffsetDays: 18, annualFeeDate: fromYmd('2024-08-20') });
    const feeBill = {
      id: 81,
      cardId: 1,
      period: '2026-09',
      dueDate: fromYmd('2026-09-23'),
      amount: 400,
      minAmount: null,
      currency: 'CNY',
      paidStatus: 'unpaid',
    };
    const schedule = annualFeeSchedule(feeCard, [feeBill], fromYmd('2026-08-01'));
    expect(schedule!.feeDate.toISOString()).toBe(fromYmd('2027-08-20').toISOString());
    expect(schedule!.feePeriod).toBe('2027-09');
  });

  it('前一期账单还款日当天触发 card_fee 事件', () => {
    // 年费日 8-20 → 计入 2026-09 期；前一期 2026-08 还款日 8-23
    const feeCard = makeCard({ statementDay: 5, dueOffsetDays: 18, annualFeeDate: fromYmd('2024-08-20') });
    const events = collectCardEvents(feeCard, [], fromYmd('2026-08-23'));
    const feeEvent = events.find((e) => e.type === 'card_fee');
    expect(feeEvent).toBeDefined();
    expect(feeEvent!.body).toContain('年费');
    expect(feeEvent!.body).toContain('2026-08-20');
    expect(feeEvent!.body).toContain('2026-09');
    expect(feeEvent!.period).toBe('2026-09');
  });

  it('非前一期还款日不触发 card_fee', () => {
    const feeCard = makeCard({ statementDay: 5, dueOffsetDays: 18, annualFeeDate: fromYmd('2024-08-20') });
    const events = collectCardEvents(feeCard, [], fromYmd('2026-08-22'));
    expect(events.filter((e) => e.type === 'card_fee')).toHaveLength(0);
  });

  it('未设置年费日的卡不产生年费事件', () => {
    const events = collectCardEvents(card, [], fromYmd('2026-08-23'));
    expect(events.filter((e) => e.type === 'card_fee')).toHaveLength(0);
  });

  it('collectUpcoming 含年费即将出账项', () => {
    const feeCard = makeCard({ statementDay: 5, dueOffsetDays: 18, annualFeeDate: fromYmd('2024-08-20') });
    const items = collectUpcoming([feeCard], new Map(), [], fromYmd('2026-08-01'), 30);
    const fee = items.find((i) => i.type === 'fee');
    expect(fee).toBeDefined();
    expect(fee!.date).toBe('2026-08-23');
    expect(fee!.title).toContain('年费');
  });
});

describe('collectCustomEvents', () => {
  const occurrence = {
    id: 9,
    reminderId: 1,
    name: '房贷月供',
    businessType: 'fixed_bill',
    targetDate: fromYmd('2026-08-15'),
    availableDate: fromYmd('2026-08-12'),
    daysBefore: [3, 0],
    note: '招行储蓄卡',
    amount: 3000,
    status: 'open',
    completedAt: null,
    suspended: false,
  };

  it('提前 N 天与当天提醒', () => {
    const early = collectCustomEvents(occurrence, fromYmd('2026-08-12'));
    expect(early).toHaveLength(1);
    expect(early[0].body).toContain('还有 3 天');

    const onDay = collectCustomEvents(occurrence, fromYmd('2026-08-15'));
    expect(onDay).toHaveLength(1);
    expect(onDay[0].body).toContain('今天');
    expect(onDay[0].body).toContain('CNY ¥3,000.00');
  });

  it('已完成、隐藏或停用后不提醒', () => {
    expect(collectCustomEvents({ ...occurrence, status: 'paid' }, fromYmd('2026-08-15'))).toHaveLength(0);
    expect(collectCustomEvents({ ...occurrence, suspended: true }, fromYmd('2026-08-15'))).toHaveLength(0);
    expect(collectCustomEvents(occurrence, fromYmd('2026-08-15'), false)).toHaveLength(0);
  });
});

describe('collectUpcoming', () => {
  it('30 天视图中包含出账日与还款日，且按日期排序', () => {
    const card = makeCard({ id: 1, statementDay: 5, dueOffsetDays: 18 });
    const card2 = makeCard({ id: 2, bankName: '建设银行', cardLast4: '5678', statementDay: 20, dueOffsetDays: 20 });
    const bills = new Map<number, Array<ReturnType<typeof Object>>>();
    const items = collectUpcoming([card, card2], bills, [], fromYmd('2026-08-10'), 30);

    const dates = items.map((i) => i.date);
    expect([...dates].sort()).toEqual(dates);
    expect(items.some((i) => i.type === 'due' && i.title.includes('1234'))).toBe(true);
    expect(items.some((i) => i.type === 'statement')).toBe(true);
    expect(items.every((i) => i.daysLeft >= 0)).toBe(true);
  });

  it('已还清的账单还款日不进入视图', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });
    const bills = new Map<number, Array<ReturnType<typeof Object>>>([
      [
        1,
        [
          {
            cardId: 1,
            period: '2026-08',
            dueDate: fromYmd('2026-08-23'),
            amount: 100,
            minAmount: null,
            currency: 'CNY',
            paidStatus: 'paid',
          },
        ],
      ],
    ]);
    const items = collectUpcoming([card], bills, [], fromYmd('2026-08-01'), 30);
    expect(items.some((i) => i.type === 'due')).toBe(false);
  });

  it('自定义提醒混排', () => {
    const card = makeCard({ statementDay: 28, dueOffsetDays: 20 });
    const customs = [makeCustomReminder()];
    const items = collectUpcoming([card], new Map(), customs, fromYmd('2026-08-01'), 30);
    expect(items.some((i) => i.type === 'custom' && i.title === '房租')).toBe(true);
  });

  it('同名同日的自定义提醒仍提供唯一稳定键', () => {
    const customs = [1, 2].map((id) => makeCustomReminder({
      id,
      name: '缴费',
      type: 'once',
      dayOfMonth: null,
      specificDate: fromYmd('2026-08-10'),
    }));
    const items = collectUpcoming([], new Map(), customs, fromYmd('2026-08-01'), 30);

    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.sourceKey)).size).toBe(items.length);
    expect(items.map((item) => item.sourceKey)).toEqual([
      'custom:1:2026-08-10',
      'custom:2:2026-08-10',
    ]);
  });

  it('今天锚点：当天到期的事项 daysLeft=0 且在视图内', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });
    const items = collectUpcoming([card], new Map(), [], fromYmd('2026-08-23'), 30);
    const due = items.find((i) => i.type === 'due');
    expect(due?.daysLeft).toBe(0);
  });
});

describe('computeCycle 与 collectCardEvents 的一致性（回归）', () => {
  it('同一卡同一账期：computeCycle 的还款日与事件触发日一致', () => {
    const card = makeCard({ statementDay: 5, dueOffsetDays: 18 });
    const cycle = computeCycle(card, 2026, 8, null);
    const events = collectCardEvents(card, [], cycle.dueDate);
    expect(events.some((e) => e.type === 'card_due')).toBe(true);
  });
});

describe('collectTodayEvents 卡片候选范围', () => {
  it('只查询正常使用且未隐藏的卡片，避免隐藏占位卡产生提醒', async () => {
    prisma.card.findMany.mockResolvedValue([]);
    prisma.bill.findMany.mockResolvedValue([]);
    prisma.customReminder.findMany.mockResolvedValue([]);
    prisma.customReminderOccurrence.findMany.mockResolvedValue([]);

    await collectTodayEvents();

    expect(prisma.card.findMany).toHaveBeenCalledWith({ where: { status: 'active', hidden: false } });
    expect(prisma.bill.findMany).toHaveBeenCalledWith({
      where: { period: { in: expect.any(Array) }, card: { hidden: false } },
      include: { cards: { select: { cardId: true } } },
    });
  });
});

// 保证 today() 锚定上海时区（防止部署环境时区漂移导致的全局回归）
describe('时区锚定', () => {
  it('today() 返回 +08:00 零点', () => {
    const t = today();
    expect(t.toISOString()).toMatch(/T16:00:00\.000Z$/); // UTC 16:00 = 次日 00:00 +08
  });
});
