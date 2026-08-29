import { Empty } from 'antd';
import { Line } from '@ant-design/plots';
import type { TrendItem } from '../api/types';
import { useResponsive } from '../responsive';
import { formatMoney } from '../lib/money';

/**
 * 账单金额走势（@ant-design/plots 现成折线）：
 * - 无数据月份 total=null 断线
 * - 悬停立刻显示期次 / 金额 / 笔数（组件内置 tooltip）
 * - 手机端保持月份横排并自动抽稀，避免坐标轴挤占绘图区
 */
export default function TrendChart({
  items,
  currency = 'CNY',
  height = 120,
}: {
  items: TrendItem[];
  currency?: string;
  height?: number;
}) {
  const { isMobile } = useResponsive();
  const valid = items.filter((i) => i.total != null);
  if (valid.length === 0) {
    return <Empty description="暂无账单数据" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '16px 0' }} />;
  }

  return (
    <div className="trend-wrap">
      <Line
        data={items}
        xField="period"
        yField="total"
        height={height}
        autoFit
        animate={false}
        style={{ stroke: '#1677ff', lineWidth: 1.5 }}
        point={{ size: 3, style: { fill: '#1677ff' } }}
        axis={{
          x: {
            title: false,
            labelFontSize: isMobile ? 10 : 11,
            labelAutoRotate: false,
            labelAutoHide: true,
            labelFormatter: (v: string) => String(v).slice(2).replace('-', '/'),
          },
          y: {
            title: false,
            labelFontSize: 11,
            labelFormatter: (t: number) =>
              t >= 10000 ? `${(t / 10000).toFixed(t % 10000 === 0 ? 0 : 1)}万` : String(t),
          },
        }}
        tooltip={{
          title: 'period',
          items: [
            {
              field: 'total',
              name: '金额',
              valueFormatter: (v: number | null) => (v == null ? '—' : formatMoney(Number(v), currency)),
            },
            { field: 'count', name: '笔数', valueFormatter: (v: number) => `${v} 笔` },
          ],
        }}
        legend={false}
      />
    </div>
  );
}
