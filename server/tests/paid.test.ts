import { describe, expect, it } from 'vitest';
import { isOverdue, remainingOf } from '../src/modules/bills/paid';
import { fromYmd } from '../src/lib/dates';

describe('remainingOf 待还余额', () => {
  it('paid → 0', () => {
    expect(remainingOf({ amount: 1000, paidStatus: 'paid', paidAmount: 1000 })).toBe(0);
    expect(remainingOf({ amount: 1000, paidStatus: 'paid', paidAmount: null })).toBe(0);
  });

  it('partial → amount - paidAmount（不为负）', () => {
    expect(remainingOf({ amount: 1000, paidStatus: 'partial', paidAmount: 400 })).toBe(600);
    expect(remainingOf({ amount: 1000, paidStatus: 'partial', paidAmount: 1200 })).toBe(0);
    expect(remainingOf({ amount: 1000, paidStatus: 'partial', paidAmount: null })).toBe(1000);
  });

  it('unpaid → amount（金额未知按 0）', () => {
    expect(remainingOf({ amount: 1000, paidStatus: 'unpaid', paidAmount: null })).toBe(1000);
    expect(remainingOf({ amount: null, paidStatus: 'unpaid', paidAmount: null })).toBe(0);
  });
});

describe('isOverdue 逾期判定', () => {
  const today = fromYmd('2026-08-22');
  const pastDue = fromYmd('2026-08-10');
  const futureDue = fromYmd('2026-09-10');

  it('还款日未到不逾期', () => {
    expect(isOverdue({ dueDate: futureDue, amount: 1000, minAmount: 100, paidStatus: 'unpaid', paidAmount: null }, today)).toBe(false);
    expect(isOverdue({ dueDate: today, amount: 1000, minAmount: 100, paidStatus: 'unpaid', paidAmount: null }, today)).toBe(false);
  });

  it('已结清不逾期', () => {
    expect(isOverdue({ dueDate: pastDue, amount: 1000, minAmount: 100, paidStatus: 'paid', paidAmount: 1000 }, today)).toBe(false);
  });

  it('还款日已过且未还 → 逾期', () => {
    expect(isOverdue({ dueDate: pastDue, amount: 1000, minAmount: 100, paidStatus: 'unpaid', paidAmount: null }, today)).toBe(true);
  });

  it('部分已还 ≥ 最低还款 → 不视为逾期', () => {
    expect(isOverdue({ dueDate: pastDue, amount: 1000, minAmount: 100, paidStatus: 'partial', paidAmount: 100 }, today)).toBe(false);
    expect(isOverdue({ dueDate: pastDue, amount: 1000, minAmount: 100, paidStatus: 'partial', paidAmount: 500 }, today)).toBe(false);
  });

  it('部分已还 < 最低还款 → 逾期', () => {
    expect(isOverdue({ dueDate: pastDue, amount: 1000, minAmount: 100, paidStatus: 'partial', paidAmount: 99.99 }, today)).toBe(true);
  });

  it('最低还款未知时保守视为逾期（不豁免）', () => {
    expect(isOverdue({ dueDate: pastDue, amount: 1000, minAmount: null, paidStatus: 'partial', paidAmount: 500 }, today)).toBe(true);
  });
});
