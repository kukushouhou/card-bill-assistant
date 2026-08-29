import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyParsedBill,
  applyParsedBills,
  applyCurrentCycleTransactions,
  diffCardRule,
  normalizeTransactionDate,
  type CardRuleSnapshot,
} from '../src/parsers/pipeline';
import type { ParsedBill, ParsedTransaction } from '../src/parsers/types';
import { fromYmd } from '../src/lib/dates';

// mock prisma：$transaction 直接把 tx 传给回调，不落真库
const tx = vi.hoisted(() => ({
  card: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  bill: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
  billCard: { count: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), upsert: vi.fn() },
  billTransaction: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('../src/lib/prisma', () => ({
  prisma: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
}));

function makeCard(overrides: Partial<CardRuleSnapshot> = {}): CardRuleSnapshot {
  return { statementDay: 5, dueRule: 'offset', dueDay: null, dueOffsetDays: 18, ...overrides };
}

describe('diffCardRule', () => {
  it('规则与账单一致时无更新', () => {
    // 出账 8/5 + 18 天 = 8/23，与账单还款日一致
    const patch = diffCardRule(makeCard(), fromYmd('2026-08-05'), fromYmd('2026-08-23'));
    expect(patch).toBeNull();
  });

  it('还款日变化时同步偏移天数', () => {
    // 银行调整：还款日从 8/23 变为 8/25（偏移 18 → 20）
    const patch = diffCardRule(makeCard(), fromYmd('2026-08-05'), fromYmd('2026-08-25'));
    expect(patch).toEqual({ dueRule: 'offset', dueOffsetDays: 20, dueDay: null });
  });

  it('出账日变化时同步出账日', () => {
    // 出账日从 5 号变 7 号，偏移不变（7+18=25 与账单一致）
    const patch = diffCardRule(makeCard(), fromYmd('2026-08-07'), fromYmd('2026-08-25'));
    expect(patch).toEqual({ statementDay: 7 });
  });

  it('出账日与还款日同时变化时全部同步', () => {
    const patch = diffCardRule(makeCard(), fromYmd('2026-08-10'), fromYmd('2026-09-05'));
    expect(patch).toEqual({ statementDay: 10, dueRule: 'offset', dueOffsetDays: 26, dueDay: null });
  });

  it('月末截断的出账日不算变化（31 号出账的卡在 2 月落在 28 号）', () => {
    const card = makeCard({ statementDay: 31, dueOffsetDays: 20 });
    // 2/28 + 20 = 3/20，规则推算与账单一致，仅出账日被截断
    const patch = diffCardRule(card, fromYmd('2026-02-28'), fromYmd('2026-03-20'));
    expect(patch).toBeNull();
  });

  it('非截断原因的出账日前移仍会同步（31 → 28 发生在 31 天的月份）', () => {
    const card = makeCard({ statementDay: 31, dueOffsetDays: 20 });
    // 8 月有 31 天，出账 8/28 不是截断 → 银行确实改了出账日
    const patch = diffCardRule(card, fromYmd('2026-08-28'), fromYmd('2026-09-17'));
    expect(patch).toEqual({ statementDay: 28 });
  });

  it('fixed 规则：还款日推算不符时重推为 offset 规则', () => {
    const card = makeCard({ dueRule: 'fixed', dueDay: 25, dueOffsetDays: null });
    // fixed 25 号 → 推算 8/25，实际账单还款日 8/28 → 重推 offset+23
    const patch = diffCardRule(card, fromYmd('2026-08-05'), fromYmd('2026-08-28'));
    expect(patch).toEqual({ dueRule: 'offset', dueOffsetDays: 23, dueDay: null });
  });

  it('fixed 规则：还款日早于出账日属次月（每月19日出账、次月8日还款）', () => {
    const card = makeCard({ statementDay: 19, dueRule: 'fixed', dueDay: 8, dueOffsetDays: null });
    // 8/19 出账 → fixed 8 号在 8 月早于出账日，推算次月 9/8，与账单一致
    const patch = diffCardRule(card, fromYmd('2026-08-19'), fromYmd('2026-09-08'));
    expect(patch).toBeNull();
  });

  it('fixed 规则：12 月出账、次年还款不会误判规则变化', () => {
    const card = makeCard({ statementDay: 19, dueRule: 'fixed', dueDay: 8, dueOffsetDays: null });
    const patch = diffCardRule(card, fromYmd('2026-12-19'), fromYmd('2027-01-08'));
    expect(patch).toBeNull();
  });

  it('fixed 规则跨月推算不符时重推', () => {
    const card = makeCard({ statementDay: 19, dueRule: 'fixed', dueDay: 8, dueOffsetDays: null });
    // 实际还款日变为 9/10，推算 9/8 不符 → offset+22
    const patch = diffCardRule(card, fromYmd('2026-08-19'), fromYmd('2026-09-10'));
    expect(patch).toEqual({ dueRule: 'offset', dueOffsetDays: 22, dueDay: null });
  });

  it('offset 规则超 40 天时重推为 fixed 规则', () => {
    const card = makeCard({ dueOffsetDays: 18 });
    // 出账 8/5，还款 10/16（+72 天）→ fixed 每月 16 日
    const patch = diffCardRule(card, fromYmd('2026-08-05'), fromYmd('2026-10-16'));
    expect(patch).toEqual({ dueRule: 'fixed', dueOffsetDays: null, dueDay: 16 });
  });

  it('规则字段缺失（脏数据）时按账单重建', () => {
    const card = makeCard({ dueRule: 'offset', dueOffsetDays: null });
    const patch = diffCardRule(card, fromYmd('2026-08-05'), fromYmd('2026-08-23'));
    expect(patch).toEqual({ dueRule: 'offset', dueOffsetDays: 18, dueDay: null });
  });
});

describe('normalizeTransactionDate', () => {
  it('统一银行常见的完整日期、月日和紧凑日期格式', () => {
    const statementDate = fromYmd('2026-08-20');
    expect(normalizeTransactionDate('2026/08/18', statementDate)).toEqual(fromYmd('2026-08-18'));
    expect(normalizeTransactionDate('08/18', statementDate)).toEqual(fromYmd('2026-08-18'));
    expect(normalizeTransactionDate('0818', statementDate)).toEqual(fromYmd('2026-08-18'));
    expect(normalizeTransactionDate('260818', statementDate)).toEqual(fromYmd('2026-08-18'));
  });

  it('月日跨年时归入出账日前最近的一年', () => {
    const statementDate = fromYmd('2026-01-05');
    expect(normalizeTransactionDate('1231', statementDate)).toEqual(fromYmd('2025-12-31'));
    expect(normalizeTransactionDate('251231', statementDate)).toEqual(fromYmd('2025-12-31'));
  });
});

describe('applyParsedBill 明细元数据落库', () => {
  function makeBill(transactions?: ParsedTransaction[]): ParsedBill {
    return {
      bankName: '测试银行',
      cardLast4: '1234',
      amount: 100,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
      transactions,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tx.bill.upsert.mockResolvedValue({ id: 101 });
    tx.bill.findMany.mockResolvedValue([]);
    tx.bill.findUnique.mockResolvedValue(null);
    tx.bill.count.mockResolvedValue(0);
    tx.card.findMany.mockResolvedValue([]);
    // 单卡场景：BillCard 关联数与卡数一致，不触发重建
    tx.billCard.count.mockResolvedValue(1);
    tx.billTransaction.findMany.mockResolvedValue([]);
    tx.billTransaction.count.mockResolvedValue(0);
    // 已有卡档案：规则与账单一致，不触发改卡逻辑
    tx.card.findUnique.mockResolvedValue({
      id: 7,
      holderName: '张三',
      statementDay: 5,
      dueRule: 'offset',
      dueDay: null,
      dueOffsetDays: 18,
      annualFeeDate: null,
      annualFeeDateManual: false,
    });
  });

  it('含明细账单写入 mailLogId + hasDetails + 年费合计 + source=email', async () => {
    const id = await applyParsedBill(55, 'cmb2026', makeBill([
      { date: '08-01', description: '超市消费', amount: 88 },
      { date: '08-02', description: '信用卡年费', amount: 300 },
    ]));
    expect(id).toBe(101);
    expect(tx.bill.upsert).toHaveBeenCalledTimes(1);
    const arg = tx.bill.upsert.mock.calls[0]![0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(arg.create).toMatchObject({ mailLogId: 55, hasDetails: true, annualFeeAmount: 300, source: 'email' });
    expect(arg.update).toMatchObject({ mailLogId: 55, hasDetails: true, annualFeeAmount: 300, source: 'email' });
  });

  it('按账单顺序持久化卡片归属、标准日期和原交易币种', async () => {
    await applyParsedBill(55, 'cmb2026', makeBill([
      {
        date: '08/01',
        description: '境外消费',
        amount: 88,
        currency: 'CNY',
        originalAmount: 12.5,
        originalCurrency: 'USD',
        cardLast4: '1234',
      },
    ]));

    expect(tx.billTransaction.deleteMany).toHaveBeenCalledWith({ where: { billId: 101 } });
    expect(tx.billTransaction.createMany).toHaveBeenCalledWith({
      data: [{
        billId: 101,
        bankName: '测试银行',
        cardId: 7,
        cardLast4: '1234',
        transactionDate: fromYmd('2026-08-01'),
        dateText: '08/01',
        description: '境外消费',
        amount: 88,
        currency: 'CNY',
        originalAmount: 12.5,
        originalCurrency: 'USD',
        sequence: 0,
      }],
    });
    expect(tx.bill.update).toHaveBeenCalledWith({ where: { id: 101 }, data: { hasDetails: true } });
  });

  it('原交易金额与入账金额完全相同时不重复持久化', async () => {
    await applyParsedBill(55, 'icbc2026', makeBill([
      {
        date: '08/01',
        description: '人民币消费',
        amount: 88,
        currency: 'CNY',
        originalAmount: 88,
        originalCurrency: 'CNY',
        cardLast4: '1234',
      },
    ]));

    expect(tx.billTransaction.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ originalAmount: null, originalCurrency: null })],
    });
  });

  it('同一邮件的 CNY/USD 账单使用独立唯一键并在一次事务入口完成', async () => {
    tx.bill.upsert
      .mockResolvedValueOnce({ id: 101 })
      .mockResolvedValueOnce({ id: 102 });
    const cny = makeBill();
    const usd = { ...makeBill(), amount: 2.68, minAmount: 0.14, currency: 'USD' };

    const ids = await applyParsedBills(60, 'ceb2026', [cny, usd]);

    expect(ids).toEqual([101, 102]);
    expect(tx.bill.upsert.mock.calls.map((call) => call[0].where)).toEqual([
      { cardId_period_currency: { cardId: 7, period: '2026-08', currency: 'CNY' } },
      { cardId_period_currency: { cardId: 7, period: '2026-08', currency: 'USD' } },
    ]);
  });

  it('入账币种与所属账单不一致时拒绝写入整封邮件', async () => {
    await expect(applyParsedBill(61, 'test', makeBill([
      { date: '08/01', description: '错误币种', amount: 1, currency: 'USD' },
    ]))).rejects.toThrow('CNY 账单包含 USD 入账明细');
    expect(tx.billTransaction.createMany).not.toHaveBeenCalled();
  });

  it('零金额及溢缴款账单初始化为已结清', async () => {
    await applyParsedBill(62, 'test', {
      ...makeBill(),
      amount: -10,
      period: '2027-08',
      statementDate: fromYmd('2027-08-05'),
      dueDate: fromYmd('2027-08-23'),
    });
    const arg = tx.bill.upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(arg.create).toMatchObject({ paidStatus: 'paid', paidAmount: -10 });
  });

  it('无明细账单 hasDetails=false 且年费为 null', async () => {
    await applyParsedBill(56, 'cmb2026', makeBill());
    const arg = tx.bill.upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(arg.create).toMatchObject({ mailLogId: 56, hasDetails: false, annualFeeAmount: null });
  });

  it('正式账单有明细时整段删除同账期未出账记录', async () => {
    await applyParsedBill(63, 'cmb2026', {
      ...makeBill([{ date: '08/03', description: '正式消费', amount: 10 }]),
      bankName: '招商银行',
      cycleStartDate: fromYmd('2026-07-09'),
      statementDate: fromYmd('2026-08-08'),
    });
    expect(tx.billTransaction.deleteMany).toHaveBeenCalledWith({
      where: {
        billId: null,
        dailyMailLogId: { not: null },
        bankName: '招商银行',
        transactionDate: {
          gte: fromYmd('2026-07-09'),
          lte: new Date(fromYmd('2026-08-08').getTime() + 86_400_000 - 1),
        },
      },
    });
  });

  it('正式账单无明细时把周期内日度交易转入正式账期', async () => {
    tx.billTransaction.findMany.mockResolvedValue([{
      id: 901,
      billId: null,
      cardId: null,
      cardLast4: '1234',
      currency: 'CNY',
    }]);
    await applyParsedBill(64, 'cmb2026', {
      ...makeBill(),
      bankName: '招商银行',
      cycleStartDate: fromYmd('2026-07-09'),
      statementDate: fromYmd('2026-08-08'),
    });
    expect(tx.billTransaction.update).toHaveBeenCalledWith({
      where: { id: 901 },
      data: { billId: 101, cardId: 7, sequence: 0 },
    });
    expect(tx.bill.update).toHaveBeenCalledWith({ where: { id: 101 }, data: { hasDetails: true } });
  });

  it('冻结卡收到真实邮件账单时仍入库，且不改写卡片状态', async () => {
    tx.card.findUnique.mockResolvedValue({
      id: 7,
      holderName: '张三',
      statementDay: 5,
      dueRule: 'offset',
      dueDay: null,
      dueOffsetDays: 18,
      annualFeeDate: null,
      annualFeeDateManual: false,
      status: 'frozen',
    });

    await applyParsedBill(59, 'cmb2026', makeBill());

    expect(tx.bill.upsert).toHaveBeenCalledTimes(1);
    expect(tx.card.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: expect.anything() }) }),
    );
  });

  it('零元年费减免识别日期但不计年费金额，返还行仍排除', async () => {
    await applyParsedBill(57, 'cmb2026', makeBill([
      { date: '08-01', description: '年费返还', amount: 300 },
      { date: '08-02', description: '已为您减免本年度年费', amount: 0 },
    ]));
    const arg = tx.bill.upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(arg.create).toMatchObject({ hasDetails: true, annualFeeAmount: null });
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { annualFeeDate: fromYmd('2026-08-02') },
    });
  });

  it('明细含年费且日期可解析时自动识别年费收取日', async () => {
    await applyParsedBill(58, 'cmb2026', makeBill([
      { date: '2026-08-02', description: '信用卡年费', amount: 300 },
    ]));
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { annualFeeDate: fromYmd('2026-08-02') },
    });
  });

  it('年费收取日已被手动设置时不覆盖', async () => {
    tx.card.findUnique.mockResolvedValue({
      id: 7,
      holderName: '张三',
      statementDay: 5,
      dueRule: 'offset',
      dueDay: null,
      dueOffsetDays: 18,
      annualFeeDate: fromYmd('2024-03-15'),
      annualFeeDateManual: true,
    });
    await applyParsedBill(58, 'cmb2026', makeBill([
      { date: '2026-08-02', description: '信用卡年费', amount: 300 },
    ]));
    expect(tx.card.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ annualFeeDate: expect.anything() }) }),
    );
  });

  it('同一卡多条年费日期证据取最新一条', async () => {
    await applyParsedBill(58, 'cmb2026', makeBill([
      { date: '08-01', description: '年费', amount: 300 },
      { date: '08-03', description: '消费6次免年费300元', amount: 0 },
    ]));
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { annualFeeDate: fromYmd('2026-08-03') },
    });
  });

  it('历史旧账单重放不覆盖更新年份的自动年费日', async () => {
    tx.card.findUnique.mockResolvedValue({
      id: 7,
      holderName: '张三',
      statementDay: 5,
      dueRule: 'offset',
      dueDay: null,
      dueOffsetDays: 18,
      annualFeeDate: fromYmd('2026-08-02'),
      annualFeeDateManual: false,
    });
    await applyParsedBill(58, 'cmb2026', {
      ...makeBill([{ date: '2025-07-15', description: '信用卡年费', amount: 300 }]),
      period: '2025-08',
      statementDate: fromYmd('2025-08-05'),
      dueDate: fromYmd('2025-08-23'),
    });
    expect(tx.card.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ annualFeeDate: expect.anything() }) }),
    );
  });
});

