import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfMonthClamped,
  dayOf,
  daysBetween,
  formatCn,
  fromYmd,
  lastDayOfMonth,
  monthParts,
  periodOf,
  shanghaiMidnight,
  ymd,
} from '../src/lib/dates';

describe('上海时区日期工具', () => {
  it('ymd 输出 YYYY-MM-DD', () => {
    // UTC 2026-08-20 17:00 = 上海 2026-08-21 01:00
    expect(ymd(new Date('2026-08-20T17:00:00Z'))).toBe('2026-08-21');
  });

  it('shanghaiMidnight 锚定 +08:00 零点', () => {
    const d = shanghaiMidnight(new Date('2026-08-20T17:00:00Z'));
    expect(d.toISOString()).toBe('2026-08-20T16:00:00.000Z');
    expect(ymd(d)).toBe('2026-08-21');
  });

  it('fromYmd 构造与校验', () => {
    expect(ymd(fromYmd('2026-08-21'))).toBe('2026-08-21');
    expect(() => fromYmd('2026/08/21')).toThrow();
    expect(() => fromYmd('2026-8-21')).toThrow();
  });

  it('lastDayOfMonth 处理闰年', () => {
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(lastDayOfMonth(2028, 2)).toBe(29);
    expect(lastDayOfMonth(2026, 12)).toBe(31);
  });

  it('dayOfMonthClamped 钳制到月末', () => {
    expect(ymd(dayOfMonthClamped(2026, 2, 31))).toBe('2026-02-28');
    expect(ymd(dayOfMonthClamped(2028, 2, 31))).toBe('2028-02-29');
    expect(ymd(dayOfMonthClamped(2026, 8, 15))).toBe('2026-08-15');
  });

  it('addDays / daysBetween 往返', () => {
    const a = fromYmd('2026-08-01');
    const b = addDays(a, 30);
    expect(daysBetween(a, b)).toBe(30);
    expect(daysBetween(b, a)).toBe(-30);
  });

  it('dayOf 取"几号"（跨时区安全）', () => {
    expect(dayOf(fromYmd('2026-08-21'))).toBe(21);
    expect(dayOf(new Date('2026-08-20T18:00:00Z'))).toBe(21); // UTC 18 点 = 上海次日 2 点
  });

  it('monthParts 偏移（含跨年）', () => {
    expect(monthParts(fromYmd('2026-08-15'))).toEqual({ year: 2026, month: 8 });
    expect(monthParts(fromYmd('2026-01-15'), -1)).toEqual({ year: 2025, month: 12 });
    expect(monthParts(fromYmd('2026-12-15'), 1)).toEqual({ year: 2027, month: 1 });
  });

  it('periodOf 取出账月', () => {
    expect(periodOf(fromYmd('2026-08-05'))).toBe('2026-08');
  });

  it('formatCn 中文日期', () => {
    expect(formatCn(fromYmd('2026-08-05'))).toBe('8月5日');
    expect(formatCn(fromYmd('2026-11-25'))).toBe('11月25日');
  });
});
