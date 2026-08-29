import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  CreditCardOutlined,
  FileTextOutlined,
  MoreOutlined,
  UpOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router';
import { Virtuoso } from 'react-virtuoso';
import type {
  BillRow,
  BillsSummary,
  BillsTrend,
  CardRow,
  PagedBills,
} from '../../api/types';
import TrendChart from '../../components/TrendChart';
import {
  InlineConfirm,
  MobileEmpty,
  MobilePullToRefresh,
} from '../../components/MobilePrimitives';
import {
  paidAmountOf,
  paymentStatusOf,
  remainingAmountOf,
} from '../../lib/billPayment';
import './mobile-bills.css';
import { formatMoney } from '../../lib/money';

function cardTailsText(tails: string[]) {
  if (tails.length <= 1) return tails[0] ?? '';
  return `${tails[0]} 等${tails.length}张卡`;
}

function statusTag(row: BillRow) {
  const status = paymentStatusOf(row);
  return <Tag color={status.color}>{status.label}</Tag>;
}

function rowKey(row: BillRow) {
  return row.id != null ? `${row.recordType}-${row.id}` : `missing-${row.cardId}-${row.period}`;
}

export interface MobileBillsViewProps {
  cards: CardRow[];
  banks: string[];
  cardOptions: Array<{ value: number; label: string }>;
  bank?: string;
  cardId?: number;
  data: PagedBills;
  trend: BillsTrend;
  trendMonths: number;
  trendCurrency: string;
  summary: BillsSummary | null;
  trendTitle: string;
  loading: boolean;
  loadError: string | null;
  analyticsError: string | null;
  blocked: boolean;
  blockedReason: string;
  loadedDetailBillId: number | null;
  expandedRows: Set<string>;
  deleteTarget: BillRow | null;
  deleting: boolean;
  onBankChange: (value: string | undefined) => void;
  onCardChange: (value: number | undefined) => void;
  onTrendMonthsChange: (value: number) => void;
  onTrendCurrencyChange: (value: string) => void;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
  onToggle: (row: BillRow) => void;
  onDetails: (row: BillRow) => void;
  onPay: (row: BillRow) => void;
  onDeleteStart: (row: BillRow) => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
  onAbnormal: (row: BillRow) => void;
  onRefresh: () => Promise<unknown>;
  onViewHistory: () => void;
}

