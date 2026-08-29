import { addDays } from '../../lib/dates';
import {
  buildLedger,
  type LedgerBillInput,
  type LedgerCard,
} from '../bills/ledger';

export interface TodoListItem {
  /** 未取得账单占位行没有数据库记录 */
  billId: number | null;
  cardId: number;
  bankName: string;
  cardTails: string[];
  period: string;
  statementDate: Date;
  dueDate: Date;
  amount: number | null;
  minAmount: number | null;
  currency: string;
  paidStatus: string | null;
  paidAmount: number | null;
  missing: boolean;
  daysOverdue: number | null;
}

/**
 * 今日待办：所有逾期未还 + 今天和未来 2 天到期的未还账期。
 *
 * 占位行完全复用 buildLedger/openMissingCycle 契约，保证注销卡、
 * 未过出账日、还款日 +30 天后隐藏等边界不会在首页另起一套逻辑。
 */
export function collectTodoItems(
  scopeCards: LedgerCard[],
  allCards: LedgerCard[],
  bills: LedgerBillInput[],
  now: Date,
): TodoListItem[] {
  const horizon = addDays(now, 3);

  return buildLedger(scopeCards, allCards, bills, now)
    .filter((row) => row.paidStatus !== 'paid' && row.dueDate < horizon)
    .map((row) => ({
      billId: row.id,
      cardId: row.cardId,
      bankName: row.bankName,
      cardTails: row.cardTails,
      period: row.period,
      statementDate: row.statementDate,
      dueDate: row.dueDate,
      amount: row.amount,
      minAmount: row.minAmount,
      currency: row.currency,
      paidStatus: row.paidStatus,
      paidAmount: row.paidAmount,
      missing: row.missing,
      daysOverdue: row.daysOverdue,
    }))
    // 直接按实际/规则还款日升序：逾期日期天然排在今天和未来之前。
    .sort((a, b) => {
      const dueDiff = a.dueDate.getTime() - b.dueDate.getTime();
      if (dueDiff !== 0) return dueDiff;
      if (a.cardId !== b.cardId) return a.cardId - b.cardId;
      return (a.billId ?? 0) - (b.billId ?? 0);
    });
}
