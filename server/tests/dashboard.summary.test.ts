import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';

const prisma = vi.hoisted(() => ({
  card: { findMany: vi.fn() },
  bill: { findMany: vi.fn(), findUnique: vi.fn() },
  customReminder: { findMany: vi.fn() },
  customReminderOccurrence: { findMany: vi.fn() },
  emailAccount: { findMany: vi.fn() },
  appSetting: { findUnique: vi.fn() },
  $executeRaw: vi.fn(),
}));

vi.mock('../src/lib/prisma', () => ({ prisma }));
vi.mock('../src/routes/middleware', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  COOKIE_NAME: 'drc_token',
}));
vi.mock('../src/modules/reminders/reminder.engine', () => ({
  buildBillsByCard: () => new Map(),
  collectUpcoming: () => [],
}));
vi.mock('../src/modules/reminders/custom-occurrences', () => ({
  materializeCustomReminderOccurrences: vi.fn(async () => undefined),
  occurrenceToView: (row: unknown) => row,
}));
vi.mock('../src/lib/dates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/dates')>();
  return {
    ...actual,
    today: () => actual.fromYmd('2026-09-02'),
  };
});

import dashboardRouter from '../src/routes/dashboard.routes';
import { ApiError } from '../src/lib/errors';
import { fromYmd } from '../src/lib/dates';

function bill(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    cardId: 1,
    period: '2026-08',
    statementDate: fromYmd('2026-08-05'),
    dueDate: fromYmd('2026-08-25'),
    amount: 1000,
    minAmount: 100,
    paidStatus: 'unpaid',
    paidAmount: null,
    paidAt: null,
    currency: 'CNY',
    annualFeeAmount: null,
    hasDetails: false,
    source: 'email',
    createdAt: fromYmd('2026-08-06'),
    cards: [],
    ...overrides,
  };
}

function card(id: number, bankName: string, tail: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    bankName,
    cardLast4: tail,
    displayLast4: tail,
    currency: 'CNY',
    statementDay: 5,
    dueRule: 'offset',
    dueDay: null,
    dueOffsetDays: 20,
    status: 'active',
    createdAt: fromYmd('2026-01-01'),
    businessRole: 'standalone',
    businessPrimaryId: null,
    hidden: false,
    cardNoFullEnc: null,
    expDateEnc: null,
    cvvEnc: null,
    ...overrides,
  };
}

function customRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    reminderId: 1,
    name: '房租',
    businessType: 'fixed_bill',
    targetDate: fromYmd('2026-08-01'),
    availableDate: fromYmd('2026-07-25'),
    daysBefore: [3, 0],
    note: null,
    amount: 200,
    status: 'open',
    completedAt: null,
    suspended: false,
    ...overrides,
  };
}