describe('applyCurrentCycleTransactions 未出账落库', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.billTransaction.count.mockResolvedValue(0);
    tx.card.findUnique.mockResolvedValue({ id: 19 });
  });

  it('只关联已有卡片并以来源邮件序号保证幂等', async () => {
    const transactionAt = new Date(fromYmd('2026-08-19').getTime() + 2 * 3_600_000 + 38 * 60_000 + 56_000);
    const count = await applyCurrentCycleTransactions(88, [{
      bankName: '招商银行',
      transactions: [{
        date: '2026/08/19 02:38:56',
        transactionAt,
        description: '邮购 COMMANDCODE.AI',
        amount: 1.36,
        currency: 'USD',
        cardLast4: '2111',
      }],
    }], fromYmd('2026-08-08'));

    expect(count).toBe(1);
    expect(tx.card.create).not.toHaveBeenCalled();
    expect(tx.billTransaction.createMany).toHaveBeenCalledWith({
      data: [{
        billId: null,
        bankName: '招商银行',
        dailyMailLogId: 88,
        cardId: 19,
        cardLast4: '2111',
        transactionDate: transactionAt,
        dateText: '2026/08/19 02:38:56',
        description: '邮购 COMMANDCODE.AI',
        amount: 1.36,
        currency: 'USD',
        originalAmount: null,
        originalCurrency: null,
        sequence: 0,
      }],
    });
  });

  it('已转入正式账期的日度来源不会被重复重建', async () => {
    tx.billTransaction.count.mockResolvedValue(2);
    const count = await applyCurrentCycleTransactions(88, [], fromYmd('2026-08-08'));
    expect(count).toBe(2);
    expect(tx.billTransaction.deleteMany).not.toHaveBeenCalled();
    expect(tx.billTransaction.createMany).not.toHaveBeenCalled();
  });
});

