import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import { addDays, fromYmd, today, ymd } from '../lib/dates';
import { buildBillsByCard, collectTodayEvents, collectUpcoming, type CardLike, type CustomReminderLike } from '../modules/reminders/reminder.engine';
import { collectTodoItems } from '../modules/reminders/todos';
import type { LedgerBillInput, LedgerCard } from '../modules/bills/ledger';
import {
  customOccurrenceDaysOverdue,
  materializeCustomReminderOccurrences,
  occurrenceToView,
  syncOpenCustomReminderOccurrences,
} from '../modules/reminders/custom-occurrences';
import { nextCustomTargetDates, scheduleFromInput } from '../modules/reminders/custom-schedule';

const router = Router();
router.use(requireAuth);

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const customSchema = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(64),
    businessType: z.enum(['general', 'fixed_bill', 'dynamic_bill']),
    type: z.enum(['once', 'daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1, '周期必须大于 0').max(999).default(1),
    dayOfWeek: z.number().int().min(1).max(7).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    monthOfYear: z.number().int().min(1).max(12).nullable().optional(),
    specificDate: ymdSchema.nullable().optional(),
    daysBefore: z.array(z.number().int().min(0).max(60)).max(20).default([3, 0]),
    fixedAmount: z.number().positive('固定金额必须大于 0').max(99_999_999).nullable().optional(),
    note: z.string().trim().max(255).nullable().optional(),
    enabled: z.boolean().default(true),
    disableMode: z.enum(['keep_open', 'suspend_open']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'once' && !value.specificDate) {
      ctx.addIssue({ code: 'custom', path: ['specificDate'], message: '请选择日期' });
    } else if (value.type === 'once' && value.specificDate && fromYmd(value.specificDate) < today()) {
      ctx.addIssue({ code: 'custom', path: ['specificDate'], message: '日期不能早于今天' });
    }
    if (value.type === 'weekly' && !value.dayOfWeek) {
      ctx.addIssue({ code: 'custom', path: ['dayOfWeek'], message: '请选择星期' });
    }
    if (value.type === 'monthly' && !value.dayOfMonth) {
      ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: '请选择每月日期' });
    }
    if (value.type === 'yearly' && (!value.monthOfYear || !value.dayOfMonth)) {
      ctx.addIssue({ code: 'custom', path: ['monthOfYear'], message: '请选择月日' });
    }
    if (value.businessType === 'fixed_bill' && value.fixedAmount == null) {
      ctx.addIssue({ code: 'custom', path: ['fixedAmount'], message: '请输入固定金额' });
    }
  });

type CustomInput = z.infer<typeof customSchema>;

const customPreviewSchema = z
  .object({
    type: z.enum(['once', 'daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).max(999).default(1),
    dayOfWeek: z.number().int().min(1).max(7).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    monthOfYear: z.number().int().min(1).max(12).nullable().optional(),
    specificDate: ymdSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'once' && !value.specificDate) {
      ctx.addIssue({ code: 'custom', path: ['specificDate'], message: '请选择日期' });
    } else if (value.type === 'once' && value.specificDate && fromYmd(value.specificDate) < today()) {
      ctx.addIssue({ code: 'custom', path: ['specificDate'], message: '日期不能早于今天' });
    }
    if (value.type === 'weekly' && !value.dayOfWeek) {
      ctx.addIssue({ code: 'custom', path: ['dayOfWeek'], message: '请选择星期' });
    }
    if (value.type === 'monthly' && !value.dayOfMonth) {
      ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: '请选择每月日期' });
    }
    if (value.type === 'yearly' && (!value.monthOfYear || !value.dayOfMonth)) {
      ctx.addIssue({ code: 'custom', path: ['monthOfYear'], message: '请选择月日' });
    }
  });

function cleanDaysBefore(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => b - a);
}

