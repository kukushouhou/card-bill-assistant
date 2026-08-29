import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express, { type Router } from 'express';
import { fromYmd } from '../src/lib/dates';

const prisma = vi.hoisted(() => ({
  billTransaction: { count: vi.fn(), findMany: vi.fn() },
  bill: { findUnique: vi.fn() },
}));

vi.mock('../src/lib/prisma', () => ({ prisma }));
vi.mock('../src/routes/middleware', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  COOKIE_NAME: 'drc_token',
}));

import transactionsRouter from '../src/routes/transactions.routes';
import billsRouter from '../src/routes/bills.routes';
import { ApiError } from '../src/lib/errors';

async function withServer(prefix: string, router: Router, run: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(prefix, router);
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

describe('GET /api/transactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.billTransaction.count.mockResolvedValue(1);
    prisma.billTransaction.findMany.mockResolvedValue([
      {
        id: 71,
        billId: 11,
        bankName: '光大银行',
        cardId: 9,
        cardLast4: '3787',
        dateText: '08/03',
        transactionDate: fromYmd('2026-08-03'),
        description: '外币消费',
        amount: 2.68,
        currency: 'USD',
        originalAmount: 18.66,
        originalCurrency: 'CNY',
        bill: {
          period: '2026-08',
          statementDate: fromYmd('2026-08-12'),
          card: { bankName: '光大银行', cardLast4: '6605' },
        },
      },
    ]);
  });

  it('组合筛选、日期闭区间、分页和稳定排序均传入持久化明细查询', async () => {
    await withServer('/api/transactions', transactionsRouter, async (url) => {
      const response = await fetch(
        `${url}/api/transactions?bank=${encodeURIComponent('光大银行')}&cardId=9&dateFrom=2026-08-01&dateTo=2026-08-10&q=${encodeURIComponent('消费')}&page=2&pageSize=10`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        total: 1,
        page: 2,
        pageSize: 10,
        items: [{
          id: 71,
          billId: 11,
          period: '2026-08',
          unbilled: false,
          bankName: '光大银行',
          cardId: 9,
          cardLast4: '3787',
          date: '08/03',
          transactionDate: fromYmd('2026-08-03').toISOString(),
          description: '外币消费',
          amount: 2.68,
          currency: 'USD',
          originalAmount: 18.66,
          originalCurrency: 'CNY',
        }],
      });
    });

    const where = {
      bankName: '光大银行',
      cardId: 9,
      transactionDate: { gte: fromYmd('2026-08-01'), lt: fromYmd('2026-08-11') },
      description: { contains: '消费' },
    };
    expect(prisma.billTransaction.count).toHaveBeenCalledWith({ where });
    expect(prisma.billTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where,
      skip: 10,
      take: 10,
      orderBy: [
        { transactionDate: 'desc' },
        { bill: { statementDate: 'desc' } },
        { billId: 'desc' },
        { sequence: 'asc' },
      ],
    }));
  });

  it('非法日期不进入查询', async () => {
    await withServer('/api/transactions', transactionsRouter, async (url) => {
      const response = await fetch(`${url}/api/transactions?dateFrom=2026-8-1`);
      expect(response.status).toBe(400);
    });
    expect(prisma.billTransaction.findMany).not.toHaveBeenCalled();
  });

  it('未出账交易返回空 billId、未出账期次和银行快照', async () => {
    prisma.billTransaction.findMany.mockResolvedValueOnce([{
      id: 72,
      billId: null,
      bankName: '招商银行',
      cardId: null,
      cardLast4: '2111',
      dateText: '2026/08/19 02:38:56',
      transactionDate: fromYmd('2026-08-19'),
      description: '邮购 COMMANDCODE.AI',
      amount: 1.36,
      currency: 'USD',
      originalAmount: null,
      originalCurrency: null,
      bill: null,
    }]);
    await withServer('/api/transactions', transactionsRouter, async (url) => {
      const response = await fetch(`${url}/api/transactions`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: Array<Record<string, unknown>> };
      expect(body.items[0]).toMatchObject({
        billId: null,
        period: '未出账',
        unbilled: true,
        bankName: '招商银行',
        cardLast4: '2111',
      });
    });
  });
});

describe('GET /api/bills/:id/details', () => {
  it('直接读取账单下已持久化明细并保持单账单响应结构', async () => {
    prisma.bill.findUnique.mockResolvedValue({
      id: 11,
      period: '2026-08',
      currency: 'USD',
      annualFeeAmount: null,
      transactions: [{
        id: 71,
        dateText: '08/03',
        transactionDate: fromYmd('2026-08-03'),
        description: '外币消费',
        amount: 2.68,
        currency: 'USD',
        originalAmount: 18.66,
        originalCurrency: 'CNY',
        cardLast4: '3787',
      }],
    });

    await withServer('/api/bills', billsRouter, async (url) => {
      const response = await fetch(`${url}/api/bills/11/details`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        period: '2026-08',
        currency: 'USD',
        annualFeeAmount: null,
        transactions: [{
          id: 71,
          date: '08/03',
          transactionDate: fromYmd('2026-08-03').toISOString(),
          description: '外币消费',
          amount: 2.68,
          currency: 'USD',
          originalAmount: 18.66,
          originalCurrency: 'CNY',
          cardLast4: '3787',
        }],
      });
    });

    expect(prisma.bill.findUnique).toHaveBeenCalledWith({
      where: { id: 11 },
      include: { transactions: { orderBy: { sequence: 'asc' } } },
    });
  });
});