describe('applyParsedBill 合并账单多卡', () => {
  function makeMergedBill(): ParsedBill {
    return {
      bankName: '邮储银行',
      cardLast4: '5888',
      cardLast4s: ['5888', '6666'],
      amount: 2000,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tx.bill.upsert.mockResolvedValue({ id: 201 });
    tx.bill.findMany.mockResolvedValue([]);
    tx.bill.findUnique.mockResolvedValue(null);
    tx.bill.count.mockResolvedValue(0);
    tx.card.findMany.mockResolvedValue([]);
    tx.billCard.count.mockResolvedValue(0);
    // 主卡已有档案；副卡无档案（走自动建卡）
    tx.card.findUnique.mockImplementation(async ({ where }: { where: { bankName_cardLast4: { cardLast4: string } } }) => {
      if (where.bankName_cardLast4.cardLast4 === '5888') {
        return {
          id: 7,
          holderName: '张三',
          statementDay: 5,
          dueRule: 'offset',
          dueDay: null,
          dueOffsetDays: 18,
          annualFeeDate: null,
          annualFeeDateManual: false,
        };
      }
      return null;
    });
    tx.card.create.mockImplementation(async ({ data }: { data: { cardLast4: string } }) => ({
      id: data.cardLast4 === '6666' ? 8 : 9,
      ...data,
    }));
  });

  it('为全部卡尾建档案并重建 BillCard 关联', async () => {
    const id = await applyParsedBill(77, 'psbc', makeMergedBill());
    expect(id).toBe(201);
    // 副卡自动建卡
    expect(tx.card.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bankName: '邮储银行', cardLast4: '6666' }) }),
    );
    // 账单挂在主卡
    const arg = tx.bill.upsert.mock.calls[0]![0] as {
      where: { cardId_period_currency: { cardId: number } };
      create: Record<string, unknown>;
    };
    expect(arg.where.cardId_period_currency.cardId).toBe(7);
    expect(arg.create).toMatchObject({ cardId: 7, source: 'email' });
    // 重建关联：先删后建，两卡都关联
    expect(tx.billCard.deleteMany).toHaveBeenCalledWith({ where: { billId: 201 } });
    expect(tx.billCard.createMany).toHaveBeenCalledWith({
      data: [
        { billId: 201, cardId: 7 },
        { billId: 201, cardId: 8 },
      ],
    });
  });

  it('多卡账单按年费明细卡尾更新消费卡，不误写承接卡', async () => {
    await applyParsedBill(77, 'cmb2026', {
      ...makeMergedBill(),
      transactions: [
        { date: '0801', description: '消费6次免年费300元', amount: 0, cardLast4: '6666' },
      ],
    });
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { annualFeeDate: fromYmd('2026-08-01') },
    });
    expect(tx.card.update).not.toHaveBeenCalledWith({
      where: { id: 7 },
      data: { annualFeeDate: expect.anything() },
    });
    const arg = tx.bill.upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(arg.create.annualFeeAmount).toBeNull();
  });

  it('同一期两张卡分别存在年费证据时分别更新，金额仍只合计实际年费', async () => {
    await applyParsedBill(77, 'cmb2026', {
      ...makeMergedBill(),
      transactions: [
        { date: '08-02', description: '信用卡年费', amount: 300, cardLast4: '5888' },
        { date: '08-01', description: '消费6次免年费300元', amount: 0, cardLast4: '6666' },
      ],
    });
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { annualFeeDate: fromYmd('2026-08-02') },
    });
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { annualFeeDate: fromYmd('2026-08-01') },
    });
    const arg = tx.bill.upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(arg.create.annualFeeAmount).toBe(300);
  });

  it('无卡尾年费明细与持久化规则一致，回落到套卡优先显示卡', async () => {
    tx.card.findUnique.mockImplementation(async ({ where }: { where: { bankName_cardLast4: { cardLast4: string } } }) => {
      const tail = where.bankName_cardLast4.cardLast4;
      if (tail !== '5888' && tail !== '6666') return null;
      return {
        id: tail === '5888' ? 7 : 8,
        holderName: tail === '5888' ? '张三' : null,
        statementDay: 5,
        dueRule: 'offset',
        dueDay: null,
        dueOffsetDays: 18,
        annualFeeDate: null,
        annualFeeDateManual: false,
        primaryManual: false,
        priority: tail === '6666' ? 100 : 0,
      };
    });
    await applyParsedBill(77, 'cmb2026', {
      ...makeMergedBill(),
      transactions: [
        { date: '08-01', description: '年费减免', amount: 0, cardLast4: null },
      ],
    });
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { annualFeeDate: fromYmd('2026-08-01') },
    });
    expect(tx.billTransaction.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ cardId: 8, cardLast4: '6666' })],
    });
  });

  it('单卡账单关联数一致时不重建关联', async () => {
    tx.billCard.count.mockResolvedValue(1);
    await applyParsedBill(78, 'cmb2026', {
      bankName: '邮储银行',
      cardLast4: '5888',
      amount: 100,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
    });
    expect(tx.billCard.deleteMany).not.toHaveBeenCalled();
    expect(tx.billCard.createMany).not.toHaveBeenCalled();
  });
});

