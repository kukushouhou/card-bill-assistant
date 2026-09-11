import type { BillRow } from '../api/types';
import { overdueText } from './overdue';

export type BillPaymentStatusKind = 'paid' | 'minimum' | 'overdue' | 'partial' | 'unpaid';

export interface BillPaymentStatusPresentation {
  kind: BillPaymentStatusKind;
  label: string;
  color?: string;
}

interface PaymentProgressLike {
  paidStatus: string | null;
  paidAmount: number | null;
  minAmount: number | null;
}

interface PaymentStatusLike extends PaymentProgressLike {
  daysOverdue: number | null;
  /** 账单应还金额；为 0 且已结清时状态显示「无需还款」 */
  amount?: number | null;
}

/** 已还金额达到最低还款额只代表本期履约达标（最低额需为正数），不代表已经结清。 */
export function hasMetMinimumPayment(row: PaymentProgressLike): boolean {
  return row.paidStatus === 'partial'
    && row.minAmount != null
    && row.minAmount > 0
    && (row.paidAmount ?? 0) >= row.minAmount;
}

/** 已还金额：结清账单缺少 paidAmount 时，以账单总额作为展示兜底。 */
export function paidAmountOf(row: BillRow): number {
  if (row.paidStatus === 'paid') return row.paidAmount ?? row.amount ?? 0;
  if (row.paidStatus === 'partial') return Math.max(0, row.paidAmount ?? 0);
  return 0;
}

/** 待还金额由服务端 remainingOf 统一计算，前端不再重复推导。 */
export function remainingAmountOf(row: BillRow): number | null {
  return row.remainingAmount;
}

 /**
 * 还款状态只描述履约进度：结清、已还最低、逾期、部分已还或待还。
 * 逾期（服务端按「逾期提醒」口径计算的 daysOverdue）优先于「已还最低」：
 * 「未全额还清」口径下已还最低的过期账单也按逾期展示。
 * 「无需还款」= 0 元已结清账单；「未取得账单」只在金额位展示，不占用还款状态。
 */
export function paymentStatusOf(row: PaymentStatusLike): BillPaymentStatusPresentation {
  if (row.paidStatus === 'paid') {
    return row.amount === 0
      ? { kind: 'paid', label: '无需还款', color: 'green' }
      : { kind: 'paid', label: '已还清', color: 'green' };
  }

  if (row.daysOverdue != null) {
    return { kind: 'overdue', label: overdueText(row.daysOverdue), color: 'red' };
  }

  if (hasMetMinimumPayment(row)) {
    return { kind: 'minimum', label: '已还最低', color: 'blue' };
  }

  if (row.paidStatus === 'partial') {
    return { kind: 'partial', label: '部分已还', color: 'orange' };
  }

  return { kind: 'unpaid', label: '待还' };
}
