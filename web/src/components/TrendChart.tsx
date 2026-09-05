import { useContext } from 'react';
import { SkinAssetsContext } from '../skins/SkinAssets';
import { displayPeriod } from '../lib/displayDate';
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
  const appearance = useContext(SkinAssetsContext);
  const visual = appearance?.skin.manifest.variants[appearance.variant].tokens;
  const chart = visual?.chart ?? { lineWidth: 1.5, pointSize: 3, gridWidth: 1, axisFontSize: 12 };
  const color = visual?.chartColors[0] ?? '#275da8';
  const valid = items.filter((i) => i.total != null);
  if (valid.length === 0) {
    return <Empty description="暂无账单数据" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '16px 0' }} />;
  }

  return (
    <div className="trend-wrap" data-skin-slot="chart">
      <Line
        data={items.map(item => ({ ...item, periodLabel: displayPeriod(item.period) }))}
        xField="period"
        yField="total"
        height={height}
        autoFit
        animate={false}
        theme={appearance?.variant.endsWith('dark') ? 'dark' : 'light'}
        scale={{ color: { range: visual?.chartColors ?? [color] } }}
        style={{ stroke: color, lineWidth: chart.lineWidth }}
        point={{ style: { r: chart.pointSize, fill: color, stroke: color, lineWidth: 0 } }}
        axis={{
          x: {
            title: false,
            labelFontSize: Math.max(11, chart.axisFontSize - (isMobile ? 1 : 0)),
            labelAutoRotate: false,
            labelAutoHide: true,
            labelFormatter: (v: string) => displayPeriod(v),
            labelFill: visual?.textSecondary, labelOpacity: 1, labelFontFamily: visual?.fontFamily,
          },
          y: {
            title: false,
            labelFontSize: chart.axisFontSize,
            labelFill: visual?.textSecondary, labelOpacity: 1, labelFontFamily: visual?.fontFamily,
            gridStroke: visual?.border, gridLineWidth: chart.gridWidth,
            labelFormatter: (t: number) =>
              t >= 10000 ? `${(t / 10000).toFixed(t % 10000 === 0 ? 0 : 1)}万` : String(t),
          },
        }}
        tooltip={{
          title: 'periodLabel',
          items: [
            {
              field: 'total',
              name: '金额',
              valueFormatter: (v: number | null) => (v == null ? '—' : formatMoney(Number(v), currency)),
            },
            { field: 'count', name: '笔数', valueFormatter: (v: number) => `${v} 笔` },
          ],
        }}
        interaction={{ tooltip: { shared: true, wait: 0 } }}
        legend={false}
      />
    </div>
  );
}