describe('applyParsedBill 账户级账单（---- 占位）挂卡规则', () => {
  function makeAccountBill(): ParsedBill {
    return {
      bankName: '招商银行',
      cardLast4: '----',
      amount: 3000,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tx.bill.upsert.mockResolvedValue({ id: 301 });
    tx.bill.findMany.mockResolvedValue([]);
    tx.bill.findUnique.mockResolvedValue(null);
    tx.bill.count.mockResolvedValue(0);
    tx.billCard.count.mockResolvedValue(1);
  });

  it('银行已有 ---- 档案时直接挂（始终无卡号，---- 是身份不删）', async () => {
    tx.card.findUnique.mockResolvedValue({
      id: 7,
      holderName: null,
      statementDay: 5,
      dueRule: 'offset',
      dueDay: null,
      dueOffsetDays: 18,
      annualFeeDate: null,
      annualFeeDateManual: false,
    });
    await applyParsedBill(88, 'cmb2026', makeAccountBill());
    const arg = tx.bill.upsert.mock.calls[0]![0] as { where: { cardId_period_currency: { cardId: number } } };
    expect(arg.where.cardId_period_currency.cardId).toBe(7);
    expect(tx.card.create).not.toHaveBeenCalled();
    expect(tx.card.delete).not.toHaveBeenCalled();
  });

  it('无 ---- 档案且该银行有卡出账日/还款日规则与账单吻合时挂该卡', async () => {
    tx.card.findUnique.mockResolvedValue(null);
    tx.card.findMany.mockResolvedValue([
      // 出账日不同（10 号），不匹配
      { id: 8, statementDay: 10, dueRule: 'offset', dueDay: null, dueOffsetDays: 18, annualFeeDate: null, annualFeeDateManual: false },
      // 出账 8/5 + 18 天 = 8/23，与账单完全吻合
      { id: 9, statementDay: 5, dueRule: 'offset', dueDay: null, dueOffsetDays: 18, annualFeeDate: null, annualFeeDateManual: false },
    ]);
    await applyParsedBill(89, 'cmb2026', makeAccountBill());
    const arg = tx.bill.upsert.mock.calls[0]![0] as { where: { cardId_period_currency: { cardId: number } } };
    expect(arg.where.cardId_period_currency.cardId).toBe(9);
    expect(tx.card.create).not.toHaveBeenCalled();
  });

  it('无 ---- 档案且该银行的卡规则均不吻合时新建 ---- 档案', async () => {
    tx.card.findUnique.mockResolvedValue(null);
    tx.card.findMany.mockResolvedValue([
      // 出账日/还款日推算均与账单不符
      { id: 9, statementDay: 10, dueRule: 'offset', dueDay: null, dueOffsetDays: 18, annualFeeDate: null, annualFeeDateManual: false },
      { id: 10, statementDay: 5, dueRule: 'offset', dueDay: null, dueOffsetDays: 25, annualFeeDate: null, annualFeeDateManual: false },
    ]);
    tx.card.create.mockImplementation(async ({ data }: { data: { cardLast4: string } }) => ({
      id: 11,
      ...data,
    }));
    await applyParsedBill(90, 'cmb2026', makeAccountBill());
    expect(tx.card.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bankName: '招商银行', cardLast4: '----' }) }),
    );
    const arg = tx.bill.upsert.mock.calls[0]![0] as { where: { cardId_period_currency: { cardId: number } } };
    expect(arg.where.cardId_period_currency.cardId).toBe(11);
  });

  it('银行无任何卡时新建 ---- 档案（首次见卡）', async () => {
    tx.card.findUnique.mockResolvedValue(null);
    tx.card.findMany.mockResolvedValue([]);
    tx.card.create.mockImplementation(async ({ data }: { data: { cardLast4: string } }) => ({
      id: 11,
      ...data,
    }));
    await applyParsedBill(91, 'cmb2026', makeAccountBill());
    expect(tx.card.create).toHaveBeenCalledTimes(1);
    const arg = tx.bill.upsert.mock.calls[0]![0] as { where: { cardId_period_currency: { cardId: number } } };
    expect(arg.where.cardId_period_currency.cardId).toBe(11);
  });
});

