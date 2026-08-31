import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { fromYmd } from '../src/lib/dates';

const prisma = vi.hoisted(() => ({
  card: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  bill: { findMany: vi.fn() },
  $transaction: vi.fn(async (input: unknown) =>
    typeof input === 'function'
      ? (input as (tx: typeof prisma) => Promise<unknown>)(prisma)
      : Promise.all(input as Promise<unknown>[])),
}));
const recomputePrimary = vi.hoisted(() => vi.fn(async () => {}));
const allCardGroups = vi.hoisted(() => vi.fn(async () => new Map<number, number[]>()));
const requireValidPin = vi.hoisted(() => vi.fn(async () => Buffer.alloc(32, 7)));

vi.mock('../src/lib/prisma', () => ({ prisma }));
vi.mock('../src/lib/card-groups', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/card-groups')>();
  return { ...actual, recomputePrimary, allCardGroups };
});
vi.mock('../src/modules/auth/auth.service', () => ({ requireValidPin }));
vi.mock('../src/routes/middleware', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  COOKIE_NAME: 'drc_token',
}));

import cardsRouter from '../src/routes/cards.routes';
import { ApiError } from '../src/lib/errors';

function existingCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    bankName: '招商银行',
    cardLast4: '5678',
    holderName: null,
    nickname: null,
    currency: 'CNY',
    statementDay: 5,
    dueRule: 'offset',
    dueDay: null,
    dueOffsetDays: 18,
    remindDaysBefore: [3, 1, 0],
    status: 'active',
    businessRole: 'standalone',
    businessPrimaryId: null,
    ...overrides,
  };
}

