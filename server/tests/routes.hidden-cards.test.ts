import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express, { type Router } from 'express';
import { fromYmd } from '../src/lib/dates';

const prisma = vi.hoisted(() => ({
  card: { findMany: vi.fn(), findUnique: vi.fn() },
  bill: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  customReminder: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  customReminderOccurrence: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../src/lib/prisma', () => ({ prisma }));
vi.mock('../src/routes/middleware', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  COOKIE_NAME: 'drc_token',
}));

import billsRouter from '../src/routes/bills.routes';
import remindersRouter from '../src/routes/reminders.routes';
import { ApiError } from '../src/lib/errors';

async function withServer(prefix: string, router: Router, run: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(prefix, router);
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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

function fixedCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    bankName: '测试银行',
    cardLast4: '1234',
    currency: 'CNY',
    statementDay: 19,
    dueRule: 'fixed',
    dueDay: 8,
    dueOffsetDays: null,
    remindDaysBefore: [3, 1, 0],
    status: 'active',
    hidden: false,
    createdAt: fromYmd('2026-01-01'),
    ...overrides,
  };
}

describe('账单卡片范围', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.card.findMany.mockResolvedValue([]);
    prisma.bill.findMany.mockResolvedValue([]);
    prisma.bill.findFirst.mockResolvedValue(null);
    prisma.bill.create.mockResolvedValue({ id: 100 });
  });

  it('列表筛选始终排除 hidden 卡', async () => {
    await withServer('/api/bills', billsRouter, async (url) => {
      const response = await fetch(`${url}/api/bills?cardId=42`);
      expect(response.status).toBe(200);
    });

    expect(prisma.card.findMany).toHaveBeenCalledWith({ where: { hidden: false, id: 42 } });
  });

  it('套卡详情按一组卡 ID 读取且不混入自定义账单', async () => {
    const scopedCards = [fixedCard({ id: 42 }), fixedCard({ id: 43, cardLast4: '5678' })];
    prisma.card.findMany
      .mockResolvedValueOnce(scopedCards)
      .mockResolvedValueOnce(scopedCards);

    await withServer('/api/bills', billsRouter, async (url) => {
      const response = await fetch(`${url}/api/bills?cardIds=42,43,42&pageSize=100`);
      expect(response.status).toBe(200);
    });

    expect(prisma.card.findMany).toHaveBeenNthCalledWith(1, {
      where: { hidden: false, id: { in: [42, 43] } },
    });
    expect(prisma.bill.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { cardId: { in: [42, 43] } },
          { cards: { some: { cardId: { in: [42, 43] } } } },
        ],
      },
      include: { cards: { select: { cardId: true } } },
    });
    expect(prisma.customReminderOccurrence.findMany).not.toHaveBeenCalled();
  });

  it('套卡 ID 不能与单卡筛选同时使用', async () => {
    await withServer('/api/bills', billsRouter, async (url) => {
      const response = await fetch(`${url}/api/bills?cardId=42&cardIds=42,43`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: '卡片筛选条件不能同时使用' });
    });

    expect(prisma.card.findMany).not.toHaveBeenCalled();
  });

  it('隐藏卡不能通过未取得账单标记接口重新产生记录', async () => {
    prisma.card.findUnique.mockResolvedValue(fixedCard({ hidden: true }));

    await withServer('/api/bills', billsRouter, async (url) => {
      const response = await fetch(`${url}/api/bills/mark`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId: 42, period: '2026-08', mode: 'none' }),
      });
      expect(response.status).toBe(404);
    });

    expect(prisma.bill.create).not.toHaveBeenCalled();
  });

  it.each([
    ['frozen', '卡片已冻结，不能补录新账单'],
    ['closed', '卡片已注销，不能补录新账单'],
  ])('%s 卡不能通过未取得账单标记接口补录', async (status, error) => {
    prisma.card.findUnique.mockResolvedValue(fixedCard({ status }));

    await withServer('/api/bills', billsRouter, async (url) => {
      const response = await fetch(`${url}/api/bills/mark`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId: 42, period: '2026-08', mode: 'none' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    });

    expect(prisma.bill.findFirst).not.toHaveBeenCalled();
    expect(prisma.bill.create).not.toHaveBeenCalled();
  });

  it('冻结后已有真实账单仍可更新还款状态', async () => {
    prisma.bill.findUnique.mockResolvedValue({ id: 100, amount: 1000 });

    await withServer('/api/bills', billsRouter, async (url) => {
      const response = await fetch(`${url}/api/bills/100/paid`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'partial', paidAmount: 300 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    expect(prisma.card.findUnique).not.toHaveBeenCalled();
    expect(prisma.bill.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { paidStatus: 'partial', paidAt: expect.any(Date), paidAmount: 300 },
    });
  });

  it('标记 fixed 跨月占位时保存与列表相同的次月还款日', async () => {
    prisma.card.findUnique.mockResolvedValue(fixedCard());

    await withServer('/api/bills', billsRouter, async (url) => {
      const response = await fetch(`${url}/api/bills/mark`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId: 42, period: '2026-08', mode: 'none' }),
      });
      expect(response.status).toBe(201);
    });

    expect(prisma.bill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cardId: 42,
        period: '2026-08',
        statementDate: fromYmd('2026-08-19'),
        dueDate: fromYmd('2026-09-08'),
      }),
    });
  });

  it('同一期手工补录按币种检查并创建独立账单', async () => {
    prisma.card.findUnique.mockResolvedValue(fixedCard());
    prisma.bill.findFirst.mockResolvedValue(null);

    await withServer('/api/bills', billsRouter, async (url) => {
      const response = await fetch(`${url}/api/bills/mark`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId: 42, period: '2026-08', currency: 'usd', mode: 'full', amount: 2.68 }),
      });
      expect(response.status).toBe(201);
    });

    expect(prisma.bill.findFirst).toHaveBeenCalledWith({
      where: {
        period: '2026-08',
        currency: 'USD',
        OR: [{ cardId: 42 }, { cards: { some: { cardId: 42 } } }],
      },
    });
    expect(prisma.bill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cardId: 42,
        period: '2026-08',
        currency: 'USD',
        amount: 2.68,
        paidStatus: 'paid',
        paidAmount: 2.68,
      }),
    });
  });
});