describe('applyParsedBill 按卡尾写入持卡人 + 占位切归属', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.bill.upsert.mockResolvedValue({ id: 401 });
    tx.bill.findMany.mockResolvedValue([]);
    tx.bill.findUnique.mockResolvedValue(null);
    tx.bill.count.mockResolvedValue(0);
    tx.card.findMany.mockResolvedValue([]);
    tx.billCard.count.mockResolvedValue(0);
  });

  it('holderMap 按卡尾写入对应卡，不得用抬头覆盖附卡', async () => {
    tx.card.findUnique.mockResolvedValue(null);
    tx.card.create.mockImplementation(async ({ data }: { data: { cardLast4: string } }) => ({
      id: data.cardLast4 === '1765' ? 21 : 22,
      ...data,
    }));
    await applyParsedBill(92, 'pab2026', {
      bankName: '平安银行',
      cardLast4: '1765',
      cardLast4s: ['1765', '8837'],
      holderName: '张三',
      holderMap: { '1765': '张三', '8837': '王小花' },
      amount: 1756.01,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-17'),
      dueDate: fromYmd('2026-09-05'),
      period: '2026-08',
    });
    expect(tx.card.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cardLast4: '1765', holderName: '张三' }) }),
    );
    expect(tx.card.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cardLast4: '8837', holderName: '王小花' }) }),
    );
  });

  it('未完善占位卡同账期出现真尾号卡时隐藏，不删卡不改挂', async () => {
    tx.card.findUnique.mockResolvedValue({
      id: 31,
      holderName: null,
      statementDay: 5,
      dueRule: 'offset',
      dueDay: null,
      dueOffsetDays: 18,
      annualFeeDate: null,
      annualFeeDateManual: false,
      hidden: false,
      priority: 0,
      displayLast4: '3096',
    });
    tx.card.findMany.mockImplementation(async ({ where }: { where: { displayLast4?: string; cardLast4?: unknown } }) => {
      if (where.displayLast4 === '----' || (where.cardLast4 && typeof where.cardLast4 === 'object')) {
        return [{ id: 9, cardLast4: '----', displayLast4: '----', hidden: false }];
      }
      return [];
    });
    tx.bill.findFirst.mockResolvedValue({ id: 89 });
    tx.bill.findUnique.mockResolvedValue(null);
    await applyParsedBill(93, 'cmb2026', {
      bankName: '招商银行',
      cardLast4: '3096',
      amount: 100,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
    });
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { hidden: true, isPrimary: false, primaryManual: false },
    });
    expect(tx.card.delete).not.toHaveBeenCalled();
    expect(tx.bill.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cardId: expect.anything() }) }),
    );
  });

  it('已完善占位卡碰同尾号时匹配尾号从 ---- 改成真号', async () => {
    tx.card.findUnique.mockResolvedValue(null);
    tx.card.findMany.mockResolvedValue([
      { id: 9, cardLast4: '----', displayLast4: '3096', hidden: false, priority: 0, holderName: null, statementDay: 5, dueRule: 'offset', dueDay: null, dueOffsetDays: 18, annualFeeDate: null, annualFeeDateManual: false, primaryManual: false },
    ]);
    tx.card.update.mockImplementation(async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({
      id: where.id,
      cardLast4: data.cardLast4 ?? '----',
      displayLast4: data.displayLast4 ?? '3096',
      hidden: false,
      priority: 0,
      holderName: null,
      statementDay: 5,
      dueRule: 'offset',
      dueDay: null,
      dueOffsetDays: 18,
      annualFeeDate: null,
      annualFeeDateManual: false,
      primaryManual: false,
    }));
    tx.bill.findUnique.mockResolvedValue(null);
    await applyParsedBill(96, 'cmb2026', {
      bankName: '招商银行',
      cardLast4: '3096',
      amount: 100,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
    });
    expect(tx.card.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { cardLast4: '3096', displayLast4: '3096' },
    });
    expect(tx.card.create).not.toHaveBeenCalled();
    expect(tx.card.delete).not.toHaveBeenCalled();
  });

  it('无映射的附卡复用同封承接卡已有姓名', async () => {
    tx.card.findUnique.mockImplementation(async ({ where }: { where: { bankName_cardLast4: { cardLast4: string } } }) => {
      if (where.bankName_cardLast4.cardLast4 === '1765') {
        return {
          id: 21,
          holderName: '张三',
          statementDay: 17,
          dueRule: 'offset',
          dueDay: null,
          dueOffsetDays: 19,
          annualFeeDate: null,
          annualFeeDateManual: false,
          primaryManual: false,
        };
      }
      return null;
    });
    tx.card.create.mockImplementation(async ({ data }: { data: { cardLast4: string } }) => ({
      id: 22,
      ...data,
    }));
    await applyParsedBill(94, 'pab2026', {
      bankName: '平安银行',
      cardLast4: '1765',
      cardLast4s: ['1765', '8837'],
      amount: 1756.01,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-17'),
      dueDate: fromYmd('2026-09-05'),
      period: '2026-08',
    });
    expect(tx.card.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cardLast4: '8837', holderName: null }) }),
    );
    expect(tx.card.update).toHaveBeenCalledWith({ where: { id: 22 }, data: { holderName: '张三' } });
  });

  it('多卡时 BillCard 含优先显示卡（承接卡）', async () => {
    tx.card.findUnique.mockImplementation(async ({ where }: { where: { bankName_cardLast4: { cardLast4: string } } }) => {
      if (where.bankName_cardLast4.cardLast4 === '1765') {
        return {
          id: 21,
          holderName: null,
          statementDay: 17,
          dueRule: 'offset',
          dueDay: null,
          dueOffsetDays: 19,
          annualFeeDate: null,
          annualFeeDateManual: false,
          primaryManual: false,
        };
      }
      return null;
    });
    tx.card.create.mockImplementation(async ({ data }: { data: { cardLast4: string } }) => ({
      id: 22,
      ...data,
    }));
    await applyParsedBill(95, 'pab2026', {
      bankName: '平安银行',
      cardLast4: '1765',
      cardLast4s: ['1765', '8837'],
      amount: 1756.01,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-17'),
      dueDate: fromYmd('2026-09-05'),
      period: '2026-08',
      transactions: [
        { date: '2026-07-15', description: '账单分期手续费', amount: 50, cardLast4: null },
      ],
    });
    expect(tx.billCard.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { billId: 401, cardId: 21 },
        { billId: 401, cardId: 22 },
      ]),
    });
  });
});

