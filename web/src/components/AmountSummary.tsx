import { currencyPrefix, formatMoney } from '../lib/money';
import { ExclamationCircleFilled, WalletOutlined } from '../skins/icons';
import './agenda.css';

const currencyNames: Record<string, string> = {
  CNY: '人民币', USD: '美元', EUR: '欧元', GBP: '英镑', HKD: '港币',
  AUD: '澳元', CAD: '加元', JPY: '日元', KRW: '韩元',
};
type Amount = { currency: string; amount: number };
type SummaryCount = { count: number; label: string; prefix?: string };

function Balance({ currency, amount }: Amount) {
  const code = currency.toUpperCase();
  const formatted = formatMoney(amount, code);
  const prefix = currencyPrefix(code);
  const number = formatted.slice(prefix.length).trim();
  const symbol = code === 'CNY' ? prefix : prefix.slice(code.length).trim();
  return <strong className={'agenda-summary-value agenda-amount' + (number.length > 11 ? ' agenda-summary-value-long' : '')}>
    <span className="agenda-summary-readable">{formatted}</span>
    {symbol && <span className="agenda-summary-unit" aria-hidden="true">{symbol}</span>}
    <span className="agenda-summary-number" aria-hidden="true">{number}</span>
  </strong>;
}

/** 主币种作为阅读焦点，其他币种独立呈现；缺少的信息单列为状态区域。 */
export default function AmountSummary({
  title,
  amounts,
  metrics,
  notices = [],
}: {
  title: string;
  amounts: Amount[];
  metrics: SummaryCount[];
  notices?: SummaryCount[];
}) {
  // 只调整展示顺序，不换算币种或重新计算合计。
  const primary = amounts.find(entry => entry.currency.toUpperCase() === 'CNY') ?? amounts[0];
  const others = amounts.filter(entry => entry !== primary);
  return <section className="agenda-totals" data-skin-slot="summary" aria-label={title}>
    <div className="agenda-summary-overview">
      <header className="agenda-summary-header">
        <div className="agenda-summary-title"><span className="agenda-summary-icon" aria-hidden="true"><WalletOutlined /></span><span>{title}</span></div>
        <ul className="agenda-summary-metrics">{metrics.map(metric => <li key={metric.label}>{metric.prefix}<strong>{metric.count}</strong> {metric.label}</li>)}</ul>
      </header>
      <div className={'agenda-summary-amounts' + (others.length ? ' agenda-summary-multiple' : '')}>
        {primary ? <div className="agenda-summary-primary">
          <div className="agenda-summary-currency-name">{currencyNames[primary.currency.toUpperCase()] ?? primary.currency.toUpperCase()}{currencyNames[primary.currency.toUpperCase()] && <span>{primary.currency.toUpperCase()}</span>}</div>
          <Balance {...primary} />
        </div> : <span className="agenda-summary-empty">暂无可汇总金额</span>}
        {others.length > 0 && <dl className="agenda-summary-other">{others.map(entry => <div className="agenda-summary-currency" key={entry.currency}>
          <dt><span className="agenda-summary-currency-code">{entry.currency.toUpperCase()}</span>{currencyNames[entry.currency.toUpperCase()] && <span>{currencyNames[entry.currency.toUpperCase()]}</span>}</dt>
          <dd><Balance {...entry} /></dd>
        </div>)}</dl>}
      </div>
    </div>
    {notices.length > 0 && <div className="agenda-summary-notices">
      <span className="agenda-summary-notice-heading"><ExclamationCircleFilled aria-hidden="true" /><span>待补充</span></span>
      <ul className="agenda-summary-notes">{notices.map(notice => <li key={notice.label}>
        <span className="agenda-summary-notice-label">{notice.label}</span>
        <span className="agenda-summary-notice-count"><strong>{notice.count}</strong> <span>笔</span></span>
      </li>)}</ul>
    </div>}
  </section>;
}
