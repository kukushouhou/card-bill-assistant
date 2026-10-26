import { Tag } from 'antd';
import { formatMoney } from '../lib/money';

/** 年费是账单事实，展示不受提醒已读或还款状态影响。 */
export default function BillAnnualFeeTag({ amount, currency }: { amount: number | null; currency: string }) {
  if (amount == null || amount <= 0) return null;
  return <Tag color="red" style={{ margin: 0 }}>含年费 {formatMoney(amount, currency)}</Tag>;
}
