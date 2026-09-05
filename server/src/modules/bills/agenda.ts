import { customBillView, type CustomBillDatabaseRow } from './custom-bills';
import type { LedgerRow } from './ledger';
import type { UpcomingItem, CardEvent, CustomEvent } from '../reminders/reminder.engine';
import { customOccurrenceDaysOverdue, occurrenceToView } from '../reminders/custom-occurrences';
import { ymd } from '../../lib/dates';

export type AgendaKind = 'credit_bill' | 'fixed_bill' | 'dynamic_bill' | 'general' | 'statement' | 'fee' | 'repayment';
export interface AgendaNotice { type: string; title: string; description: string; date: string }

export function cardBillView(row: LedgerRow) {
  return {
    ...row, recordType: 'card' as const,
    statementDate: row.statementDate.toISOString(), dueDate: row.dueDate.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    customOccurrenceId: null, customReminderId: null, customBusinessType: null, customName: null, note: null,
  };
}

function customView(row: CustomBillDatabaseRow, now: Date) {
  const view = customBillView(row, now);
  return { ...view, dueDate: view.dueDate.toISOString(), paidAt: view.paidAt?.toISOString() ?? null };
}

export type AgendaBill = ReturnType<typeof cardBillView> | ReturnType<typeof customView>;
export interface AgendaItem {
  key: string;
  kind: AgendaKind;
  title: string;
  description: string;
  date: string;
  period: string;
  cardId: number | null;
  cardIds: number[];
  cardTails: string[];
  bankName: string | null;
  occurrenceId: number | null;
  action: 'pay' | 'complete' | 'none';
  completed: boolean;
  daysOverdue: number | null;
  bill: AgendaBill | null;
  notices: AgendaNotice[];
  previewAmount: number | null;
  previewCurrency: string | null;
}

export function agendaKey(bill: AgendaBill) {
  if (bill.recordType === 'custom') return 'custom:' + bill.customOccurrenceId;
  return bill.id != null ? 'bill:' + bill.id : 'missing:' + bill.cardId + ':' + bill.period + ':' + bill.currency;
}

export function billItem(bill: AgendaBill, cardIds: number[] = []): AgendaItem {
  return {
    key: agendaKey(bill), kind: bill.recordType === 'card' ? 'credit_bill' : bill.customBusinessType as AgendaKind,
    title: bill.recordType === 'card' ? bill.bankName ?? '' : bill.customName ?? '', description: bill.note ?? '',
    date: bill.dueDate, period: bill.period, cardId: bill.cardId, cardIds,
    cardTails: bill.cardTails, bankName: bill.bankName, occurrenceId: bill.customOccurrenceId,
    action: 'pay', completed: bill.paidStatus === 'paid', daysOverdue: bill.daysOverdue,
    bill, notices: [], previewAmount: null, previewCurrency: null,
  };
}

export function occurrenceItem(row: CustomBillDatabaseRow, now: Date): AgendaItem {
  if (row.businessType !== 'general') return billItem(customView(row, now));
  return {
    key: 'custom:' + row.id, kind: 'general', title: row.name, description: row.note ?? '',
    date: row.targetDate.toISOString(), period: ymd(row.targetDate).slice(0, 7),
    cardId: null, cardIds: [], cardTails: [], bankName: null, occurrenceId: row.id,
    action: row.status === 'completed' ? 'none' : 'complete', completed: row.status === 'completed',
    daysOverdue: customOccurrenceDaysOverdue(occurrenceToView(row), now), bill: null, notices: [],
    previewAmount: null, previewCurrency: null,
  };
}

function emptyItem(key: string, kind: AgendaKind, title: string, date: string): AgendaItem {
  return {
    key, kind, title, date, period: date.slice(0, 7), description: '', cardId: null, cardIds: [],
    cardTails: [], bankName: null, occurrenceId: null, action: 'none', completed: false,
    daysOverdue: null, bill: null, notices: [], previewAmount: null, previewCurrency: null,
  };
}

