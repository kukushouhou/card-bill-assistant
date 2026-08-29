import {
  addDays,
  dayOfMonthClamped,
  fromYmd,
  lastDayOfMonth,
  monthParts,
  shanghaiMidnight,
  ymd,
} from '../../lib/dates';

export type CustomReminderBusinessType = 'general' | 'fixed_bill' | 'dynamic_bill';
export type CustomReminderScheduleType = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface CustomScheduleLike {
  type: string;
  interval: number;
  anchorDate: Date;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  monthOfYear: number | null;
  specificDate: Date | null;
}

/** 按月专用：1-28=固定日，29=月末前2天，30=月末前1天，31=月末当天。 */
export function monthlyTargetDate(year: number, month: number, storedDay: number): Date {
  if (storedDay >= 1 && storedDay <= 28) return dayOfMonthClamped(year, month, storedDay);
  if (storedDay < 29 || storedDay > 31) throw new Error('按月日期必须为 1-31');
  const day = lastDayOfMonth(year, month) - (31 - storedDay);
  return dayOfMonthClamped(year, month, day);
}

/** 上海业务日期对应的星期：1=周一 ... 7=周日。 */
export function weekdayOf(date: Date): number {
  const jsDay = new Date(`${ymd(date)}T12:00:00Z`).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function firstTarget(schedule: CustomScheduleLike): Date | null {
  const anchor = shanghaiMidnight(schedule.anchorDate);
  const interval = Math.max(1, Math.trunc(schedule.interval || 1));
  void interval;

  if (schedule.type === 'once') return schedule.specificDate ? shanghaiMidnight(schedule.specificDate) : null;
  if (schedule.type === 'daily') return anchor;

  if (schedule.type === 'weekly') {
    if (!schedule.dayOfWeek || schedule.dayOfWeek < 1 || schedule.dayOfWeek > 7) return null;
    const offset = (schedule.dayOfWeek - weekdayOf(anchor) + 7) % 7;
    return addDays(anchor, offset);
  }

  if (schedule.type === 'monthly') {
    if (!schedule.dayOfMonth) return null;
    for (let offset = 0; offset < 24; offset++) {
      const { year, month } = monthParts(anchor, offset);
      const candidate = monthlyTargetDate(year, month, schedule.dayOfMonth);
      if (candidate >= anchor) return candidate;
    }
    return null;
  }

  if (schedule.type === 'yearly') {
    if (!schedule.monthOfYear || !schedule.dayOfMonth) return null;
    const anchorYear = Number(ymd(anchor).slice(0, 4));
    for (let offset = 0; offset < 4; offset++) {
      const year = anchorYear + offset;
      const candidate = dayOfMonthClamped(year, schedule.monthOfYear, schedule.dayOfMonth);
      if (candidate >= anchor) return candidate;
    }
  }
  return null;
}

function addMonthsFrom(date: Date, months: number, storedDay: number): Date {
  const { year, month } = monthParts(date, months);
  return monthlyTargetDate(year, month, storedDay);
}

function addYearsFrom(date: Date, years: number, month: number, day: number): Date {
  const year = Number(ymd(date).slice(0, 4)) + years;
  return dayOfMonthClamped(year, month, day);
}

function nextTarget(schedule: CustomScheduleLike, current: Date): Date | null {
  const interval = Math.max(1, Math.trunc(schedule.interval || 1));
  if (schedule.type === 'once') return null;
  if (schedule.type === 'daily') return addDays(current, interval);
  if (schedule.type === 'weekly') return addDays(current, interval * 7);
  if (schedule.type === 'monthly' && schedule.dayOfMonth) {
    return addMonthsFrom(current, interval, schedule.dayOfMonth);
  }
  if (schedule.type === 'yearly' && schedule.monthOfYear && schedule.dayOfMonth) {
    return addYearsFrom(current, interval, schedule.monthOfYear, schedule.dayOfMonth);
  }
  return null;
}

/** 返回范围内的目标日期；范围和数量双重限制用于防止错误周期生成无限数据。 */
export function customTargetDatesBetween(
  schedule: CustomScheduleLike,
  startInclusive: Date,
  endInclusive: Date,
  limit = 50_000,
): Date[] {
  const start = shanghaiMidnight(startInclusive);
  const end = shanghaiMidnight(endInclusive);
  const result: Date[] = [];
  let current = firstTarget(schedule);
  let guard = 0;
  while (current && current <= end && guard < limit) {
    if (current >= start) result.push(current);
    current = nextTarget(schedule, current);
    guard++;
  }
  if (guard >= limit && current && current <= end) throw new Error('自定义提醒周期生成数量超过安全上限');
  return result;
}

export function nextCustomTargetDates(schedule: CustomScheduleLike, from: Date, count = 3): Date[] {
  if (count <= 0) return [];
  const start = shanghaiMidnight(from);
  let current = firstTarget(schedule);
  let guard = 0;
  while (current && current < start && guard < 50_000) {
    current = nextTarget(schedule, current);
    guard++;
  }
  const result: Date[] = [];
  while (current && result.length < count && guard < 50_000) {
    result.push(current);
    current = nextTarget(schedule, current);
    guard++;
  }
  return result;
}

export function occurrenceAvailableDate(targetDate: Date, daysBefore: number[]): Date {
  const lead = daysBefore.length > 0 ? Math.max(...daysBefore) : 0;
  return addDays(shanghaiMidnight(targetDate), -Math.max(0, lead));
}

export function scheduleFromInput(input: {
  type: string;
  interval: number;
  anchorDate?: Date | string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  monthOfYear?: number | null;
  specificDate?: Date | string | null;
}): CustomScheduleLike {
  const parse = (value: Date | string): Date =>
    typeof value === 'string' ? fromYmd(value.slice(0, 10)) : shanghaiMidnight(value);
  return {
    type: input.type,
    interval: input.interval,
    anchorDate: input.anchorDate ? parse(input.anchorDate) : shanghaiMidnight(new Date()),
    dayOfWeek: input.dayOfWeek ?? null,
    dayOfMonth: input.dayOfMonth ?? null,
    monthOfYear: input.monthOfYear ?? null,
    specificDate: input.specificDate ? parse(input.specificDate) : null,
  };
}