function scheduleFieldsChanged(existing: {
  type: string;
  interval: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  monthOfYear: number | null;
  specificDate: Date | null;
}, input: CustomInput): boolean {
  return existing.type !== input.type
    || existing.interval !== input.interval
    || existing.dayOfWeek !== (input.type === 'weekly' ? input.dayOfWeek ?? null : null)
    || existing.dayOfMonth !== (input.type === 'monthly' || input.type === 'yearly' ? input.dayOfMonth ?? null : null)
    || existing.monthOfYear !== (input.type === 'yearly' ? input.monthOfYear ?? null : null)
    || (existing.specificDate ? ymd(existing.specificDate) : null) !== (input.type === 'once' ? input.specificDate ?? null : null);
}

function customData(input: CustomInput, anchorDate?: Date) {
  return {
    name: input.name,
    businessType: input.businessType,
    type: input.type,
    interval: input.type === 'once' ? 1 : input.interval,
    ...(anchorDate ? { anchorDate } : {}),
    dayOfWeek: input.type === 'weekly' ? input.dayOfWeek ?? null : null,
    dayOfMonth: input.type === 'monthly' || input.type === 'yearly' ? input.dayOfMonth ?? null : null,
    monthOfYear: input.type === 'yearly' ? input.monthOfYear ?? null : null,
    specificDate: input.type === 'once' && input.specificDate ? fromYmd(input.specificDate) : null,
    daysBefore: cleanDaysBefore(input.daysBefore),
    fixedAmount: input.businessType === 'fixed_bill' ? input.fixedAmount : null,
    note: input.note || null,
    enabled: input.enabled,
  };
}

function customView(reminder: {
  id: number;
  name: string;
  businessType: string;
  type: string;
  interval: number;
  anchorDate: Date;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  monthOfYear: number | null;
  specificDate: Date | null;
  daysBefore: unknown;
  fixedAmount: unknown;
  note: string | null;
  enabled: boolean;
}) {
  const nextDates = nextCustomTargetDates(reminder, today(), 3).map(ymd);
  return {
    id: reminder.id,
    name: reminder.name,
    businessType: reminder.businessType,
    type: reminder.type,
    interval: reminder.interval,
    dayOfWeek: reminder.dayOfWeek,
    dayOfMonth: reminder.dayOfMonth,
    monthOfYear: reminder.monthOfYear,
    specificDate: reminder.specificDate ? ymd(reminder.specificDate) : null,
    daysBefore: (reminder.daysBefore as number[]) ?? [],
    fixedAmount: reminder.fixedAmount == null ? null : Number(reminder.fixedAmount),
    note: reminder.note,
    enabled: reminder.enabled,
    nextDates,
  };
}

router.post('/custom/preview', asyncHandler(async (req, res) => {
  const input = customPreviewSchema.parse(req.body);
  const dates = nextCustomTargetDates(scheduleFromInput({ ...input, anchorDate: today() }), today(), 3).map(ymd);
  res.json({ dates });
}));

router.get('/custom', asyncHandler(async (_req, res) => {
  const list = await prisma.customReminder.findMany({ orderBy: { id: 'desc' } });
  res.json(list.map(customView));
}));

router.post('/custom', asyncHandler(async (req, res) => {
  const input = customSchema.parse(req.body);
  const now = today();
  const created = await prisma.customReminder.create({
    data: {
      ...customData(input, now),
      disabledAt: input.enabled ? null : now,
      hideOpenWhenDisabled: !input.enabled,
    },
  });
  if (input.enabled) await materializeCustomReminderOccurrences(now, [created.id]);
  res.status(201).json({ id: created.id });
}));

