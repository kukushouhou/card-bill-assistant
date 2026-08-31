import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import { buildLedger, buildTrend, type LedgerBillInput, type LedgerCard } from '../modules/bills/ledger';
import { remainingOf } from '../modules/bills/paid';
import { computeCycle, type CardLike } from '../modules/reminders/reminder.engine';
import { today } from '../lib/dates';
import { materializeCustomReminderOccurrences } from '../modules/reminders/custom-occurrences';
import { customBillTrendRows, customBillView, sortCombinedBillRows } from '../modules/bills/custom-bills';
import { normalizeCurrency } from '../parsers/_util';

const router = Router();
router.use(requireAuth);

/** 卡范围筛选：cardId 精确 / cardIds 套卡组 / bank 银行名；都缺省 = 全部 */
async function loadScopeCards(cardId?: number, bank?: string, cardIds?: number[]): Promise<LedgerCard[]> {
  const where = {
    hidden: false,
    ...(cardId != null
      ? { id: cardId }
      : cardIds?.length
        ? { id: { in: cardIds } }
        : bank
          ? { bankName: bank }
          : {}),
  };
  const cards = await prisma.card.findMany({ where });
  return cards.map((c) => ({
    id: c.id,
    bankName: c.bankName,
    cardLast4: c.cardLast4,
    currency: c.currency,
    statementDay: c.statementDay,
    dueRule: c.dueRule,
    dueDay: c.dueDay,
    dueOffsetDays: c.dueOffsetDays,
    status: c.status,
    createdAt: c.createdAt,
    businessRole: c.businessRole,
    businessPrimaryId: c.businessPrimaryId,
  }));
}

function parseCardIdsQuery(value: unknown): number[] | undefined {
  if (value == null || value === '') return undefined;
  const values = String(value).split(',').map((part) => Number(part));
  if (values.length === 0 || values.length > 50 || values.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new ApiError(400, '非法套卡 ID');
  }
  return [...new Set(values)];
}

/** 范围内账单（自有 or 合并关联），归一化为台账输入行 */
async function loadScopeBills(cardIds: number[]): Promise<LedgerBillInput[]> {
  if (cardIds.length === 0) return [];
  const rows = await prisma.bill.findMany({
    where: { OR: [{ cardId: { in: cardIds } }, { cards: { some: { cardId: { in: cardIds } } } }] },
    include: { cards: { select: { cardId: true } } },
  });
  return rows.map((b) => ({
    id: b.id,
    cardId: b.cardId,
    period: b.period,
    statementDate: b.statementDate,
    dueDate: b.dueDate,
    amount: b.amount != null ? Number(b.amount) : null,
    minAmount: b.minAmount != null ? Number(b.minAmount) : null,
    currency: b.currency,
    paidStatus: b.paidStatus,
    paidAt: b.paidAt,
    paidAmount: b.paidAmount != null ? Number(b.paidAmount) : null,
    hasDetails: b.hasDetails,
    annualFeeAmount: b.annualFeeAmount != null ? Number(b.annualFeeAmount) : null,
    source: b.source,
    linkedCardIds: [b.cardId, ...b.cards.map((bc) => bc.cardId)].filter(
      (id, idx, arr) => arr.indexOf(id) === idx,
    ),
  }));
}

