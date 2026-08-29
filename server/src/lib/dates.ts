/**
 * 日期工具：所有"业务日期"统一锚定为上海时区当日零点（YYYY-MM-DDT00:00:00+08:00）。
 * 出账日/还款日均为纯日期语义，不含时刻。
 */

const TZ = 'Asia/Shanghai';

function fmt(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** 上海时区某日期的字符串形式 YYYY-MM-DD */
export function ymd(d: Date = new Date()): string {
  return fmt(d);
}

/** 将任意时间转换为"上海时区当日零点"的时刻（+08:00 锚定） */
export function shanghaiMidnight(d: Date = new Date()): Date {
  return new Date(`${fmt(d)}T00:00:00+08:00`);
}

/** 上海时区的今天（当日零点） */
export function today(): Date {
  return shanghaiMidnight(new Date());
}

/** 由 YYYY-MM-DD 字符串构造零点时刻 */
export function fromYmd(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`非法日期字符串: ${s}`);
  return new Date(`${s}T00:00:00+08:00`);
}

/** 某年某月（1-12）的最后一天 */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 构造年/月/日对应的零点时刻；day 超过当月天数时取月末（如 31 → 2 月取 28/29） */
export function dayOfMonthClamped(year: number, month: number, day: number): Date {
  const d = Math.min(Math.max(1, day), lastDayOfMonth(year, month));
  const mm = String(month).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return new Date(`${year}-${mm}-${dd}T00:00:00+08:00`);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** b - a 的天数差（按零点锚定的纯日期计算） */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function sameDay(a: Date, b: Date): boolean {
  return ymd(a) === ymd(b);
}

/** 账单期次：出账日所在月份 'YYYY-MM' */
export function periodOf(statementDate: Date): string {
  return ymd(statementDate).slice(0, 7);
}

/** 上海时区某日期的“几号”（1-31） */
export function dayOf(d: Date): number {
  return Number(ymd(d).slice(8, 10));
}

/** 上海时区某日期的 {year, month(1-12)}，可向前/向后偏移月份 */
export function monthParts(d: Date, offsetMonths = 0): { year: number; month: number } {
  const y = Number(ymd(d).slice(0, 4));
  const m = Number(ymd(d).slice(5, 7));
  const total = y * 12 + (m - 1) + offsetMonths;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

export function formatCn(d: Date): string {
  const s = ymd(d);
  return `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日`;
}
