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

import dashboardRouter from '../src/routes/dashboard.routes';
import { ApiError } from '../src/lib/errors';
import {
  buildAnnualFeeNotice,
  parseAnnualFeeNoticeCursor,
  serializeAnnualFeeNoticeCursor,
} from '../src/modules/bills/annual-fee-notice';

function bill(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    cardId: 1,
    period: '2026-08',
    statementDate: new Date('2026-08-05T00:00:00.000Z'),
    dueDate: new Date('2026-08-25T00:00:00.000Z'),
    amount: 100,
    minAmount: 10,
    paidStatus: 'unpaid',
    paidAmount: null,
    paidAt: null,
    currency: 'CNY',
    annualFeeAmount: 100,
    hasDetails: true,
    source: 'email',
    createdAt: new Date(`2026-08-${String(id).padStart(2, '0')}T01:00:00.000Z`),
    cards: [],
    ...overrides,
  };
}

function card(id: number, bankName: string, tail: string) {
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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    businessRole: 'standalone',
    businessPrimaryId: null,
    hidden: false,
    cardNoFullEnc: null,
    expDateEnc: null,
    cvvEnc: null,
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

describe('首页年费提醒聚合', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.customReminder.findMany.mockResolvedValue([]);
    prisma.customReminderOccurrence.findMany.mockResolvedValue([]);
    prisma.emailAccount.findMany.mockResolvedValue([]);
    prisma.appSetting.findUnique.mockResolvedValue(null);
    prisma.$executeRaw.mockResolvedValue(1);
  });

  it('游标可排序往返，账单本身及之前的记录视为已读', () => {
    const cursor = { createdAt: new Date('2026-08-20T01:02:03.456Z'), billId: 91 };
    expect(parseAnnualFeeNoticeCursor(serializeAnnualFeeNoticeCursor(cursor))).toEqual(cursor);
    expect(parseAnnualFeeNoticeCursor('坏游标')).toBeNull();
  });

  it('partial/paid 自动已读，同银行聚合卡尾和分币种金额', () => {
    const cards = [card(1, '招商银行', '3096'), card(2, '招商银行', '8855'), card(3, '平安银行', '1234')];
    const notice = buildAnnualFeeNotice([
      bill(1, { cardId: 1, annualFeeAmount: 300 }),
      bill(2, { cardId: 2, annualFeeAmount: 20, currency: 'USD' }),
      bill(3, { cardId: 3, annualFeeAmount: 600, paidStatus: 'partial' }),
      bill(4, { cardId: 3, annualFeeAmount: 500, paidStatus: 'paid' }),
      bill(5, { cardId: 3, annualFeeAmount: 100 }),
    ], cards, null);

    expect(notice).toEqual({
      billCount: 3,
      acknowledgeThroughBillId: 5,
      items: [
        {
          billId: 5,
          bankName: '平安银行',
          cardTails: ['1234'],
          period: '2026-08',
          currency: 'CNY',
          annualFeeAmount: 100,
          hasDetails: true,
        },
        {
          billId: 2,
          bankName: '招商银行',
          cardTails: ['8855'],
          period: '2026-08',
          currency: 'USD',
          annualFeeAmount: 20,
          hasDetails: true,
        },
        {
          billId: 1,
          bankName: '招商银行',
          cardTails: ['3096'],
          period: '2026-08',
          currency: 'CNY',
          annualFeeAmount: 300,
          hasDetails: true,
        },
      ],
      banks: [
        {
          bankName: '招商银行',
          billCount: 2,
          cardTails: ['3096', '8855'],
          totalsByCurrency: [
            { currency: 'CNY', amount: 300 },
            { currency: 'USD', amount: 20 },
          ],
        },
        {
          bankName: '平安银行',
          billCount: 1,
          cardTails: ['1234'],
          totalsByCurrency: [{ currency: 'CNY', amount: 100 }],
        },
      ],
    });
  });

  it('合并账单只展示实际年费交易所属卡，不枚举全部关联卡', () => {
    const cards = [card(1, '广发银行', '1119'), card(2, '广发银行', '6736')];
    const notice = buildAnnualFeeNotice([
      bill(1, {
        cardId: 1,
        annualFeeAmount: 800,
        cards: [{ cardId: 1 }, { cardId: 2 }],
        transactions: [{
          cardId: 2,
          cardLast4: '6736',
          bankName: '广发银行',
          description: '信用卡年费',
          amount: 800,
          currency: 'CNY',
        }],
      }),
    ], cards, null);

    expect(notice?.banks).toEqual([{
      bankName: '广发银行',
      billCount: 1,
      cardTails: ['6736'],
      totalsByCurrency: [{ currency: 'CNY', amount: 800 }],
    }]);
  });

  it('汇总接口枚举银行且只返回游标之后仍未还的年费账单', async () => {
    prisma.card.findMany.mockResolvedValue([card(1, '招商银行', '3096'), card(3, '平安银行', '1234')]);
    prisma.bill.findMany.mockResolvedValue([
      bill(1, { cardId: 1, annualFeeAmount: 300 }),
      bill(2, { cardId: 3, annualFeeAmount: 600, paidStatus: 'partial' }),
      bill(3, { cardId: 3, annualFeeAmount: 100 }),
    ]);
    prisma.appSetting.findUnique.mockResolvedValue({
      key: 'annualFeeNoticeReadThrough',
      value: serializeAnnualFeeNoticeCursor({ createdAt: bill(1).createdAt, billId: 1 }),
    });

    await withServer(async (url) => {
      const response = await fetch(`${url}/api/dashboard/summary`);
      expect(response.status).toBe(200);
      const body = await response.json() as { annualFeeNotice: Record<string, unknown> };
      expect(body.annualFeeNotice).toEqual({
        billCount: 1,
        acknowledgeThroughBillId: 3,
        items: [{
          billId: 3,
          bankName: '平安银行',
          cardTails: ['1234'],
          period: '2026-08',
          currency: 'CNY',
          annualFeeAmount: 100,
          hasDetails: true,
        }],
        banks: [{
          bankName: '平安银行',
          billCount: 1,
          cardTails: ['1234'],
          totalsByCurrency: [{ currency: 'CNY', amount: 100 }],
        }],
      });
    });
  });

  it('点击知道了只推进到仍未还的最后一张年费账单', async () => {
    const target = bill(5, { annualFeeAmount: 500 });
    prisma.bill.findUnique.mockResolvedValue(target);
    prisma.bill.findMany.mockResolvedValue([
      { id: 1, createdAt: bill(1).createdAt },
      { id: 4, createdAt: bill(4).createdAt },
    ]);

    await withServer(async (url) => {
      const response = await fetch(`${url}/api/dashboard/annual-fee-notice/acknowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acknowledgeThroughBillId: 5 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, updated: true, acknowledgeThroughBillId: 4 });
    });

    expect(prisma.bill.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        annualFeeAmount: { gt: 0 },
        paidStatus: { notIn: ['partial', 'paid'] },
      },
    }));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('点击期间目标账单已还款时成功收口但不修改游标', async () => {
    prisma.bill.findUnique.mockResolvedValue(bill(5, { paidStatus: 'paid' }));
    prisma.bill.findMany.mockResolvedValue([]);

    await withServer(async (url) => {
      const response = await fetch(`${url}/api/dashboard/annual-fee-notice/acknowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acknowledgeThroughBillId: 5 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, updated: false });
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
