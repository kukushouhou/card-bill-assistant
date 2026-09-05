import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { today } from '../lib/dates';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import { loadLedgerData } from '../modules/bills/ledger-data';
import { materializeCustomReminderOccurrences, occurrenceToView } from '../modules/reminders/custom-occurrences';
import { buildBillsByCard, collectTodayEvents, collectUpcoming, type CustomReminderLike } from '../modules/reminders/reminder.engine';
import {
  billItem, cardBillView, groupAgendaHistory, occurrenceItem, summarizeAgenda, todayItems, upcomingItems,
} from '../modules/bills/agenda';

const router = Router();
router.use(requireAuth);

const querySchema = z.object({
  view: z.enum(['open', 'today', 'upcoming', 'history']).default('open'),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  bank: z.string().trim().max(64).optional(),
  cardId: z.coerce.number().int().positive().optional(),
  cardIds: z.string().regex(/^\d+(,\d+)*$/).transform((value) => [...new Set(value.split(',').map(Number))])
    .pipe(z.array(z.number().int().positive()).min(1).max(50)).optional(),
  kind: z.enum(['credit_bill', 'fixed_bill', 'dynamic_bill', 'general', 'statement', 'fee', 'repayment']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).refine((input) => !(input.cardId && input.cardIds), '卡片筛选条件不能同时使用');

router.get('/', asyncHandler(async (req, res) => {
  const input = querySchema.parse(req.query);
  const now = today();
  const includeCustom = input.cardId == null && input.cardIds == null && !input.bank;
  if (includeCustom) await materializeCustomReminderOccurrences(now);
  const [snapshot, occurrences, reminders, events] = await Promise.all([
    loadLedgerData(input, now),
    includeCustom ? prisma.customReminderOccurrence.findMany({ where: { suspended: false } }) : Promise.resolve([]),
    input.view === 'upcoming' && includeCustom ? prisma.customReminder.findMany() : Promise.resolve([]),
    input.view === 'today' ? collectTodayEvents() : Promise.resolve(null),
  ]);
  const base = [
    ...snapshot.rows.map((row) => billItem(cardBillView(row), row.id == null
      ? [row.cardId] : snapshot.billById.get(row.id)?.linkedCardIds ?? [row.cardId])),
    ...occurrences.map((row) => occurrenceItem(row, now)),
  ];
  let items = base;
  if (input.view === 'open') items = base.filter((item) => !item.completed && item.action !== 'none');
  if (input.view === 'history') items = base.filter((item) => item.completed);
  if (input.view === 'today' && events) items = todayItems(base, [...events.cardEvents, ...events.customEvents]);
  if (input.view === 'upcoming') {
    const allowed = new Set(snapshot.scopeCards.map((card) => card.id));
    const reminderCards = snapshot.allCards.filter((card) => allowed.has(card.id) && card.status === 'active' && !card.hidden)
      .map((card) => ({ ...card, remindDaysBefore: (card.remindDaysBefore as number[]) ?? [3, 1, 0] }));
    const owner = new Map(snapshot.allCards.map((card) => [card.id, card]));
    items = upcomingItems(base, collectUpcoming(
      reminderCards, buildBillsByCard(snapshot.bills.filter((bill) => !owner.get(bill.cardId)?.hidden)),
      reminders.map((reminder) => ({ ...reminder, daysBefore: (reminder.daysBefore as number[]) ?? [],
        fixedAmount: reminder.fixedAmount == null ? null : Number(reminder.fixedAmount) })) as CustomReminderLike[],
      now, 30, occurrences.map(occurrenceToView),
    ));
  }
  const cardById = new Map(snapshot.allCards.map((card) => [card.id, card]));
  items = items.map((item) => {
    const card = item.cardId == null ? null : cardById.get(item.cardId);
    return { ...item, bankName: item.bankName ?? card?.bankName ?? null,
      cardTails: item.cardTails.length ? item.cardTails : card ? [card.displayLast4 || card.cardLast4] : [] };
  });
  const scopedIds = input.cardId != null ? [input.cardId] : input.cardIds;
  items = items.filter((item) => (!input.bank || item.bankName === input.bank)
    && (!scopedIds || item.cardIds.some((id) => scopedIds.includes(id)))
    && (!input.kind || item.kind === input.kind)
    && (!input.period || item.period === input.period)
    && (!input.q || [item.title, item.description, ...item.cardTails].join(' ').toLocaleLowerCase().includes(input.q.toLocaleLowerCase())));
  items = [...new Map(items.map((item) => [item.key, item])).values()];
  items.sort((a, b) => {
    if (input.view === 'open' && Boolean(a.daysOverdue) !== Boolean(b.daysOverdue)) return a.daysOverdue ? -1 : 1;
    const dateOrder = a.date.localeCompare(b.date);
    return (input.view === 'history' ? -dateOrder : dateOrder) || a.key.localeCompare(b.key);
  });
  const summary = summarizeAgenda(items);
  const start = (input.page - 1) * input.pageSize;
  const grouped = input.view === 'history' && !input.period;
  const groups = grouped ? groupAgendaHistory(items) : [];
  res.json({
    view: input.view, grouped, total: grouped ? groups.length : items.length, recordCount: items.length,
    page: input.page, pageSize: input.pageSize, summary,
    items: grouped ? [] : items.slice(start, start + input.pageSize),
    groups: groups.slice(start, start + input.pageSize),
  });
}));

export default router;
