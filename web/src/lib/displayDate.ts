/** 显示省略当年年份，查询与存储始终保留完整日期；年份按上海业务时区判断。 */
export function businessYear(now = new Date()): string {
  return new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(now);
}

export function displayPeriod(period: string | null | undefined, now = new Date()): string {
  if (!period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return period || '—';
  const [year, month] = period.split('-');
  return (year === businessYear(now) ? '' : year + '年') + Number(month) + '月';
}

export function displayDate(value: string | null | undefined, options: { time?: boolean; now?: Date } = {}): string {
  if (!value) return '—';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00+08:00' : value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
    ...(options.time ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' as const } : {}),
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const year = part('year');
  return (year === businessYear(options.now) ? '' : year + '年') + part('month') + '月' + part('day') + '日'
    + (options.time ? ' ' + part('hour') + ':' + part('minute') + ':' + part('second') : '');
}
