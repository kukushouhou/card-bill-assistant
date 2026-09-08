import type { BillRow } from '../api/types';
import { hasMetMinimumPayment } from './billPayment';
import { overdueText } from './overdue';

export interface BillDueNotice {
  tone: 'overdue' | 'today' | 'soon' | 'later';
  label: string;
}

const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const dayNumber = (value: Date) => Date.parse(businessDate.format(value) + 'T00:00:00Z') / 86_400_000;
type DueBill = Pick<BillRow, 'dueDate' | 'paidStatus' | 'paidAmount' | 'minAmount' | 'daysOverdue' | 'missing'>;

/** 仅描述到期紧迫程度；逾期及已还最低继续采用账单已有口径。 */
export function billDueNotice(bill: DueBill | null, now = new Date()): BillDueNotice | null {
  if (!bill || bill.paidStatus === 'paid' || hasMetMinimumPayment(bill)) return null;
  if (bill.daysOverdue != null && bill.daysOverdue > 0) return { tone: 'overdue', label: overdueText(bill.daysOverdue) };
  const due = new Date(/^\d{4}-\d{2}-\d{2}$/.test(bill.dueDate) ? bill.dueDate + 'T00:00:00+08:00' : bill.dueDate);
  if (Number.isNaN(due.getTime())) return null;
  const days = dayNumber(due) - dayNumber(now);
  // 不在浏览器重算逾期，避免把已履行最低还款的账单重新标红。
  if (days < 0) return null;
  if (days === 0) return { tone: 'today', label: bill.missing ? '今天还款日' : '今天应还' };
  if (days === 1) return { tone: 'soon', label: bill.missing ? '明天还款日' : '明天应还' };
  return { tone: days <= 3 ? 'soon' : 'later', label: `${days} 天后还款` };
}