describe('提醒卡片范围', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.card.findMany.mockResolvedValue([]);
    prisma.bill.findMany.mockResolvedValue([]);
    prisma.customReminder.findMany.mockResolvedValue([]);
    prisma.customReminderOccurrence.findMany.mockResolvedValue([]);
    prisma.customReminderOccurrence.createMany.mockResolvedValue({ count: 0 });
  });

  it('今日待办排除隐藏卡，但保留冻结卡的还款义务', async () => {
    await withServer('/api/reminders', remindersRouter, async (url) => {
      const response = await fetch(`${url}/api/reminders/todos`);
      expect(response.status).toBe(200);
    });

    expect(prisma.card.findMany).toHaveBeenCalledWith({ where: { hidden: false } });
  });

  it('未来提醒只加载正常使用且未隐藏的卡', async () => {
    await withServer('/api/reminders', remindersRouter, async (url) => {
      const response = await fetch(`${url}/api/reminders/upcoming`);
      expect(response.status).toBe(200);
    });

    expect(prisma.card.findMany).toHaveBeenCalledWith({ where: { status: 'active', hidden: false } });
    expect(prisma.bill.findMany).toHaveBeenCalledWith({
      where: { card: { hidden: false } },
      include: { cards: { select: { cardId: true } } },
    });
  });
});

