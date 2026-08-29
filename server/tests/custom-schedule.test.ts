import { describe, expect, it } from 'vitest';
import { fromYmd, ymd } from '../src/lib/dates';
import {
  customTargetDatesBetween,
  monthlyTargetDate,
  nextCustomTargetDates,
  occurrenceAvailableDate,
  type CustomScheduleLike,
} from '../src/modules/reminders/custom-schedule';

function schedule(overrides: Partial<CustomScheduleLike> = {}): CustomScheduleLike {
  return {
    type: 'monthly',
    interval: 1,
    anchorDate: fromYmd('2026-08-25'),
    dayOfWeek: null,
    dayOfMonth: 10,
    monthOfYear: null,
    specificDate: null,
    ...overrides,
  };
}

describe('按月月末存储映射', () => {
  it.each([
    [2026, 2, 29, '2026-02-26'],
    [2026, 2, 30, '2026-02-27'],
    [2026, 2, 31, '2026-02-28'],
    [2028, 2, 29, '2028-02-27'],
    [2028, 2, 30, '2028-02-28'],
    [2028, 2, 31, '2028-02-29'],
    [2026, 4, 29, '2026-04-28'],
    [2026, 4, 30, '2026-04-29'],
    [2026, 4, 31, '2026-04-30'],
    [2026, 8, 29, '2026-08-29'],
    [2026, 8, 30, '2026-08-30'],
    [2026, 8, 31, '2026-08-31'],
  ])('%d-%d 保存值 %d', (year, month, storedDay, expected) => {
    expect(ymd(monthlyTargetDate(year, month, storedDay))).toBe(expected);
  });
});

describe('自定义周期目标日期', () => {
  it('按月先取创建后最近匹配日，再按 N 月递推', () => {
    const dates = nextCustomTargetDates(schedule({ interval: 3 }), fromYmd('2026-08-25'), 3);
    expect(dates.map(ymd)).toEqual(['2026-09-10', '2026-12-10', '2027-03-10']);
  });

  it('按周选择最近星期，再按 N 周递推', () => {
    const dates = nextCustomTargetDates(schedule({ type: 'weekly', interval: 2, dayOfWeek: 5, dayOfMonth: null }), fromYmd('2026-08-25'), 3);
    expect(dates.map(ymd)).toEqual(['2026-08-28', '2026-09-11', '2026-09-25']);
  });

  it('按年选择最近月日，闰日遇普通年份钳制到月末', () => {
    const dates = nextCustomTargetDates(schedule({
      type: 'yearly',
      interval: 1,
      anchorDate: fromYmd('2027-03-01'),
      monthOfYear: 2,
      dayOfMonth: 29,
    }), fromYmd('2027-03-01'), 2);
    expect(dates.map(ymd)).toEqual(['2028-02-29', '2029-02-28']);
  });

  it('按天周期与范围生成保持一致', () => {
    const input = schedule({ type: 'daily', interval: 3, dayOfMonth: null });
    expect(customTargetDatesBetween(input, fromYmd('2026-08-25'), fromYmd('2026-09-03')).map(ymd))
      .toEqual(['2026-08-25', '2026-08-28', '2026-08-31', '2026-09-03']);
  });

  it('最早提前提醒日就是内部期次生成日，空列表则使用目标日', () => {
    const target = fromYmd('2026-09-10');
    expect(ymd(occurrenceAvailableDate(target, [7, 3, 0]))).toBe('2026-09-03');
    expect(ymd(occurrenceAvailableDate(target, []))).toBe('2026-09-10');
  });
});