// 完整台账：真实账单 + 未取得账单占位行（未还清在前按还款日升序，历史在后倒序）
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const cardId = req.query.cardId ? Number(req.query.cardId) : undefined;
    const cardIds = parseCardIdsQuery(req.query.cardIds);
    const bank = req.query.bank ? String(req.query.bank) : undefined;
    if (cardId != null && !Number.isInteger(cardId)) throw new ApiError(400, '非法卡片 ID');
    if (cardIds && (cardId != null || bank)) throw new ApiError(400, '卡片筛选条件不能同时使用');
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const includeCustom = cardId == null && !cardIds && !bank;
    const now = today();
    if (includeCustom) await materializeCustomReminderOccurrences(now);

    const [scopeCards, allCards, customRows] = await Promise.all([
      loadScopeCards(cardId, bank, cardIds),
      prisma.card.findMany(),
      includeCustom
        ? prisma.customReminderOccurrence.findMany({
            where: { businessType: { in: ['fixed_bill', 'dynamic_bill'] }, suspended: false },
          })
        : Promise.resolve([]),
    ]);
    const bills = await loadScopeBills(scopeCards.map((c) => c.id));

    const allLedgerCards: LedgerCard[] = allCards.map((c) => ({
      id: c.id,
      bankName: c.bankName,
      cardLast4: c.cardLast4,
      currency: c.currency,
      statementDay: c.statementDay,
      dueRule: c.dueRule,
      dueDay: c.dueDay,
      dueOffsetDays: c.dueOffsetDays,
      status: c.status,
      createdAt: c.createdAt,
      businessRole: c.businessRole,
      businessPrimaryId: c.businessPrimaryId,
    }));

    const cardRows = buildLedger(scopeCards, allLedgerCards, bills).map((row) => ({
      ...row,
      recordType: 'card' as const,
      customOccurrenceId: null,
      customReminderId: null,
      customBusinessType: null,
      customName: null,
      note: null,
    }));
    const rows = sortCombinedBillRows([
      ...cardRows,
      ...customRows.map((row) => customBillView(row, now)),
    ]);
    const start = (page - 1) * pageSize;
    const items = rows.slice(start, start + pageSize);

    res.json({
      total: rows.length,
      page,
      pageSize,
      items: items.map((row) => ({
        ...row,
        statementDate: row.statementDate?.toISOString() ?? null,
        dueDate: row.dueDate.toISOString(),
        paidAt: row.paidAt?.toISOString() ?? null,
      })),
    });
  }),
);

// 金额走势：未选卡=全部账单、选银行=该银行、选卡片=该卡片各期（合并账单只计一次）
router.get(
  '/trend',
  asyncHandler(async (req, res) => {
    const cardId = req.query.cardId ? Number(req.query.cardId) : undefined;
    const bank = req.query.bank ? String(req.query.bank) : undefined;
    const months = Math.min(60, Math.max(1, Number(req.query.months) || 12));
    const requestedCurrency = req.query.currency ? normalizeCurrency(String(req.query.currency)) : undefined;
    if (cardId != null && !Number.isInteger(cardId)) throw new ApiError(400, '非法卡片 ID');

    const scopeCards = await loadScopeCards(cardId, bank);
    const bills = await loadScopeBills(scopeCards.map((c) => c.id));
    const currencies = Array.from(new Set([
      ...bills.map((bill) => bill.currency),
      ...(cardId == null && !bank ? ['CNY'] : []),
    ])).sort((a, b) => (a === 'CNY' ? -1 : b === 'CNY' ? 1 : a.localeCompare(b)));
    const currency = requestedCurrency && currencies.includes(requestedCurrency)
      ? requestedCurrency
      : currencies[0] ?? 'CNY';
    const items = buildTrend(bills, months, today(), currency);
    if (cardId == null && !bank && currency === 'CNY') {
      await materializeCustomReminderOccurrences();
      const customRows = await prisma.customReminderOccurrence.findMany({
        where: { businessType: { in: ['fixed_bill', 'dynamic_bill'] }, suspended: false },
      });
      const customByPeriod = new Map<string, { total: number; count: number }>();
      for (const row of customBillTrendRows(customRows)) {
        const entry = customByPeriod.get(row.period) ?? { total: 0, count: 0 };
        if (row.amount != null) entry.total += row.amount;
        entry.count++;
        customByPeriod.set(row.period, entry);
      }
      for (const item of items) {
        const custom = customByPeriod.get(item.period);
        if (!custom) continue;
        item.total = Math.round(((item.total ?? 0) + custom.total) * 100) / 100;
        item.count += custom.count;
      }
    }
    res.json({ months, currency, currencies, items });
  }),
);