describe('自定义提醒期次处理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.customReminderOccurrence.update.mockResolvedValue({});
    prisma.customReminderOccurrence.updateMany.mockResolvedValue({ count: 1 });
    prisma.customReminderOccurrence.createMany.mockResolvedValue({ count: 0 });
    prisma.customReminder.findMany.mockResolvedValue([]);
  });

  it('常规提醒只能标记完成', async () => {
    prisma.customReminderOccurrence.findUnique.mockResolvedValue({
      id: 9,
      businessType: 'general',
      status: 'open',
      suspended: false,
    });

    await withServer('/api/reminders', remindersRouter, async (url) => {
      const response = await fetch(`${url}/api/reminders/occurrences/9/complete`, { method: 'POST' });
      expect(response.status).toBe(200);
    });

    expect(prisma.customReminderOccurrence.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { status: 'completed', completedAt: expect.any(Date) },
    });
  });

  it('动态账单首次还款必须填写本期金额，且不接受部分还款动作', async () => {
    prisma.customReminderOccurrence.findUnique.mockResolvedValue({
      id: 10,
      businessType: 'dynamic_bill',
      status: 'open',
      suspended: false,
      amount: null,
    });

    await withServer('/api/reminders', remindersRouter, async (url) => {
      const missing = await fetch(`${url}/api/reminders/occurrences/10/paid`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'paid' }),
      });
      expect(missing.status).toBe(400);

      const partial = await fetch(`${url}/api/reminders/occurrences/10/paid`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'partial', amount: 88.6 }),
      });
      expect(partial.status).toBe(400);

      const paid = await fetch(`${url}/api/reminders/occurrences/10/paid`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'paid', amount: 88.6 }),
      });
      expect(paid.status).toBe(200);
    });

    expect(prisma.customReminderOccurrence.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { status: 'paid', amount: 88.6, completedAt: expect.any(Date) },
    });
  });

  it('恢复未还保留已经保存的金额', async () => {
    prisma.customReminderOccurrence.findUnique.mockResolvedValue({
      id: 11,
      businessType: 'dynamic_bill',
      status: 'paid',
      suspended: false,
      amount: 66,
    });

    await withServer('/api/reminders', remindersRouter, async (url) => {
      const response = await fetch(`${url}/api/reminders/occurrences/11/paid`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unpaid' }),
      });
      expect(response.status).toBe(200);
    });

    expect(prisma.customReminderOccurrence.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { status: 'open', completedAt: null },
    });
  });

  it('重新启用且只改名称备注时恢复原未处理项，不重建目标日期', async () => {
    prisma.customReminder.findUnique.mockResolvedValue({
      id: 12,
      name: '旧名称',
      businessType: 'general',
      type: 'monthly',
      interval: 1,
      anchorDate: fromYmd('2026-08-01'),
      dayOfWeek: null,
      dayOfMonth: 15,
      monthOfYear: null,
      specificDate: null,
      daysBefore: [3, 0],
      fixedAmount: null,
      note: null,
      enabled: false,
      disabledAt: fromYmd('2026-08-10'),
      hideOpenWhenDisabled: true,
    });
    prisma.customReminder.update.mockResolvedValue({});

    await withServer('/api/reminders', remindersRouter, async (url) => {
      const response = await fetch(`${url}/api/reminders/custom/12`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '新名称',
          businessType: 'general',
          type: 'monthly',
          interval: 1,
          dayOfWeek: null,
          dayOfMonth: 15,
          monthOfYear: null,
          specificDate: null,
          daysBefore: [3, 0],
          fixedAmount: null,
          note: '新备注',
          enabled: true,
        }),
      });
      expect(response.status).toBe(200);
    });

    expect(prisma.customReminderOccurrence.updateMany).toHaveBeenCalledWith({
      where: { reminderId: 12, status: 'open' },
      data: { suspended: false, name: '新名称', note: '新备注' },
    });
    expect(prisma.customReminderOccurrence.deleteMany).not.toHaveBeenCalled();
  });
});
