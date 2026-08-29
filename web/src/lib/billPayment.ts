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
}

/** 已还金额达到最低还款额只代表本期不再逾期，不代表已经结清。 */
export function hasMetMinimumPayment(row: PaymentProgressLike): boolean {
  return row.paidStatus === 'partial'
    && row.minAmount != null
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
 * 「未取得账单」只在金额位展示，不再占用还款状态。
 */
export function paymentStatusOf(row: PaymentStatusLike): BillPaymentStatusPresentation {
  if (row.paidStatus === 'paid') return { kind: 'paid', label: '已还清', color: 'green' };

  if (hasMetMinimumPayment(row)) {
    return { kind: 'minimum', label: '已还最低', color: 'blue' };
  }

  if (row.daysOverdue != null) {
    return { kind: 'overdue', label: overdueText(row.daysOverdue), color: 'red' };
  }

  if (row.paidStatus === 'partial') {
    return { kind: 'partial', label: '部分已还', color: 'orange' };
  }

  return { kind: 'unpaid', label: '待还' };
}
