import { Tag } from 'antd';
import type { TransactionContext } from '../api/types';
import { billDueNotice } from '../lib/billDue';
import { paymentStatusOf } from '../lib/billPayment';
import { displayDate } from '../lib/displayDate';
import { formatMoney } from '../lib/money';

/** 本账单概况取自账单事实，不将当前页交易相加冒充应还金额。 */
export default function TransactionBillSummary({ bill }: { bill: TransactionContext }) {
  const status = paymentStatusOf(bill);
  const due = billDueNotice({ ...bill, missing: false });
  return <section className="transaction-bill-summary" aria-label="本账单还款概况">
    <div className="transaction-bill-total"><span>本期应还总额</span><strong className="agenda-amount">{bill.amount == null ? '金额待填写' : formatMoney(bill.amount, bill.currency)}</strong></div>
    <dl className="transaction-bill-facts">
      <div className="transaction-bill-status"><dt>还款状态</dt><dd><Tag color={status.color}>{status.label}</Tag>{due && due.tone !== 'overdue' && <span className={'transaction-due transaction-due-' + due.tone}>{due.label}</span>}</dd></div>
      <div><dt>还款日</dt><dd>{displayDate(bill.dueDate)}</dd></div>
      {bill.minAmount != null && <div><dt>最低还款</dt><dd>{formatMoney(bill.minAmount, bill.currency)}</dd></div>}
      {bill.paidStatus === 'partial' && <>
        <div><dt>已还金额</dt><dd>{formatMoney(bill.paidAmount ?? 0, bill.currency)}</dd></div>
        <div><dt>剩余待还</dt><dd className="transaction-remaining">{bill.remainingAmount == null ? '金额待填写' : formatMoney(bill.remainingAmount, bill.currency)}</dd></div>
      </>}
      {bill.statementDate && <div><dt>出账日</dt><dd>{displayDate(bill.statementDate)}</dd></div>}
      {bill.paidStatus === 'paid' && bill.paidAt && <div><dt>还清日期</dt><dd>{displayDate(bill.paidAt)}</dd></div>}
    </dl>
  </section>;
}