// 标记未取得账单的期次（无需还款 / 全部还清 / 部分已还），创建手动账单；后续邮件账单到达会覆盖金额
router.post(
  '/mark',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        cardId: z.number().int().positive(),
        period: z.string().regex(/^\d{4}-\d{2}$/, '期次格式应为 YYYY-MM'),
        mode: z.enum(['none', 'full', 'partial']),
        amount: z.number().min(0, '金额不能为负').max(99_999_999).optional(),
        paidAmount: z.number().min(0, '已还金额不能为负').max(99_999_999).optional(),
        currency: z.string().trim().regex(/^[A-Za-z]{3}$/, '币种应为三位代码').optional(),
      })
      .parse(req.body);

    if (input.mode === 'full' && input.amount == null) throw new ApiError(400, '请填写应还金额');
    if (input.mode === 'partial') {
      if (input.amount == null) throw new ApiError(400, '请填写应还金额');
      if (input.paidAmount == null) throw new ApiError(400, '请填写已还金额');
      if (input.paidAmount >= input.amount)
        throw new ApiError(400, '已还金额应小于应还金额，全部结清请选择「全部已还清」');
    }

    const card = await prisma.card.findUnique({ where: { id: input.cardId } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    if (card.businessPrimaryId != null) {
      throw new ApiError(400, '副卡和附属卡的账单由主卡统一管理');
    }
    if (card.status !== 'active') {
      const statusName = card.status === 'frozen' ? '冻结' : '注销';
      throw new ApiError(400, `卡片已${statusName}，不能补录新账单`);
    }

    const currency = normalizeCurrency(input.currency ?? card.currency);

    const existed = await prisma.bill.findFirst({
      where: {
        period: input.period,
        currency,
        OR: [{ cardId: card.id }, { cards: { some: { cardId: card.id } } }],
      },
    });
    if (existed) throw new ApiError(400, '该期已有账单记录，请在账单行上直接标记');

    const cardLike: CardLike = {
      id: card.id,
      bankName: card.bankName,
      cardLast4: card.cardLast4,
      statementDay: card.statementDay,
      dueRule: card.dueRule,
      dueDay: card.dueDay,
      dueOffsetDays: card.dueOffsetDays,
      remindDaysBefore: (card.remindDaysBefore as number[]) ?? [3, 1, 0],
      status: card.status,
    };
    const year = Number(input.period.slice(0, 4));
    const month = Number(input.period.slice(5, 7));
    const cycle = computeCycle(cardLike, year, month, null);

    // none（无需还款）→ 0 元已结清；full → 全额已结清；partial 0 元 = 没还过（unpaid）；其余 partial
    const isPartialZero = input.mode === 'partial' && input.paidAmount === 0;
    const paidStatus = isPartialZero ? 'unpaid' : input.mode === 'partial' ? 'partial' : 'paid';
    const amount = input.mode === 'none' ? 0 : input.amount!;
    const paidAmount = isPartialZero ? null : input.mode === 'partial' ? input.paidAmount! : amount;

    const bill = await prisma.bill.create({
      data: {
        cardId: card.id,
        period: input.period,
        statementDate: cycle.statementDate,
        dueDate: cycle.dueDate,
        amount,
        minAmount: null,
        currency,
        paidStatus,
        paidAt: paidStatus === 'unpaid' ? null : new Date(),
        paidAmount,
        hasDetails: false,
        source: 'manual',
      },
    });
    res.status(201).json({ id: bill.id });
  }),
);

// 查看已持久化交易明细
router.get(
  '/:id/details',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ApiError(400, '非法账单 ID');
    const bill = await prisma.bill.findUnique({
      where: { id },
      include: { transactions: { orderBy: { sequence: 'asc' } } },
    });
    if (!bill) throw new ApiError(404, '账单不存在');
    res.json({
      period: bill.period,
      currency: bill.currency,
      annualFeeAmount: bill.annualFeeAmount == null ? null : Number(bill.annualFeeAmount),
      transactions: bill.transactions.map((transaction) => ({
        id: transaction.id,
        date: transaction.dateText,
        transactionDate: transaction.transactionDate?.toISOString() ?? null,
        description: transaction.description,
        amount: Number(transaction.amount),
        currency: transaction.currency,
        originalAmount: transaction.originalAmount == null ? null : Number(transaction.originalAmount),
        originalCurrency: transaction.originalCurrency,
        cardLast4: transaction.cardLast4,
      })),
    });
  }),
);

