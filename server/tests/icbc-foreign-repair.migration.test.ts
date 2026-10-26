import { describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { fromYmd } from '../src/lib/dates';
import { repaymentLowerBound } from '../src/modules/upgrades/migrations/statement-repair';
import { buildLedger, buildTrend, type LedgerBillInput, type LedgerCard } from '../src/modules/bills/ledger';
import { collectTodoItems } from '../src/modules/reminders/todos';
import { collectCardEvents } from '../src/modules/reminders/reminder.engine';
import { repairIcbcForeign080Migration, repairIcbcForeignMail } from '../src/modules/upgrades/migrations/repair-icbc-foreign-080';
vi.mock('../src/lib/prisma', () => ({ prisma: {} }));
const mail = { mailLogId: 10, accountId: 1, uid: 20, parserId: 'icbc2026', bankName: '工商银行', billIds: [1],
  targets: [{ id: 1, cardId: 7, period: '2026-09', currency: 'USD' }] };
const parsed = [{ bankName: '工商银行', cardLast4: '1111', cardLast4s: ['1111', '2222'], period: '2026-09',
  currency: 'USD', amount: 21.26, minAmount: 2.13, statementDate: fromYmd('2026-09-30'), dueDate: fromYmd('2026-10-25') }];
const facts = [{ cardLast4: '1111', currency: 'USD', amount: 21.26, minAmount: 2.13, continued: true }];
function setup(overrides = {}) {
  const row = { id: 1, cardId: 7, period: '2026-09', currency: 'USD', amount: 0, minAmount: 0, mailLogId: 10,
    source: 'email', card: { bankName: '工商银行', cardLast4: '1111' }, statementDate: fromYmd('2026-09-30'),
    dueDate: fromYmd('2026-10-25'), paidStatus: 'paid', paidAt: fromYmd('2026-10-25'), paidAmount: 0,
    updatedAt: fromYmd('2026-10-18'), ...overrides };
  const db = { mailLog: { findUnique: vi.fn().mockResolvedValue({ id: 10, accountId: 1, uid: 20, parserId: 'icbc2026', status: 'matched' }) },
    bill: { findMany: vi.fn().mockResolvedValue([row]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const run = (bills = parsed, rows = facts, lower = fromYmd('2026-09-26')) => repairIcbcForeignMail(db as unknown as Prisma.TransactionClient, mail, bills, rows, lower);
  return { db, row, run };
}
describe('0.8 工行外币限域修复', () => {
  it('所有历史现存外币均进入只读复核，不以金额零或交易作为条件', async () => {
    const db = { mailLog: { findMany: vi.fn().mockResolvedValue([{ id: 10, accountId: 1, uid: 20,
      bills: [{ id: 1, cardId: 7, period: '2020-01', currency: 'USD', dueDate: fromYmd('2020-02-25') }] }]) } };
    const result = await repairIcbcForeign080Migration.inspect(db as unknown as PrismaClient);
    expect(result?.total).toBe(1);
    expect(db.mailLog.findMany.mock.calls[0]![0].where).toEqual({ status: 'matched', parserId: 'icbc2026',
      bills: { some: { source: 'email', currency: { not: 'CNY' }, card: { bankName: '工商银行' } } } });
    expect(repairIcbcForeign080Migration.describeImpact!(result!)).toContain('全部历史需复核');
    expect(repairIcbcForeign080Migration).toMatchObject({ key: 'icbc-foreign-amount-repair-080-v1', targetVersion: '0.8.0', mode: 'optional' });
  });
  it('近月原文正额且自动签名与时序充分才恢复', async () => {
    const { db, run } = setup();
    expect(await run()).toMatchObject({ correctedBills: 1, restoredRepayments: 1, uncertainRepayments: 0 });
    expect(db.bill.updateMany.mock.calls[0]![0].data).toEqual({ amount: 21.26, minAmount: 2.13, paidStatus: 'unpaid', paidAt: null, paidAmount: null });
  });
  it.each([
    ['手动全额', { paidAmount: 21.26, paidAt: fromYmd('2026-10-24') }],
    ['部分还款', { paidStatus: 'partial', paidAmount: 2.13 }],
    ['撤销还款', { paidStatus: 'unpaid', paidAt: null, paidAmount: null }],
    ['非零漏读', { amount: 10, minAmount: 1 }],
  ])('%s 修金额而保留最新还款决定', async (_name, fields) => {
    const { run, db } = setup(fields);
    expect(await run()).toMatchObject({ correctedBills: 1, restoredRepayments: 0, uncertainRepayments: 0 });
    expect(db.bill.updateMany.mock.calls[0]![0].data).toEqual({ amount: 21.26, minAmount: 2.13 });
  });
  it('旧签名但更新时间不足确证，仅近期计入专门结果', async () => {
    const { run } = setup({ updatedAt: fromYmd('2026-10-25') });
    expect(await run()).toMatchObject({ correctedBills: 1, restoredRepayments: 0, uncertainRepayments: 1 });
    expect(await run(parsed, facts, fromYmd('2026-10-26'))).toMatchObject({ correctedBills: 1, restoredRepayments: 0, uncertainRepayments: 0 });
  });
  it('窗口外错误金额仍修正，边界当天可以恢复', async () => {
    const { run } = setup();
    expect(await run(parsed, facts, fromYmd('2026-10-26'))).toMatchObject({ correctedBills: 1, restoredRepayments: 0 });
    expect(await run(parsed, facts, fromYmd('2026-10-25'))).toMatchObject({ restoredRepayments: 1 });
  });
  it('真实零余额不恢复；没有明确还款行、未确证续行不修正', async () => {
    const { run, db } = setup({ amount: 5, minAmount: 1 });
    expect(await run([{ ...parsed[0]!, amount: 0, minAmount: 0 }], [{ ...facts[0]!, amount: 0, minAmount: 0 }])).toMatchObject({ correctedBills: 1, restoredRepayments: 0 });
    db.bill.updateMany.mockClear();
    expect(await run(parsed, [])).toMatchObject({ skippedBills: 1 });
    expect(await run(parsed, [{ ...facts[0]!, continued: false }])).toMatchObject({ correctedBills: 0 });
    expect(db.bill.updateMany).not.toHaveBeenCalled();
  });
  it.each([{ source: 'manual' }, { mailLogId: 11 }, { cardId: 8 }, { currency: 'CNY' }, { period: '2026-08' }])('目标身份变更 %j 不覆盖', async fields => {
    const { run, db } = setup(fields);
    expect(await run()).toMatchObject({ correctedBills: 0, skippedBills: 1 });
    expect(db.bill.updateMany).not.toHaveBeenCalled();
  });
  it('删除、来源变化和对应不唯一均不补建', async () => {
    const { run, db } = setup();
    db.bill.findMany.mockResolvedValueOnce([]);
    expect(await run()).toMatchObject({ skippedBills: 1 });
    expect(await run([...parsed, ...parsed])).toMatchObject({ skippedBills: 1 });
    db.mailLog.findUnique.mockResolvedValueOnce(null);
    expect(await run()).toMatchObject({ skippedBills: 1 });
    expect(db.bill.updateMany).not.toHaveBeenCalled();
  });
  it('读后新操作以条件更新保护，已正确金额不重复计数', async () => {
    const { run, db } = setup();
    db.bill.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await run()).toMatchObject({ correctedBills: 0, restoredRepayments: 0, skippedBills: 1 });
    expect(await setup({ amount: 21.26, minAmount: 2.13 }).run()).toMatchObject({ correctedBills: 0 });
  });
  it('自然月下界含上海时区、月末钳制和闰年', () => {
    expect(repaymentLowerBound(fromYmd('2026-03-31'))).toEqual(fromYmd('2026-02-28'));
    expect(repaymentLowerBound(fromYmd('2024-03-31'))).toEqual(fromYmd('2024-02-29'));
    expect(repaymentLowerBound(new Date('2026-10-25T18:00:00Z'))).toEqual(fromYmd('2026-09-26'));
  });
  it('实际修复输出进入既有统计、台账、待办和到期提醒消费者，窗口外保留状态不提醒', async () => {
    const { row, db, run } = setup();
    await run();
    const card = { id: 7, bankName: '工商银行', cardLast4: '1111', currency: 'CNY', statementDay: 30,
      dueRule: 'fixed', dueDay: 25, dueOffsetDays: null, status: 'active', createdAt: fromYmd('2020-01-01'), remindDaysBefore: [3, 1, 0] };
    const before = { ...row, source: 'email', linkedCardIds: [7], hasDetails: true, annualFeeAmount: null } as unknown as LedgerBillInput;
    const after = { ...before, ...db.bill.updateMany.mock.calls[0]![0].data } as LedgerBillInput;
    const cards = [card as LedgerCard];
    expect(buildTrend([before], 2, fromYmd('2026-10-26'), 'USD')[0]).toMatchObject({ period: '2026-09', total: null, count: 0 });
    expect(buildTrend([after], 2, fromYmd('2026-10-26'), 'USD')[0]).toMatchObject({ period: '2026-09', total: 21.26, count: 1 });
    expect(buildLedger(cards, cards, [after], fromYmd('2026-10-26')).find(b => b.id === 1)).toMatchObject({ remainingAmount: 21.26, daysOverdue: 1 });
    expect(collectTodoItems(cards, cards, [after], fromYmd('2026-10-26'))).toContainEqual(expect.objectContaining({ billId: 1, currency: 'USD', amount: 21.26 }));
    expect(collectCardEvents(card, [after], fromYmd('2026-10-25')).filter(e => e.billId === 1)).toContainEqual(expect.objectContaining({ type: 'card_due', amount: 21.26, minAmount: 2.13, currency: 'USD' }));
    const historical = { ...after, paidStatus: 'paid', paidAt: before.paidAt, paidAmount: 0 };
    expect(buildTrend([historical], 2, fromYmd('2026-10-26'), 'USD')[0]!.total).toBe(21.26);
    expect(collectTodoItems(cards, cards, [historical], fromYmd('2026-10-26')).some(b => b.billId === 1)).toBe(false);
    expect(collectCardEvents(card, [historical], fromYmd('2026-10-25')).some(e => e.billId === 1)).toBe(false);
  });
});