router.put('/custom/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new ApiError(400, '非法提醒 ID');
  const existing = await prisma.customReminder.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, '提醒不存在');
  const input = customSchema.parse(req.body);
  if (existing.enabled && !input.enabled && !input.disableMode) {
    throw new ApiError(400, '停用时请选择如何处理当前未处理项');
  }

  const now = today();
  const scheduleChanged = scheduleFieldsChanged(existing, input);
  const daysChanged = JSON.stringify(cleanDaysBefore((existing.daysBefore as number[]) ?? []))
    !== JSON.stringify(cleanDaysBefore(input.daysBefore));
  const billRuleChanged = existing.businessType !== input.businessType
    || Number(existing.fixedAmount ?? 0) !== Number(input.businessType === 'fixed_bill' ? input.fixedAmount ?? 0 : 0);
  const enabling = !existing.enabled && input.enabled;
  const disabling = existing.enabled && !input.enabled;
  await prisma.customReminder.update({
    where: { id },
    data: {
      ...customData(input, scheduleChanged || enabling ? now : undefined),
      disabledAt: input.enabled ? null : disabling ? now : existing.disabledAt ?? now,
      hideOpenWhenDisabled: input.enabled
        ? false
        : disabling
          ? input.disableMode === 'suspend_open'
          : existing.hideOpenWhenDisabled,
    },
  });

  if (enabling) {
    if (scheduleChanged || daysChanged || billRuleChanged) {
      await syncOpenCustomReminderOccurrences(id, now);
    } else {
      await prisma.customReminderOccurrence.updateMany({
        where: { reminderId: id, status: 'open' },
        data: { suspended: false, name: input.name, note: input.note || null },
      });
      await materializeCustomReminderOccurrences(now, [id]);
    }
  } else {
    await syncOpenCustomReminderOccurrences(id, now);
  }
  res.json({ ok: true });
}));

router.delete('/custom/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.customReminder.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, '提醒不存在');
  await prisma.$transaction(async (tx) => {
    await tx.customReminderOccurrence.deleteMany({ where: { reminderId: id, status: 'open' } });
    await tx.customReminder.delete({ where: { id } });
  });
  res.json({ ok: true });
}));

router.post('/occurrences/:id/complete', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const occurrence = await prisma.customReminderOccurrence.findUnique({ where: { id } });
  if (!occurrence || occurrence.suspended) throw new ApiError(404, '提醒期次不存在');
  if (occurrence.businessType !== 'general') throw new ApiError(400, '该期次应使用还款操作');
  if (occurrence.status !== 'open') throw new ApiError(400, '该提醒已经完成');
  await prisma.customReminderOccurrence.update({
    where: { id },
    data: { status: 'completed', completedAt: new Date() },
  });
  res.json({ ok: true });
}));

router.put('/occurrences/:id/paid', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({
    action: z.enum(['paid', 'unpaid']),
    amount: z.number().min(0, '金额不能为负').max(99_999_999).optional(),
  }).parse(req.body);
  const occurrence = await prisma.customReminderOccurrence.findUnique({ where: { id } });
  if (!occurrence || occurrence.suspended) throw new ApiError(404, '账单期次不存在');
  if (occurrence.businessType !== 'fixed_bill' && occurrence.businessType !== 'dynamic_bill') {
    throw new ApiError(400, '该期次不是账单');
  }
  if (input.action === 'unpaid') {
    await prisma.customReminderOccurrence.update({ where: { id }, data: { status: 'open', completedAt: null } });
    res.json({ ok: true });
    return;
  }
  const amount = occurrence.businessType === 'dynamic_bill'
    ? input.amount ?? (occurrence.amount == null ? null : Number(occurrence.amount))
    : occurrence.amount == null ? null : Number(occurrence.amount);
  if (amount == null) throw new ApiError(400, '请输入本期账单金额');
  await prisma.customReminderOccurrence.update({
    where: { id },
    data: { status: 'paid', amount, completedAt: new Date() },
  });
  res.json({ ok: true });
}));