// 标记还款状态：全部还清 / 部分已还（填金额）/ 恢复未还（合并账单一次标记全组生效）
router.put(
  '/:id/paid',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const bill = await prisma.bill.findUnique({ where: { id } });
    if (!bill) throw new ApiError(404, '账单不存在');
    const input = z
      .object({
        action: z.enum(['full', 'partial', 'unpaid']),
        paidAmount: z.number().min(0, '已还金额不能为负').max(99_999_999).optional(),
      })
      .parse(req.body);

    const amount = bill.amount != null ? Number(bill.amount) : null;
    const now = new Date();

    if (input.action === 'unpaid') {
      await prisma.bill.update({
        where: { id },
        data: { paidStatus: 'unpaid', paidAt: null, paidAmount: null },
      });
    } else if (input.action === 'full' || (input.paidAmount != null && amount != null && input.paidAmount >= amount)) {
      // full，或 partial 金额 ≥ 应还金额时自动升级为全部结清（金额未知无法比较时按 partial 存）
      await prisma.bill.update({
        where: { id },
        data: { paidStatus: 'paid', paidAt: now, paidAmount: amount },
      });
    } else {
      if (input.paidAmount == null) throw new ApiError(400, '部分已还需填写已还金额');
      if (!Number.isFinite(input.paidAmount) || input.paidAmount < 0) throw new ApiError(400, '已还金额须为非负数');
      if (input.paidAmount === 0) {
        await prisma.bill.update({
          where: { id },
          data: { paidStatus: 'unpaid', paidAt: null, paidAmount: null },
        });
      } else {
        await prisma.bill.update({
          where: { id },
          data: { paidStatus: 'partial', paidAt: now, paidAmount: input.paidAmount },
        });
      }
    }
    res.json({ ok: true });
  }),
);

// 删除账单
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const bill = await prisma.bill.findUnique({ where: { id } });
    if (!bill) throw new ApiError(404, '账单不存在');
    await prisma.bill.delete({ where: { id } });
    res.json({ ok: true });
  }),
);

// 台账统计（当前筛选范围合计，排除未取得占位行）
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const cardId = req.query.cardId ? Number(req.query.cardId) : undefined;
    const bank = req.query.bank ? String(req.query.bank) : undefined;
    if (cardId != null && !Number.isInteger(cardId)) throw new ApiError(400, '非法卡片 ID');
    if (cardId == null && !bank) await materializeCustomReminderOccurrences();

    const scopeCards = await loadScopeCards(cardId, bank);
    const bills = await loadScopeBills(scopeCards.map((c) => c.id));
    const real = bills.filter((b) => b.amount != null);
    const customRows = cardId == null && !bank
      ? await prisma.customReminderOccurrence.findMany({
          where: { businessType: { in: ['fixed_bill', 'dynamic_bill'] }, suspended: false },
        })
      : [];
    const byCurrency = new Map<string, { totalAmount: number; unpaidCount: number; unpaidTotal: number }>();
    for (const bill of real) {
      const entry = byCurrency.get(bill.currency) ?? { totalAmount: 0, unpaidCount: 0, unpaidTotal: 0 };
      entry.totalAmount += bill.amount ?? 0;
      if (bill.paidStatus !== 'paid') {
        entry.unpaidCount++;
        entry.unpaidTotal += remainingOf(bill);
      }
      byCurrency.set(bill.currency, entry);
    }
    const customKnown = customRows.filter((row) => row.amount != null);
    const customUnpaid = customRows.filter((row) => row.status !== 'paid');
    if (customKnown.length > 0 || customUnpaid.length > 0) {
      const entry = byCurrency.get('CNY') ?? { totalAmount: 0, unpaidCount: 0, unpaidTotal: 0 };
      entry.totalAmount += customKnown.reduce((sum, row) => sum + Number(row.amount), 0);
      entry.unpaidCount += customUnpaid.length;
      entry.unpaidTotal += customUnpaid.reduce((sum, row) => sum + (row.amount == null ? 0 : Number(row.amount)), 0);
      byCurrency.set('CNY', entry);
    }
    const totalsByCurrency = [...byCurrency.entries()]
      .map(([currency, value]) => ({
        currency,
        totalAmount: Math.round(value.totalAmount * 100) / 100,
        unpaidCount: value.unpaidCount,
        unpaidTotal: Math.round(value.unpaidTotal * 100) / 100,
      }))
      .sort((a, b) => (a.currency === 'CNY' ? -1 : b.currency === 'CNY' ? 1 : a.currency.localeCompare(b.currency)));
    const cny = totalsByCurrency.find((entry) => entry.currency === 'CNY');
    res.json({
      billCount: bills.length + customRows.length,
      totalAmount: cny?.totalAmount ?? 0,
      unpaidCount: totalsByCurrency.reduce((sum, entry) => sum + entry.unpaidCount, 0),
      unpaidTotal: cny?.unpaidTotal ?? 0,
      totalsByCurrency,
      unknownAmountCount: customRows.filter((row) => row.amount == null).length,
    });
  }),
);

export default router;