/** 同一账单的通知合到原记录；不同提醒原因保留，金额不参与重复相加。 */
export function todayItems(base: AgendaItem[], events: Array<CardEvent | CustomEvent>): AgendaItem[] {
  const result = new Map<string, AgendaItem>();
  for (const event of events) {
    const cardEvent = event.type === 'custom' ? null : event;
    const source = event.type === 'custom'
      ? base.find((item) => item.occurrenceId === event.refId)
      : cardEvent?.billId != null
        ? base.find((item) => item.bill?.recordType === 'card' && item.bill.id === cardEvent.billId)
        : event.type === 'card_due' || event.type === 'card_statement'
          ? base.find((item) => item.bill?.missing && item.cardId === event.cardId && item.period === event.period)
          : undefined;
    const key = source?.key ?? 'notice:' + event.type + ':' + event.refId + ':' + ymd(event.fireDate);
    const item = result.get(key) ?? (source ? { ...source, notices: [] } : {
      ...emptyItem(key, event.type === 'card_fee' ? 'fee' : event.type === 'card_due' ? 'repayment' : event.type === 'custom' ? 'general' : 'statement', event.title, event.fireDate.toISOString()),
      description: event.body,
      cardId: cardEvent?.cardId ?? null, cardIds: cardEvent ? [cardEvent.cardId] : [],
      cardTails: cardEvent ? [cardEvent.cardLast4] : [], bankName: cardEvent?.bankName ?? null,
      period: cardEvent?.period ?? ymd(event.fireDate).slice(0, 7),
    });
    if (!item.notices.some((notice) => notice.type === event.type && notice.date === ymd(event.fireDate))) {
      item.notices.push({ type: event.type, title: event.title, description: event.body, date: ymd(event.fireDate) });
    }
    result.set(key, item);
  }
  return [...result.values()];
}

export function upcomingItems(base: AgendaItem[], events: UpcomingItem[]): AgendaItem[] {
  const result = new Map<string, AgendaItem>();
  for (const event of events) {
    const source = event.billId != null
      ? base.find((item) => item.bill?.recordType === 'card' && item.bill.id === event.billId)
      : event.customOccurrenceId != null
        ? base.find((item) => item.occurrenceId === event.customOccurrenceId)
        : event.type === 'due'
          ? base.find((item) => item.bill?.missing && item.cardId === event.cardId && item.period === event.period)
          : undefined;
    const key = source?.key ?? 'scheduled:' + event.sourceKey;
    const item = result.get(key) ?? (source ? { ...source, date: event.date, notices: [] } : {
      ...emptyItem(key, event.type === 'custom' ? event.customBusinessType as AgendaKind : event.type === 'fee' ? 'fee' : event.type === 'due' ? 'repayment' : 'statement', event.title, event.date),
      cardId: event.cardId ?? null, cardIds: event.cardId ? [event.cardId] : [],
      period: event.period ?? event.date.slice(0, 7), description: event.detail,
      previewAmount: event.amount, previewCurrency: event.currency,
    });
    if (event.date < item.date) item.date = event.date;
    if (!item.notices.some((notice) => notice.type === event.type && notice.date === event.date)) {
      item.notices.push({ type: event.type, title: event.title, description: event.detail, date: event.date });
    }
    result.set(key, item);
  }
  return [...result.values()];
}

export function summarizeAgenda(items: AgendaItem[]) {
  const amounts = new Map<string, number>();
  let billCount = 0;
  let unknownAmountCount = 0;
  for (const item of new Map(items.map((item) => [item.key, item])).values()) {
    if (!item.bill) continue;
    billCount += 1;
    const value = item.completed ? item.bill.amount : item.bill.remainingAmount;
    if (value == null) unknownAmountCount += 1;
    else amounts.set(item.bill.currency, (amounts.get(item.bill.currency) ?? 0) + Math.round(value * 100));
  }
  return {
    billCount, reminderCount: new Set(items.filter((item) => item.kind === 'general').map(item => item.key)).size, unknownAmountCount,
    missingBillCount: new Set(items.filter(item => item.bill?.missing).map(item => item.key)).size,
    totalsByCurrency: [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([currency, cents]) => ({ currency, amount: cents / 100 })),
  };
}

/** 月组摘要在分页前计算，组内列表单独分页。 */
export function groupAgendaHistory(items: AgendaItem[]) {
  const groups = new Map<string, AgendaItem[]>();
  for (const item of new Map(items.filter((item) => item.completed).map((item) => [item.key, item])).values()) {
    const group = groups.get(item.period) ?? [];
    group.push(item);
    groups.set(item.period, group);
  }
  return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([period, rows]) => ({
    period, count: rows.length, ...summarizeAgenda(rows),
  }));
}