export function MobileBillsView({
  cards,
  banks,
  cardOptions,
  bank,
  cardId,
  data,
  trend,
  trendMonths,
  trendCurrency,
  summary,
  trendTitle,
  loading,
  loadError,
  analyticsError,
  blocked,
  blockedReason,
  loadedDetailBillId,
  expandedRows,
  deleteTarget,
  deleting,
  onBankChange,
  onCardChange,
  onTrendMonthsChange,
  onTrendCurrencyChange,
  loadingMore,
  loadMoreError,
  onLoadMore,
  onToggle,
  onDetails,
  onPay,
  onDeleteStart,
  onDeleteCancel,
  onDeleteConfirm,
  onAbnormal,
  onRefresh,
  onViewHistory,
}: MobileBillsViewProps) {
  const navigate = useNavigate();
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setScrollParent(document.getElementById('root'));
  }, []);

  return (
    <MobilePullToRefresh onRefresh={onRefresh} disabled={deleteTarget != null || deleting}>
      <div className="mobile-bills-stack">
        <section className="mobile-bills-panel mobile-bills-filter" aria-labelledby="mobile-bills-filter-title">
          <div id="mobile-bills-filter-title" className="mobile-bills-panel-title">筛选账单</div>
          <div className="mobile-bills-filter-fields">
            <Select
              allowClear
              placeholder="全部银行"
              value={bank}
              onChange={onBankChange}
              options={banks.map((value) => ({ value, label: value }))}
              style={{ width: '100%' }}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="全部卡片"
              value={cardId}
              onChange={onCardChange}
              options={cardOptions}
              style={{ width: '100%' }}
              notFoundContent={cards.length === 0 ? '暂无卡片' : '该银行暂无卡片'}
            />
          </div>
        </section>

        {blocked && (
          <Alert
            type="warning"
            showIcon
            title={blockedReason}
            description="当前可继续查看台账，新的交易明细将在历史拉取结束后开放。"
            action={<Button onClick={onViewHistory}>查看进度</Button>}
          />
        )}

        {loadError && (
          <Alert
            type="error"
            showIcon
            title="账单数据刷新失败"
            description={loadError}
            action={<Button onClick={() => void onRefresh().catch(() => undefined)}>重试</Button>}
          />
        )}

        <section className="mobile-bills-panel mobile-bills-trend" aria-labelledby="mobile-bills-trend-title">
          <div className="mobile-bills-trend-heading">
            <div>
              <div id="mobile-bills-trend-title" className="mobile-bills-panel-title">{trendTitle}</div>
              {summary && (
                <div className="mobile-bills-trend-summary">
                  <Typography.Text type="secondary">
                    共 {summary.billCount} 笔
                  </Typography.Text>
                  {summary.unpaidCount > 0 && (
                    <Typography.Text type="danger">
                      {summary.totalsByCurrency.filter((entry) => entry.unpaidCount > 0)
                        .map((entry) => formatMoney(entry.unpaidTotal, entry.currency)).join(' · ')}
                    </Typography.Text>
                  )}
                  {summary.unknownAmountCount > 0 && (
                    <Typography.Text type="secondary">
                      {summary.unknownAmountCount} 笔金额待填写
                    </Typography.Text>
                  )}
                </div>
              )}
            </div>
            <Space direction="vertical" size={4}>
              <Select size="small" value={trendCurrency} onChange={onTrendCurrencyChange}
                options={trend.currencies.map((currency) => ({ value: currency, label: currency }))} style={{ width: 96 }} />
              <Select
                size="small"
                value={trendMonths}
                onChange={onTrendMonthsChange}
                options={[6, 12, 24, 60].map((value) => ({ value, label: `近 ${value} 月` }))}
                style={{ width: 96 }}
              />
            </Space>
          </div>
          {analyticsError && (
            <Alert
              type="warning"
              showIcon
              title={analyticsError}
              action={<Button onClick={() => void onRefresh().catch(() => undefined)}>重试</Button>}
              className="mobile-bills-analytics-alert"
            />
          )}
          <TrendChart items={trend.items} currency={trend.currency} height={180} />
        </section>

        <section className="mobile-bills-list-section" aria-labelledby="mobile-bills-list-title">
          <div className="mobile-bills-list-heading">
            <div id="mobile-bills-list-title" className="mobile-bills-panel-title">账单列表</div>
            <Space size={4}>
              {loading && data.items.length > 0 && <Spin size="small" />}
              <Button type="link" size="small" onClick={() => navigate('/transactions')}>全部明细</Button>
            </Space>
          </div>

          {data.items.length === 0 ? (
            <MobileEmpty title={loading ? '正在加载账单' : '暂无账单记录'} />
          ) : scrollParent == null ? (
            <div className="mobile-bills-list-preparing"><Spin size="small" /> 正在准备账单列表</div>
          ) : (
            <Virtuoso
              customScrollParent={scrollParent}
              data={data.items}
              computeItemKey={(_, row) => rowKey(row)}
              defaultItemHeight={260}
              increaseViewportBy={{ top: 360, bottom: 640 }}
              endReached={() => {
                if (data.items.length < data.total) onLoadMore();
              }}
              components={{
                Footer: () => {
                  if (loadingMore) {
                    return <div className="mobile-bills-load-footer" role="status"><Spin size="small" /> 正在加载更多账单</div>;
                  }
                  if (loadMoreError) {
                    return <div className="mobile-bills-load-footer" role="status"><Button type="link" onClick={onLoadMore}>加载失败，点击重试</Button></div>;
                  }
                  if (data.items.length < data.total) {
                    return <div className="mobile-bills-load-footer"><Button type="link" onClick={onLoadMore}>继续加载更多</Button></div>;
                  }
                  return null;
                },
              }}
              itemContent={(_, row) => {
                const key = rowKey(row);
                const expanded = expandedRows.has(key);
                const overdue = row.daysOverdue;
                const remainingAmount = remainingAmountOf(row);
                const paidAmount = paidAmountOf(row);
                const confirmingDelete = deleteTarget != null && rowKey(deleteTarget) === key;
                const hasAnnualFee = row.annualFeeAmount != null && row.annualFeeAmount > 0;
                const canViewDetails = !row.missing && row.hasDetails && row.id != null;

                return (
                  <div className="mobile-bill-list-item" data-row-key={key}>
                    <article className={`mobile-bill-card${overdue != null ? ' mobile-bill-card-overdue' : ''}`}>
                      <header className="mobile-bill-card-header">
                        <div className="mobile-bill-card-identity">
                          <span className="mobile-bill-period">
                            {row.recordType === 'custom' ? dayjs(row.dueDate).format('YYYY-MM-DD') : (
                              <>
                                {row.period}期
                                {row.currency !== 'CNY' && <Tag>{row.currency}</Tag>}
                              </>
                            )}
                          </span>
                          <strong>
                            {row.recordType === 'custom'
                              ? row.customName
                              : `${row.bankName}（${cardTailsText(row.cardTails)}）`}
                          </strong>
                        </div>
                        {statusTag(row)}
                      </header>

                      {hasAnnualFee && (
                        <div className="mobile-bill-annual-fee" role="note">
                          本期含年费 <strong>{formatMoney(row.annualFeeAmount!, row.currency)}</strong>
                        </div>
                      )}

                      <div className="mobile-bill-main-facts">
                        <div className="mobile-bill-amount">
                          <Typography.Text type="secondary">待还金额</Typography.Text>
                          {remainingAmount == null ? (
                            <strong className="mobile-bill-missing-amount">
                              {row.recordType === 'custom' ? '金额待填写' : '未取得账单'}
                            </strong>
                          ) : (
                            <Typography.Text
                              type={remainingAmount > 0 ? 'danger' : 'secondary'}
                              className="amount-strong mobile-bill-amount-value"
                            >
                              {formatMoney(remainingAmount, row.currency)}
                            </Typography.Text>
                          )}
                        </div>
                        <div className="mobile-bill-due-date">
                          <Typography.Text type="secondary">还款日</Typography.Text>
                          <strong>{dayjs(row.dueDate).format('YYYY-MM-DD')}</strong>
                        </div>
                      </div>

                      <div className={`mobile-bill-primary-actions${canViewDetails ? ' has-details' : ''}`}>
                        {canViewDetails && (
                          <Button
                            icon={<FileTextOutlined />}
                            disabled={blocked && loadedDetailBillId !== row.id}
                            onClick={() => onDetails(row)}
                          >
                            明细
                          </Button>
                        )}
                        <Button
                          icon={expanded ? <UpOutlined /> : <MoreOutlined />}
                          aria-expanded={expanded}
                          aria-controls={`mobile-bill-more-${key}`}
                          onClick={() => onToggle(row)}
                        >
                          {expanded ? '收起' : '更多'}
                        </Button>
                        <Button type="primary" icon={<CreditCardOutlined />} onClick={() => onPay(row)}>
                          {row.recordType === 'custom' && row.paidStatus === 'paid' ? '恢复待还' : '还款'}
                        </Button>
                      </div>

                      {expanded && (
                        <div id={`mobile-bill-more-${key}`} className="mobile-bill-more-panel">
                          <div className="mobile-bill-meta-grid">
                            {row.recordType === 'card' && (
                              <div><span>出账日</span><strong>{dayjs(row.statementDate).format('YYYY-MM-DD')}</strong></div>
                            )}
                            <div><span>最低还款</span><strong>{row.minAmount == null ? '—' : formatMoney(row.minAmount, row.currency)}</strong></div>
                            <div><span>账单总额</span><strong>{row.amount == null ? '—' : formatMoney(row.amount, row.currency)}</strong></div>
                            <div><span>已还金额</span><strong>{row.amount == null ? '—' : formatMoney(paidAmount, row.currency)}</strong></div>
                          </div>

                          {!confirmingDelete && row.recordType === 'card' && (
                            <div className="mobile-bill-secondary-actions">
                              <Button onClick={() => onAbnormal(row)}>标记异常</Button>
                              {!row.missing && row.id != null && (
                                <Button danger onClick={() => onDeleteStart(row)}>
                                  删除账单
                                </Button>
                              )}
                            </div>
                          )}

                          {confirmingDelete && (
                            <InlineConfirm
                              title="删除该账单记录？"
                              description={`将永久删除 ${row.bankName}（${cardTailsText(row.cardTails)}）${row.period}期账单。此操作不可恢复。`}
                              confirmText="删除账单"
                              loading={deleting}
                              onConfirm={onDeleteConfirm}
                              onCancel={onDeleteCancel}
                            />
                          )}
                        </div>
                      )}
                    </article>
                  </div>
                );
              }}
            />
          )}
        </section>
      </div>
    </MobilePullToRefresh>
  );
}