router.get('/todos', asyncHandler(async (_req, res) => {
  const now = today();
  await materializeCustomReminderOccurrences(now);
  const [cards, billRows, customRows] = await Promise.all([
    prisma.card.findMany({ where: { hidden: false } }),
    prisma.bill.findMany({ include: { cards: { select: { cardId: true } } } }),
    prisma.customReminderOccurrence.findMany({
      where: { status: 'open', suspended: false, targetDate: { lt: addDays(now, 3) } },
    }),
  ]);

  const ledgerCards: LedgerCard[] = cards.map((card) => ({
    id: card.id,
    bankName: card.bankName,
      cardLast4: card.cardLast4,
      currency: card.currency,
    statementDay: card.statementDay,
    dueRule: card.dueRule,
    dueDay: card.dueDay,
    dueOffsetDays: card.dueOffsetDays,
    status: card.status,
    createdAt: card.createdAt,
  }));
  const ledgerBills: LedgerBillInput[] = billRows.map((bill) => ({
    id: bill.id,
    cardId: bill.cardId,
    period: bill.period,
    statementDate: bill.statementDate,
    dueDate: bill.dueDate,
    amount: bill.amount != null ? Number(bill.amount) : null,
      minAmount: bill.minAmount != null ? Number(bill.minAmount) : null,
      currency: bill.currency,
    paidStatus: bill.paidStatus,
    paidAt: bill.paidAt,
    paidAmount: bill.paidAmount != null ? Number(bill.paidAmount) : null,
    hasDetails: bill.hasDetails,
    annualFeeAmount: bill.annualFeeAmount != null ? Number(bill.annualFeeAmount) : null,
    source: bill.source,
    linkedCardIds: [bill.cardId, ...bill.cards.map((card) => card.cardId)].filter(
      (value, index, values) => values.indexOf(value) === index,
    ),
  }));

  const cardItems = collectTodoItems(ledgerCards, ledgerCards, ledgerBills, now).map((item) => ({
    ...item,
    recordType: 'card' as const,
    action: 'card_payment' as const,
    statementDate: item.statementDate.toISOString(),
    dueDate: item.dueDate.toISOString(),
  }));
  const customItems = customRows.map(occurrenceToView).map((occurrence) => ({
    recordType: 'custom' as const,
    action: occurrence.businessType === 'general' ? 'complete' as const : 'custom_payment' as const,
    occurrenceId: occurrence.id,
    businessType: occurrence.businessType,
    name: occurrence.name,
    note: occurrence.note,
    dueDate: occurrence.targetDate.toISOString(),
    amount: occurrence.amount,
    paidStatus: 'unpaid',
    daysOverdue: customOccurrenceDaysOverdue(occurrence, now),
  }));
  const items = [...cardItems, ...customItems].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  res.json({ date: now.toISOString(), items });
}));

router.get('/today', asyncHandler(async (_req, res) => {
  const { now, cardEvents, customEvents } = await collectTodayEvents();
  res.json({ date: now.toISOString(), items: [...cardEvents, ...customEvents] });
}));

router.get('/upcoming', asyncHandler(async (req, res) => {
  const days = Math.min(120, Math.max(1, Number(req.query.days) || 30));
  const now = req.query.date ? fromYmd(String(req.query.date)) : today();
  await materializeCustomReminderOccurrences(now);
  const [cards, billRows, customs, occurrenceRows] = await Promise.all([
    prisma.card.findMany({ where: { status: 'active', hidden: false } }),
    prisma.bill.findMany({
      where: { card: { hidden: false } },
      include: { cards: { select: { cardId: true } } },
    }),
    prisma.customReminder.findMany(),
    prisma.customReminderOccurrence.findMany({ where: { targetDate: { gte: now, lte: addDays(now, days) } } }),
  ]);

  const items = collectUpcoming(
    cards.map((card) => ({ ...card, remindDaysBefore: (card.remindDaysBefore as number[]) ?? [3, 1, 0] }) as CardLike),
    buildBillsByCard(billRows),
    customs.map((reminder) => ({
      ...reminder,
      daysBefore: (reminder.daysBefore as number[]) ?? [],
      fixedAmount: reminder.fixedAmount == null ? null : Number(reminder.fixedAmount),
    }) as CustomReminderLike),
    now,
    days,
    occurrenceRows.map(occurrenceToView),
  );
  res.json({ days, items });
}));

export default router;
