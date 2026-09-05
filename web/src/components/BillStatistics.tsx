import { useState } from 'react';
import { Alert, Button, Select, Skeleton, Space } from 'antd';
import type { BillsSummary, BillsTrend } from '../api/types';
import { useResource } from '../lib/useResource';
import BusinessFlow from './BusinessFlow';
import TrendChart from './TrendChart';
import AmountSummary from './AmountSummary';

export default function BillStatistics({ scope, onClose }: { scope: string; onClose: () => void }) {
  const [months, setMonths] = useState(12);
  const [currency, setCurrency] = useState('CNY');
  const summary = useResource<BillsSummary>('/api/bills/summary?' + scope);
  const trend = useResource<BillsTrend>('/api/bills/trend?' + scope + '&months=' + months + '&currency=' + currency);
  return <BusinessFlow title="账单统计" onClose={onClose}>
    {summary.error && <Alert type="error" title={summary.error} action={<Button onClick={() => void summary.refresh()}>重试</Button>} />}
    {summary.data && <AmountSummary title="待还合计" amounts={summary.data.totalsByCurrency.filter(item => item.unpaidCount > 0).map(item => ({ currency: item.currency, amount: item.unpaidTotal }))}
      metrics={[{ count: summary.data.billCount, label: '笔账单', prefix: '共 ' }]}
      notices={summary.data.unknownAmountCount > 0 ? [{ count: summary.data.unknownAmountCount, label: '金额待填写' }] : []} />}
    <Space style={{ margin: '24px 0' }} wrap><Select aria-label="统计月份" value={months} onChange={setMonths} options={[6, 12, 24].map(value => ({ value, label: '近 ' + value + ' 个月' }))} /><Select aria-label="统计币种" value={currency} onChange={setCurrency} options={(trend.data?.currencies ?? ['CNY']).map(value => ({ value, label: value }))} /></Space>
    {trend.error && <Alert type="error" title={trend.error} action={<Button onClick={() => void trend.refresh()}>重试</Button>} />}
    {trend.data ? <TrendChart items={trend.data.items} currency={trend.data.currency} height={120} /> : <Skeleton active />}
  </BusinessFlow>;
}
