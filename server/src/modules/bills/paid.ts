/**
 * 账单还款判定纯函数：
 * - remainingOf：待还余额（paid→0；partial→amount-paidAmount；unpaid→amount）
 * - isOverdue：是否逾期（还款日已过 && 未结清 && 已还金额未达最低还款）
 * 展示口径统一走这两个函数，避免各处自行计算口径漂移。
 */

export interface PaidJudgeInput {
  amount: number | null;
  paidStatus: string;
  paidAmount: number | null;
}

/** 待还余额：paid→0；partial→max(0, amount-paidAmount)；unpaid/其他→amount（金额未知按 0） */
export function remainingOf(bill: PaidJudgeInput): number {
  if (bill.paidStatus === 'paid') return 0;
  const amount = bill.amount ?? 0;
  if (bill.paidStatus === 'partial') return Math.max(0, amount - (bill.paidAmount ?? 0));
  return amount;
}

export interface OverdueJudgeInput extends PaidJudgeInput {
  dueDate: Date;
  minAmount: number | null;
}

/**
 * 是否逾期：还款日已过 && 未结清 && 已还金额 < 最低还款额。
 * - paid 恒不逾期；
 * - minAmount 未知时保守视为未达标（不豁免）；
 * - partial 且 paidAmount ≥ minAmount 视为已履行最低还款，不算逾期。
 */
export function isOverdue(bill: OverdueJudgeInput, today: Date): boolean {
  if (bill.paidStatus === 'paid') return false;
  if (bill.dueDate.getTime() >= today.getTime()) return false;
  if (bill.minAmount == null) return true;
  return (bill.paidAmount ?? 0) < bill.minAmount;
}
