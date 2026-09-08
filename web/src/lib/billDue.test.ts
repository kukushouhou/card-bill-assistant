import { describe, expect, it } from 'vitest';
import { billDueNotice } from './billDue';

const now = new Date('2026-09-08T02:00:00Z');
const bill = { dueDate: '2026-09-08', paidStatus: 'unpaid' as const, paidAmount: null, minAmount: 10, daysOverdue: null, missing: false };

describe('账单到期提示', () => {
  it('今天与未来三天明确强调，较远日期保持普通倒计时', () => {
    expect(billDueNotice(bill, now)).toEqual({ tone: 'today', label: '今天应还' });
    expect(billDueNotice({ ...bill, dueDate: '2026-09-09' }, now)).toEqual({ tone: 'soon', label: '明天应还' });
    expect(billDueNotice({ ...bill, dueDate: '2026-09-11' }, now)).toEqual({ tone: 'soon', label: '3 天后还款' });
    expect(billDueNotice({ ...bill, dueDate: '2026-09-12' }, now)).toEqual({ tone: 'later', label: '4 天后还款' });
  });
  it('上海已跨年时不按浏览器所在地或 UTC 日期少算一天', () => {
    expect(billDueNotice({ ...bill, dueDate: '2025-12-31T16:00:00Z' }, new Date('2025-12-31T17:00:00Z'))).toEqual({ tone: 'today', label: '今天应还' });
    expect(billDueNotice({ ...bill, dueDate: '2026-01-02' }, new Date('2025-12-31T17:00:00Z'))).toEqual({ tone: 'soon', label: '明天应还' });
  });
  it('没有本期账单仍提示还款日，不捏造待还金额', () => {
    expect(billDueNotice({ ...bill, missing: true, paidStatus: null }, now)).toEqual({ tone: 'today', label: '今天还款日' });
    expect(billDueNotice({ ...bill, missing: true, paidStatus: null, dueDate: '2026-09-09' }, now)).toEqual({ tone: 'soon', label: '明天还款日' });
  });
  it('部分还款尚未达到最低还款仍提示，已还最低或已结清不警示', () => {
    expect(billDueNotice({ ...bill, paidStatus: 'partial', paidAmount: 9 }, now)?.tone).toBe('today');
    expect(billDueNotice({ ...bill, paidStatus: 'partial', paidAmount: 10 }, now)).toBeNull();
    expect(billDueNotice({ ...bill, paidStatus: 'paid', daysOverdue: 1 }, now)).toBeNull();
  });
  it('逾期采用服务端口径，未认定逾期的不自行重算', () => {
    expect(billDueNotice({ ...bill, dueDate: '2026-09-07', daysOverdue: 1 }, now)).toEqual({ tone: 'overdue', label: '逾期 1 天' });
    expect(billDueNotice({ ...bill, daysOverdue: 40 }, now)?.label).toBe('逾期 1 个月');
    expect(billDueNotice({ ...bill, dueDate: '2026-09-07' }, now)).toBeNull();
    expect(billDueNotice({ ...bill, dueDate: '' }, now)).toBeNull();
    expect(billDueNotice(null, now)).toBeNull();
  });
});
