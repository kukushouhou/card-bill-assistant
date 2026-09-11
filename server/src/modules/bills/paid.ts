import type { Prisma } from '../../generated/prisma/client';

/**
 * 账单还款判定纯函数：
 * - remainingOf：待还余额（paid→0；partial→amount-paidAmount；unpaid→amount）
 * - isOverdue：是否逾期（按「逾期提醒」设置口径判定）
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

/** 逾期提醒口径：all=未全额还清即逾期（默认）；minimum=未还够最低还款额才算逾期。 */
export type OverdueBasis = 'all' | 'minimum';
export const OVERDUE_BASIS_KEY = 'overdue.basis';
export const DEFAULT_OVERDUE_BASIS: OverdueBasis = 'all';

/** 非法或缺失的设置值一律回落默认口径。 */
export function parseOverdueBasis(value: string | null | undefined): OverdueBasis {
  return value === 'minimum' ? 'minimum' : DEFAULT_OVERDUE_BASIS;
}

export async function readOverdueBasis(db: Pick<Prisma.TransactionClient, 'appSetting'>): Promise<OverdueBasis> {
  const row = await db.appSetting.findUnique({ where: { key: OVERDUE_BASIS_KEY } });
  return parseOverdueBasis(row?.value);
}

/**
 * 是否逾期：还款日已过且未结清，再按「逾期提醒」设置口径判定。
 * - paid 恒不逾期；
 * - 「未全额还清」口径：过了还款日未结清即逾期（不看最低还款额）；
 * - 「未还最低还款额」口径：minAmount 未知时保守视为未达标（不豁免），
 *   已还金额 ≥ 最低还款额视为已履行最低还款，不算逾期。
 */
export function isOverdue(bill: OverdueJudgeInput, today: Date, basis: OverdueBasis = DEFAULT_OVERDUE_BASIS): boolean {
  if (bill.paidStatus === 'paid') return false;
  if (bill.dueDate.getTime() >= today.getTime()) return false;
  if (basis === 'minimum') {
    if (bill.minAmount == null) return true;
    return (bill.paidAmount ?? 0) < bill.minAmount;
  }
  return true;
}