async function withServer(run: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/cards', cardsRouter);
  app.use((err: Error & { status?: number; issues?: unknown }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // zod 校验错误（与真实应用全局错误处理一致）
    if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown }).issues)) {
      const issues = (err as { issues: Array<{ message: string; path: Array<string | number> }> }).issues;
      const detail = issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      res.status(400).json({ error: detail || '参数校验失败' });
      return;
    }
    res.status(err.status ?? 500).json({ error: err.message });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe('GET /api/cards 多币种本期账单', () => {
  it('多张账单中只有一张待还时显示该币种金额', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T04:00:00.000Z'));
    const card = existingCard({
      id: 2,
      displayLast4: '5678',
      statementDay: 19,
      dueRule: 'fixed',
      dueDay: 8,
      dueOffsetDays: null,
      hidden: false,
      createdAt: fromYmd('2026-01-01'),
      remindDaysBefore: [3, 1, 0],
    });
    prisma.card.findMany.mockResolvedValue([card]);
    prisma.bill.findMany.mockResolvedValue([
      {
        id: 100,
        cardId: 2,
        period: '2026-08',
        statementDate: fromYmd('2026-08-19'),
        dueDate: fromYmd('2026-09-08'),
        amount: 100,
        minAmount: 10,
        currency: 'CNY',
        paidStatus: 'paid',
        cards: [],
      },
      {
        id: 101,
        cardId: 2,
        period: '2026-08',
        statementDate: fromYmd('2026-08-19'),
        dueDate: fromYmd('2026-09-08'),
        amount: 2.68,
        minAmount: 0.14,
        currency: 'USD',
        paidStatus: 'unpaid',
        cards: [],
      },
    ]);
    allCardGroups.mockResolvedValue(new Map([[2, [2]]]));

    try {
      await withServer(async (url) => {
        const response = await fetch(`${url}/api/cards`);
        expect(response.status).toBe(200);
        const rows = await response.json() as Array<{ currentCycle: Record<string, unknown> }>;
        expect(rows[0]?.currentCycle).toMatchObject({
          amount: 2.68,
          minAmount: 0.14,
          currency: 'USD',
          paidStatus: 'unpaid',
          billCount: 2,
          unpaidBillCount: 1,
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PUT /api/cards/:id 保存后归组检查', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.card.findUnique.mockResolvedValue(existingCard());
    prisma.card.update.mockResolvedValue(existingCard({ statementDay: 10 }));
    recomputePrimary.mockResolvedValue(undefined);
  });

  it('改出账日/还款规则后触发 recomputePrimary（拆组后立即重标 isPrimary）', async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statementDay: 10 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
    expect(prisma.card.update).toHaveBeenCalled();
    expect(recomputePrimary).toHaveBeenCalledTimes(1);
  });

  it('只改别名不触发归组重算', async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: '金卡' }),
      });
      expect(res.status).toBe(200);
    });
    expect(recomputePrimary).not.toHaveBeenCalled();
  });

  it('改状态为冻结触发 recomputePrimary（主卡让位）', async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'frozen' }),
      });
      expect(res.status).toBe(200);
    });
    expect(recomputePrimary).toHaveBeenCalledTimes(1);
  });

  it('副卡拒绝修改账单设置和继承的持卡人', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({
      businessRole: 'secondary',
      businessPrimaryId: 1,
    }));
    await withServer(async (url) => {
      const billing = await fetch(`${url}/api/cards/2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statementDay: 10 }),
      });
      expect(billing.status).toBe(400);

      const holder = await fetch(`${url}/api/cards/2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ holderName: '李四' }),
      });
      expect(holder.status).toBe(400);
      expect(await holder.json()).toEqual({ error: '副卡持卡人由主卡统一管理' });
    });
  });

  it('主卡持卡人与状态会同步到整组副卡', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({ businessRole: 'primary' }));
    await withServer(async (url) => {
      const response = await fetch(`${url}/api/cards/2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ holderName: '李泽南', status: 'frozen' }),
      });
      expect(response.status).toBe(200);
    });
    expect(prisma.card.updateMany).toHaveBeenCalledWith({
      where: { businessPrimaryId: 2, businessRole: 'secondary' },
      data: { holderName: '李泽南' },
    });
    expect(prisma.card.updateMany).toHaveBeenCalledWith({
      where: { businessPrimaryId: 2 },
      data: { status: 'frozen' },
    });
  });
});

describe('POST /api/cards/:id/primary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.card.update.mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (input: unknown) => Promise.all(input as Promise<unknown>[]));
    allCardGroups.mockResolvedValue(new Map([[1, [1, 2]]]));
  });

  it('冻结卡不能手动设为优先展示', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({ id: 2, status: 'frozen' }));
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2/primary`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: '已冻结或已注销的卡不能设为优先展示' });
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('身份 ---- 卡可以手动设为优先展示', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({ id: 2, cardLast4: '----', status: 'active' }));
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2/primary`, { method: 'POST' });
      expect(res.status).toBe(200);
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(recomputePrimary).toHaveBeenCalledTimes(1);
  });

  it('隐藏卡不能设为优先展示', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({ id: 2, hidden: true, status: 'active' }));
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2/primary`, { method: 'POST' });
      expect(res.status).toBe(404);
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PUT /api/cards/:id 编辑接口拒收后四位', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.card.findUnique.mockResolvedValue(existingCard());
    prisma.card.update.mockResolvedValue(existingCard());
    recomputePrimary.mockResolvedValue(undefined);
  });

  it('传入 cardLast4 即 400 拒绝，不写入任何字段', async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardLast4: '9999' }),
      });
      expect(res.status).toBe(400);
    });
    expect(prisma.card.update).not.toHaveBeenCalled();
  });

  it('传入与现值相同的 cardLast4 同样拒绝', async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardLast4: '5678', nickname: '金卡' }),
      });
      expect(res.status).toBe(400);
    });
    expect(prisma.card.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/cards/:id/secret 完整卡号保存闸门', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.card.update.mockResolvedValue({});
    requireValidPin.mockResolvedValue(Buffer.alloc(32, 7));
  });

  it('匹配尾号已是真号：后四位一致通过', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({ cardLast4: '5678', displayLast4: '5678' }));
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2/secret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '123456', cardNoFull: '4111110000055678' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
    expect(prisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 2 },
        data: expect.not.objectContaining({ displayLast4: expect.anything() }),
      }),
    );
  });

  it('匹配尾号已是真号：后四位不符拒绝且不写入', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({ cardLast4: '5678', displayLast4: '5678' }));
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2/secret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '123456', cardNoFull: '4111110000099999' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('与本次录入的完整卡号不符');
    });
    expect(prisma.card.update).not.toHaveBeenCalled();
  });

  it('占位卡首次完善：完整卡号后四位写入展示尾号', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({ cardLast4: '----', displayLast4: '----' }));
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2/secret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '123456', cardNoFull: '4111110000033378' }),
      });
      expect(res.status).toBe(200);
    });
    expect(prisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ displayLast4: '3378' }) }),
    );
  });

  it('占位卡重复完善：展示尾号已有四位且后四位变更拒绝', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({ cardLast4: '----', displayLast4: '3378' }));
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2/secret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '123456', cardNoFull: '4111110000099999' }),
      });
      expect(res.status).toBe(400);
    });
    expect(prisma.card.update).not.toHaveBeenCalled();
  });

  it('占位卡重复完善：回填原值（后四位不变）放行，改有效期/CVV 不被卡号闸门拦截', async () => {
    prisma.card.findUnique.mockResolvedValue(existingCard({ cardLast4: '----', displayLast4: '3378' }));
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/cards/2/secret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '123456', cardNoFull: '4111110000033378', expDate: '12/28' }),
      });
      expect(res.status).toBe(200);
    });
    expect(prisma.card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ displayLast4: expect.anything() }) }),
    );
  });
});