async function withServer(run: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', dashboardRouter);
  app.use((error: Error & { status?: number; issues?: unknown }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if ('issues' in error && Array.isArray(error.issues)) {
      res.status(400).json({ error: '参数校验失败' });
      return;
    }
    res.status(error.status ?? 500).json({ error: error.message });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function fetchSummary() {
  let body: Record<string, unknown> = {};
  await withServer(async (url) => {
    const response = await fetch(`${url}/api/dashboard/summary`);
    expect(response.status).toBe(200);
    body = await response.json() as Record<string, unknown>;
  });
  return body;
}

describe('首页当前待还聚合', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.card.findMany.mockResolvedValue([]);
    prisma.bill.findMany.mockResolvedValue([]);
    prisma.customReminder.findMany.mockResolvedValue([]);
    prisma.customReminderOccurrence.findMany.mockResolvedValue([]);
    prisma.emailAccount.findMany.mockResolvedValue([]);
    prisma.appSetting.findUnique.mockResolvedValue(null);
  });

  it('逾期未取得账单占位行按台账行计入，三张民生卡为 3 笔', async () => {
    prisma.card.findMany.mockResolvedValue([
      card(1, '民生银行', '1111'),
      card(2, '民生银行', '2222'),
      card(3, '民生银行', '3333'),
    ]);

    const body = await fetchSummary();
    const currentPeriod = body.currentPeriod as Record<string, unknown>;
    expect(currentPeriod.period).toBe('2026-09');
    expect(currentPeriod.unpaidCount).toBe(3);
    expect(currentPeriod.bills).toBe(3);
    expect(currentPeriod.unpaidTotal).toBe(0);
    expect(currentPeriod.unknownAmountCount).toBe(3);
    expect(currentPeriod).not.toHaveProperty('overdueCount');
    expect(currentPeriod).not.toHaveProperty('overdueTotal');
    expect(currentPeriod.totalsByCurrency).toEqual([
      { currency: 'CNY', unpaidCount: 3, unpaidTotal: 0, annualFeeTotal: 0 },
    ]);
  });

  it('逾期上期真实账单计入，已还清不计入', async () => {
    prisma.card.findMany.mockResolvedValue([card(1, '民生银行', '1111'), card(2, '招商银行', '3096')]);
    prisma.bill.findMany.mockResolvedValue([
      bill(10, { cardId: 1, amount: 2580, paidStatus: 'unpaid' }),
      bill(11, {
        cardId: 2,
        period: '2026-07',
        statementDate: fromYmd('2026-07-05'),
        dueDate: fromYmd('2026-07-25'),
        amount: 800,
        paidStatus: 'paid',
        paidAmount: 800,
        paidAt: fromYmd('2026-07-20'),
        cards: [],
      }),
    ]);

    const currentPeriod = (await fetchSummary()).currentPeriod as Record<string, unknown>;
    // 卡1 有 8 月真实未还；卡2 7 月已还，8 月无账单 → 1 条占位行
    expect(currentPeriod.unpaidCount).toBe(2);
    expect(currentPeriod.unpaidTotal).toBe(2580);
    expect(currentPeriod.unknownAmountCount).toBe(1);
  });

  it('固定/动态账单逾期上期纳入，常规提醒排除，金额 null 走 unknownAmountCount', async () => {
    prisma.customReminderOccurrence.findMany.mockResolvedValue([
      customRow({ id: 1, businessType: 'fixed_bill', amount: 200, targetDate: fromYmd('2026-08-01') }),
      customRow({ id: 2, businessType: 'dynamic_bill', amount: null, name: '水电', targetDate: fromYmd('2026-07-15') }),
      customRow({ id: 3, businessType: 'general', amount: 50, name: '体检', targetDate: fromYmd('2026-08-10') }),
      customRow({ id: 4, businessType: 'fixed_bill', amount: 80, status: 'paid', targetDate: fromYmd('2026-08-20') }),
    ]);

    const currentPeriod = (await fetchSummary()).currentPeriod as Record<string, unknown>;
    expect(currentPeriod.unpaidCount).toBe(2);
    expect(currentPeriod.unpaidTotal).toBe(200);
    expect(currentPeriod.unknownAmountCount).toBe(1);
    expect(currentPeriod.totalsByCurrency).toEqual([
      { currency: 'CNY', unpaidCount: 2, unpaidTotal: 200, annualFeeTotal: 0 },
    ]);
  });

  it('套卡不折叠：两张卡各一期未还计 2 笔；合并账单去重后仍 1 笔', async () => {
    prisma.card.findMany.mockResolvedValue([
      card(1, '招商银行', '3096'),
      card(2, '招商银行', '8855'),
    ]);
    prisma.bill.findMany.mockResolvedValue([
      bill(21, { cardId: 1, amount: 100, cards: [] }),
      bill(22, { cardId: 2, amount: 200, cards: [] }),
    ]);

    const separate = (await fetchSummary()).currentPeriod as { unpaidCount: number };
    expect(separate.unpaidCount).toBe(2);

    prisma.bill.findMany.mockResolvedValue([
      bill(21, { cardId: 1, amount: 300, cards: [{ cardId: 1 }, { cardId: 2 }] }),
    ]);
    const merged = (await fetchSummary()).currentPeriod as { unpaidCount: number };
    expect(merged.unpaidCount).toBe(1);
  });

  it('部分已还按 remainingOf 计入差额', async () => {
    prisma.card.findMany.mockResolvedValue([card(1, '平安银行', '1234')]);
    prisma.bill.findMany.mockResolvedValue([
      bill(30, { amount: 1000, paidStatus: 'partial', paidAmount: 400, minAmount: 100 }),
    ]);

    const currentPeriod = (await fetchSummary()).currentPeriod as Record<string, unknown>;
    expect(currentPeriod.unpaidCount).toBe(1);
    expect(currentPeriod.unpaidTotal).toBe(600);
    expect(currentPeriod.unknownAmountCount).toBe(0);
  });

  it('冻结卡真实未还清账单仍计入，不生成占位行', async () => {
    prisma.card.findMany.mockResolvedValue([
      card(1, '民生银行', '1111', { status: 'frozen' }),
    ]);
    prisma.bill.findMany.mockResolvedValue([
      bill(40, { amount: 500, paidStatus: 'unpaid' }),
    ]);

    const currentPeriod = (await fetchSummary()).currentPeriod as Record<string, unknown>;
    expect(currentPeriod.unpaidCount).toBe(1);
    expect(currentPeriod.unpaidTotal).toBe(500);
    expect(currentPeriod.unknownAmountCount).toBe(0);
  });
});