describe('applyParsedBill priority 累加', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.bill.upsert.mockResolvedValue({ id: 501 });
    tx.bill.findMany.mockResolvedValue([]);
    tx.bill.findUnique.mockResolvedValue(null);
    tx.bill.findFirst.mockResolvedValue(null);
    tx.bill.count.mockResolvedValue(0);
    tx.card.findMany.mockResolvedValue([]);
    tx.billCard.count.mockResolvedValue(1);
    tx.card.update.mockResolvedValue({});
    tx.card.findUnique.mockResolvedValue({
      id: 7,
      holderName: '张三',
      statementDay: 5,
      dueRule: 'offset',
      dueDay: null,
      dueOffsetDays: 18,
      annualFeeDate: null,
      annualFeeDateManual: false,
      hidden: false,
      priority: 10,
      displayLast4: '1234',
      primaryManual: false,
    });
  });

  it('无明细时按该期总金额累加', async () => {
    await applyParsedBill(101, 'cmb2026', {
      bankName: '测试银行',
      cardLast4: '1234',
      amount: 100,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
    });
    expect(tx.card.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { priority: 110 } });
  });

  it('同期已存在账单不再累加', async () => {
    tx.bill.findUnique.mockResolvedValue({ id: 501 });
    await applyParsedBill(102, 'cmb2026', {
      bankName: '测试银行',
      cardLast4: '1234',
      amount: 100,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
    });
    expect(tx.card.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priority: expect.anything() }) }),
    );
  });

  it('有明细时各加各的金额', async () => {
    tx.billCard.count.mockResolvedValue(0);
    tx.card.findUnique.mockImplementation(async ({ where }: { where: { bankName_cardLast4: { cardLast4: string } } }) => {
      if (where.bankName_cardLast4.cardLast4 === '1111') {
        return {
          id: 11,
          holderName: null,
          statementDay: 5,
          dueRule: 'offset',
          dueDay: null,
          dueOffsetDays: 18,
          annualFeeDate: null,
          annualFeeDateManual: false,
          hidden: false,
          priority: 0,
          displayLast4: '1111',
          primaryManual: false,
        };
      }
      if (where.bankName_cardLast4.cardLast4 === '2222') {
        return {
          id: 12,
          holderName: null,
          statementDay: 5,
          dueRule: 'offset',
          dueDay: null,
          dueOffsetDays: 18,
          annualFeeDate: null,
          annualFeeDateManual: false,
          hidden: false,
          priority: 5,
          displayLast4: '2222',
          primaryManual: true,
        };
      }
      return null;
    });
    await applyParsedBill(103, 'cmb2026', {
      bankName: '测试银行',
      cardLast4: '1111',
      cardLast4s: ['1111', '2222'],
      amount: 300,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
      transactions: [
        { date: '08-01', description: '超市', amount: 80, cardLast4: '1111' },
        { date: '08-02', description: '加油', amount: 120, cardLast4: '2222' },
        { date: '08-03', description: '会员费', amount: 100, cardLast4: null },
      ],
    });
    expect(tx.card.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { priority: 80 } });
    expect(tx.card.update).toHaveBeenCalledWith({ where: { id: 12 }, data: { priority: 125 } });
  });

  it('负数与 0 值明细一律不计入，只有正数消费和费用累加', async () => {
    await applyParsedBill(104, 'cmb2026', {
      bankName: '测试银行',
      cardLast4: '1234',
      amount: 0,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
      transactions: [
        { date: '08-01', description: '超市', amount: 80, cardLast4: '1234' },
        { date: '08-02', description: '自动还款', amount: -500, cardLast4: '1234' },
        { date: '08-03', description: '退款冲抵', amount: -80, cardLast4: '1234' },
        { date: '08-04', description: '积分返还', amount: 0, cardLast4: '1234' },
      ],
    });
    // 仅正数 80 计入；负数不扣分、0 不计入
    expect(tx.card.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { priority: 90 } });
  });

  it('混合明细时跳过负数与 0，只加正数合计', async () => {
    tx.billCard.count.mockResolvedValue(0);
    tx.card.findUnique.mockImplementation(async ({ where }: { where: { bankName_cardLast4: { cardLast4: string } } }) => {
      if (where.bankName_cardLast4.cardLast4 === '1111') {
        return {
          id: 11,
          holderName: null,
          statementDay: 5,
          dueRule: 'offset',
          dueDay: null,
          dueOffsetDays: 18,
          annualFeeDate: null,
          annualFeeDateManual: false,
          hidden: false,
          priority: 0,
          displayLast4: '1111',
          primaryManual: false,
        };
      }
      if (where.bankName_cardLast4.cardLast4 === '2222') {
        return {
          id: 12,
          holderName: null,
          statementDay: 5,
          dueRule: 'offset',
          dueDay: null,
          dueOffsetDays: 18,
          annualFeeDate: null,
          annualFeeDateManual: false,
          hidden: false,
          priority: 0,
          displayLast4: '2222',
          primaryManual: false,
        };
      }
      return null;
    });
    await applyParsedBill(105, 'cmb2026', {
      bankName: '测试银行',
      cardLast4: '1111',
      cardLast4s: ['1111', '2222'],
      amount: 300,
      currency: 'CNY',
      statementDate: fromYmd('2026-08-05'),
      dueDate: fromYmd('2026-08-23'),
      period: '2026-08',
      transactions: [
        { date: '08-01', description: '超市', amount: 80, cardLast4: '1111' },
        { date: '08-02', description: '还款', amount: -300, cardLast4: '1111' },
        { date: '08-03', description: '加油', amount: 120, cardLast4: '2222' },
        { date: '08-04', description: '退款', amount: -120, cardLast4: '2222' },
        { date: '08-05', description: '分期手续费', amount: 0, cardLast4: '2222' },
      ],
    });
    expect(tx.card.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { priority: 80 } });
    expect(tx.card.update).toHaveBeenCalledWith({ where: { id: 12 }, data: { priority: 120 } });
  });
});
