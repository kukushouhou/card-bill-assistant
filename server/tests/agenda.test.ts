import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/prisma', () => ({ prisma: {} }));
import { billItem, cardBillView, groupAgendaHistory, occurrenceItem, summarizeAgenda, todayItems, upcomingItems } from '../src/modules/bills/agenda';
import type { LedgerRow } from '../src/modules/bills/ledger';
import type { CardEvent, UpcomingItem } from '../src/modules/reminders/reminder.engine';
import { fromYmd } from '../src/lib/dates';

function bill(overrides: Partial<LedgerRow> = {}) {
  return billItem(cardBillView({ id: 10, cardId: 1, bankName: '交通银行', cardLast4: '0988', cardTails: ['0988', '2233'], period: '2026-08', statementDate: fromYmd('2026-08-10'), dueDate: fromYmd('2026-09-04'), amount: 43.4, remainingAmount: 43.4, minAmount: .44, currency: 'CNY', paidStatus: 'unpaid', paidAmount: null, paidAt: null, missing: false, daysOverdue: 1, hasDetails: false, annualFeeAmount: null, source: 'email', ...overrides }), [1, 2]);
}
function event(overrides: Partial<CardEvent> = {}): CardEvent {
  return { type: 'card_due', refId: 10, cardId: 1, bankName: '交通银行', cardLast4: '0988', period: '2026-08', title: '还款提醒', body: '还款日 9月4日', fireDate: fromYmd('2026-09-04'), dueDate: fromYmd('2026-09-04'), billId: 10, hasBill: true, amount: 43.4, minAmount: .44, currency: 'CNY', paidStatus: 'unpaid', paidAmount: null, linkedCount: 2, ...overrides };
}

describe('账单中心统一对象', () => {
  it('同账单多个提醒、同封合并卡，只返回一笔金额并保留提醒原因', () => {
    const rows = todayItems([bill()], [event(), event(), event({ cardId: 2 }), event({ type: 'card_statement' })]);
    expect(rows).toHaveLength(1); expect(rows[0].cardTails).toEqual(['0988', '2233']);
    expect(rows[0].notices).toHaveLength(2);
    expect(summarizeAgenda(rows).totalsByCurrency).toEqual([{ currency: 'CNY', amount: 43.4 }]);
  });
  it('同月份未还与部分还款独立，只有已还清进入历史；汇总不受组内分页影响', () => {
    const paid = Array.from({ length: 25 }, (_, i) => bill({ id: i + 20, amount: .1, paidStatus: 'paid', remainingAmount: 0 }));
    const rows = [bill(), bill({ id: 11, paidStatus: 'partial', paidAmount: 10, remainingAmount: 33.4 }), ...paid, bill({ id: 100, amount: 7, currency: 'USD', paidStatus: 'paid', remainingAmount: 0 })];
    const groups = groupAgendaHistory(rows);
    expect(groups).toHaveLength(1); expect(groups[0].count).toBe(26);
    expect(groups[0].totalsByCurrency).toEqual([{ currency: 'CNY', amount: 2.5 }, { currency: 'USD', amount: 7 }]);
    expect(summarizeAgenda(rows.filter(row => !row.completed)).totalsByCurrency).toEqual([{ currency: 'CNY', amount: 76.8 }]);
  });
  it('常规提醒历史只计完成记录，不混入账单金额', () => {
    const reminder = occurrenceItem({ id: 10, reminderId: 1, businessType: 'general', name: '续费检查', note: null, targetDate: fromYmd('2026-08-15'), availableDate: fromYmd('2026-08-12'), daysBefore: [3, 0], amount: null, status: 'completed', completedAt: fromYmd('2026-08-15'), suspended: false }, fromYmd('2026-09-05'));
    const rows = [bill({ paidStatus: 'paid' }), reminder];
    expect(groupAgendaHistory(rows)[0]).toMatchObject({ count: 2, billCount: 1, reminderCount: 1 });
    expect(summarizeAgenda([...rows, reminder]).reminderCount).toBe(1);
  });
  it('未取得账单的出账和到期提醒挂回同一占位行，年费独立且没有还款动作', () => {
    const missing = bill({ id: null, missing: true, amount: null, remainingAmount: null });
    const rows = todayItems([missing], [event({ billId: null, refId: -1, type: 'card_statement' }), event({ billId: null, refId: -1 }), event({ billId: null, refId: -1, type: 'card_fee' })]);
    expect(rows).toHaveLength(2); expect(rows.find(row => row.kind === 'fee')).toMatchObject({ bill: null, action: 'none' });
    expect(summarizeAgenda(rows)).toMatchObject({ billCount: 1, unknownAmountCount: 1, missingBillCount: 1, totalsByCurrency: [] });
  });
  it('未到处理时点的未来还款是只读安排，不伪装出账提醒或真实账单', () => {
    const future: UpcomingItem = { sourceKey: 'future', date: '2026-10-01', type: 'due', title: '还款安排', detail: '', amount: null, minAmount: null, currency: 'CNY', paid: null, paidStatus: null, paidAmount: null, daysLeft: 26, hasBill: false, cardId: 1, period: '2026-09', actionable: false };
    expect(upcomingItems([], [future])[0]).toMatchObject({ kind: 'repayment', action: 'none', bill: null });
  });
});
