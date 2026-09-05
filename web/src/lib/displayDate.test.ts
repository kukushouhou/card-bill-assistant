import { describe, expect, it } from 'vitest';
import { displayDate, displayPeriod } from './displayDate';

describe('上海业务日期的年份省略', () => {
  it('当年账期不显示年份，历史账期保留年份', () => {
    const now = new Date('2026-09-05T02:00:00Z');
    expect(displayPeriod('2026-08', now)).toBe('8月');
    expect(displayPeriod('2025-08', now)).toBe('2025年8月');
  });
  it('跨年时按上海日期判断，不按浏览器或 UTC 年份判断', () => {
    const now = new Date('2025-12-31T17:00:00Z');
    expect(displayPeriod('2026-01', now)).toBe('1月');
    expect(displayDate('2025-12-31', { now })).toBe('2025年12月31日');
    expect(displayDate('2025-12-31T17:30:00Z', { now, time: true })).toBe('1月1日 01:30:00');
  });
  it('日期缺失不伪造日期或账期', () => {
    expect(displayDate(null)).toBe('—'); expect(displayPeriod(null)).toBe('—');
  });
});
