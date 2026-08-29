import dayjs from 'dayjs';

/**
 * 逾期判断与文案（账单列表 / 仪表盘今日待办 / 提醒中心三处共用）：
 * >30 天显示「逾期 N 个月」，>365 天显示「逾期 N 年」
 */

/** 还款日已过且账单未还时返回逾期天数（≥1），否则 null */
export function overdueDays(dueDate: string, paidStatus?: string | null): number | null {
  if (!paidStatus || paidStatus === 'paid') return null;
  const diff = dayjs(dueDate).startOf('day').diff(dayjs().startOf('day'), 'day');
  return diff < 0 ? -diff : null;
}

/** 逾期天数 → 展示文案 */
export function overdueText(days: number): string {
  if (days > 365) return `逾期 ${Math.floor(days / 365)} 年`;
  if (days > 30) return `逾期 ${Math.floor(days / 30)} 个月`;
  return `逾期 ${days} 天`;
}
