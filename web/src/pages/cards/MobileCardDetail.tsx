import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CalendarOutlined,
  DownOutlined,
  FileTextOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { Alert, Button, Empty, Spin, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { api, ApiError } from '../../api/client';
import type { BillDetails, BillRow, CardRow, PagedBills } from '../../api/types';
import { MobileFlow } from '../../components/MobilePrimitives';
import { paymentStatusOf, remainingAmountOf } from '../../lib/billPayment';
import { formatMoney } from '../../lib/money';
import { cardGroupTitle } from '../../lib/business-cards';
import { overdueText } from '../../lib/overdue';

const INITIAL_BILL_COUNT = 3;
const BILL_PAGE_INCREMENT = 12;

function billKey(row: BillRow) {
  return row.id != null ? `bill-${row.id}` : `missing-${row.cardId}-${row.period}-${row.currency}`;
}

function compareBills(a: BillRow, b: BillRow) {
  const aOpen = a.paidStatus !== 'paid';
  const bOpen = b.paidStatus !== 'paid';
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  const dueDiff = dayjs(a.dueDate).valueOf() - dayjs(b.dueDate).valueOf();
  if (dueDiff !== 0) return aOpen ? dueDiff : -dueDiff;
  return (b.id ?? 0) - (a.id ?? 0);
}

async function loadAllCardBills(cardIds: number[]): Promise<BillRow[]> {
  const pageSize = 100;
  let page = 1;
  let items: BillRow[] = [];
  let total = 0;
  do {
    const result = await api.get<PagedBills>(
      `/api/bills?cardIds=${cardIds.join(',')}&page=${page}&pageSize=${pageSize}`,
    );
    items = [...items, ...result.items.filter((row) => row.recordType === 'card')];
    total = result.total;
    page += 1;
  } while (items.length < total);
  return items;
}

function dueCopy(row: BillRow) {
  if (row.daysOverdue != null) return overdueText(row.daysOverdue);
  const days = dayjs(row.dueDate).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (days === 0) return '今天到期';
  if (days === 1) return '明天到期';
  if (days > 1) return `${days} 天后到期`;
  return dayjs(row.dueDate).format('M月D日到期');
}

function transactionAmount(transaction: BillDetails['transactions'][number], fallbackCurrency: string) {
  const currency = transaction.currency ?? fallbackCurrency;
  return (
    <Typography.Text type={transaction.amount >= 0 ? 'danger' : 'success'} className="amount-strong">
      {transaction.amount < 0 ? '+' : ''}{formatMoney(Math.abs(transaction.amount), currency)}
    </Typography.Text>
  );
}

export default function MobileCardDetail({
  cards,
  main,
  focusCardId,
  reloadKey,
  renderCard,
  onBack,
  onMarkPaid,
}: {
  cards: CardRow[];
  main: CardRow;
  focusCardId: number | null;
  reloadKey: number;
  renderCard: (card: CardRow) => ReactNode;
  onBack: () => void;
  onMarkPaid: (bill: BillRow) => void;
}) {
  const [bills, setBills] = useState<BillRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_BILL_COUNT);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<number, BillDetails>>({});
  const [detailErrors, setDetailErrors] = useState<Record<number, string>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null);
  const generation = useRef(0);

  const cardIdsKey = useMemo(() => cards.map((card) => card.id).sort((a, b) => a - b).join(','), [cards]);
  const orderedCards = useMemo(() => {
    const focused = cards.find((card) => card.id === focusCardId) ?? main;
    return [focused, ...cards.filter((card) => card.id !== focused.id)];
  }, [cards, focusCardId, main]);

  const loadBills = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await loadAllCardBills(cards.map((card) => card.id));
      if (currentGeneration !== generation.current) return;
      const unique = new Map<string, BillRow>();
      for (const row of rows) unique.set(billKey(row), row);
      setBills([...unique.values()].sort(compareBills));
    } catch (caught) {
      if (currentGeneration !== generation.current) return;
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : '卡片账单加载失败');
    } finally {
      if (currentGeneration === generation.current) setLoading(false);
    }
  }, [cardIdsKey]);

  useEffect(() => {
    setVisibleCount(INITIAL_BILL_COUNT);
    setExpandedKey(null);
    setDetails({});
    setDetailErrors({});
    void loadBills();
    return () => {
      generation.current += 1;
    };
  }, [loadBills, reloadKey]);

  const openBills = useMemo(() => bills.filter((row) => row.paidStatus !== 'paid'), [bills]);
  const focusBill = openBills[0] ?? bills[0] ?? null;
  const totals = useMemo(() => {
    const values = new Map<string, number>();
    let unknown = 0;
    for (const row of openBills) {
      const remaining = remainingAmountOf(row);
      if (remaining == null) unknown += 1;
      else values.set(row.currency, (values.get(row.currency) ?? 0) + remaining);
    }
    return { values: [...values.entries()], unknown };
  }, [openBills]);
  const visibleBills = bills.slice(0, visibleCount);

  const loadDetails = async (row: BillRow) => {
    if (row.id == null || !row.hasDetails || details[row.id] || detailLoadingId === row.id) return;
    setDetailLoadingId(row.id);
    setDetailErrors((current) => {
      const next = { ...current };
      delete next[row.id!];
      return next;
    });
    try {
      const result = await api.get<BillDetails>(`/api/bills/${row.id}/details`);
      setDetails((current) => ({ ...current, [row.id!]: result }));
    } catch (caught) {
      setDetailErrors((current) => ({
        ...current,
        [row.id!]: caught instanceof ApiError || caught instanceof Error ? caught.message : '交易明细加载失败',
      }));
    } finally {
      setDetailLoadingId((current) => (current === row.id ? null : current));
    }
  };

  const toggleBill = (row: BillRow) => {
    const key = billKey(row);
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    void loadDetails(row);
  };

  const footer = focusBill && focusBill.paidStatus !== 'paid' ? (
    <Button type="primary" block size="large" onClick={() => onMarkPaid(focusBill)}>
      标记已还
    </Button>
  ) : undefined;

  return (
    <MobileFlow
      title={cards.length > 1 ? cardGroupTitle(main.bankName, cards) : `${main.bankName}卡片详情`}
      onBack={onBack}
      className="cards-mobile-detail-flow"
      footer={footer}
    >
      <section className="cards-mobile-detail-carousel" aria-label="套卡内卡片">
        {orderedCards.map((card) => (
          <div className="cards-mobile-detail-carousel-item" key={card.id}>
            {renderCard(card)}
          </div>
        ))}
      </section>

      <section className="cards-mobile-detail-summary" aria-label="本期账单概览">
        {loading && bills.length === 0 ? (
          <div className="cards-mobile-detail-loading"><Spin /><span>正在加载卡片账单</span></div>
        ) : error ? (
          <Alert
            type="error"
            showIcon
            title="卡片账单加载失败"
            description={error}
            action={<Button onClick={() => void loadBills()}>重试</Button>}
          />
        ) : focusBill ? (
          <>
            <div className="cards-mobile-detail-summary-status">
              <span className={focusBill.daysOverdue != null ? 'is-overdue' : undefined}>{dueCopy(focusBill)}</span>
              <Tag color={paymentStatusOf(focusBill).color}>{paymentStatusOf(focusBill).label}</Tag>
            </div>
            <div className={`cards-mobile-detail-total${totals.values.length === 0 ? ' is-text' : ''}`}>
              {totals.values.length > 0 ? totals.values.map(([currency, amount]) => (
                <strong key={currency}>{formatMoney(amount, currency)}</strong>
              )) : <strong>{focusBill.missing ? '未取得账单' : '暂无待还金额'}</strong>}
              {totals.unknown > 0 && <span>{totals.unknown} 笔金额待填写</span>}
            </div>
            <div className="cards-mobile-detail-facts">
              <div><span>还款日</span><strong>{dayjs(focusBill.dueDate).format('MM-DD')}</strong></div>
              <div><span>最低还款</span><strong>{focusBill.minAmount == null ? '—' : formatMoney(focusBill.minAmount, focusBill.currency)}</strong></div>
              <div><span>出账日</span><strong>{focusBill.statementDate ? dayjs(focusBill.statementDate).format('MM-DD') : '—'}</strong></div>
            </div>
          </>
        ) : (
          <Empty description="暂无账单记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </section>

      <section className="cards-mobile-detail-bills" aria-labelledby="cards-mobile-detail-bills-title">
        <div className="cards-mobile-detail-section-heading">
          <div>
            <FileTextOutlined />
            <strong id="cards-mobile-detail-bills-title">账单明细</strong>
          </div>
          {loading && bills.length > 0 && <Spin size="small" />}
        </div>

        {bills.length === 0 && !loading && !error ? (
          <Empty description="暂无历史账单" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div className="cards-mobile-detail-bill-list">
            {visibleBills.map((row) => {
              const key = billKey(row);
              const expanded = expandedKey === key;
              const billDetails = row.id == null ? null : details[row.id] ?? null;
              const detailError = row.id == null ? null : detailErrors[row.id] ?? null;
              return (
                <article className="cards-mobile-detail-bill" key={key}>
                  <button
                    type="button"
                    className="cards-mobile-detail-bill-trigger"
                    aria-expanded={expanded}
                    onClick={() => toggleBill(row)}
                  >
                    <span className="cards-mobile-detail-period-icon"><CalendarOutlined /></span>
                    <span className="cards-mobile-detail-period">
                      <strong>{dayjs(row.statementDate ?? `${row.period}-01`).format('M月 YYYY')}</strong>
                      <small>
                        {row.statementDate ? dayjs(row.statementDate).format('MM-DD') : '—'} 至 {dayjs(row.dueDate).format('MM-DD')}
                      </small>
                    </span>
                    <span className="cards-mobile-detail-bill-amount">
                      <strong>{row.amount == null ? '未取得账单' : formatMoney(row.amount, row.currency)}</strong>
                      <small>{paymentStatusOf(row).label}</small>
                    </span>
                    {expanded ? <UpOutlined /> : <DownOutlined />}
                  </button>

                  {expanded && (
                    <div className="cards-mobile-detail-bill-expanded">
                      <div className="cards-mobile-detail-bill-meta">
                        <span>待还 {remainingAmountOf(row) == null ? '—' : formatMoney(remainingAmountOf(row)!, row.currency)}</span>
                        <Button type="link" size="small" onClick={() => onMarkPaid(row)}>
                          {row.paidStatus === 'paid' ? '调整还款' : '标记已还'}
                        </Button>
                      </div>

                      {row.id == null || !row.hasDetails ? (
                        <div className="cards-mobile-detail-no-transactions">
                          {row.missing ? '本期尚未取得账单与交易明细' : '该期没有可展示的交易明细'}
                        </div>
                      ) : detailLoadingId === row.id && !billDetails ? (
                        <div className="cards-mobile-detail-loading"><Spin size="small" /><span>正在加载交易明细</span></div>
                      ) : detailError ? (
                        <Alert
                          type="error"
                          showIcon
                          title="交易明细加载失败"
                          description={detailError}
                          action={<Button onClick={() => void loadDetails(row)}>重试</Button>}
                        />
                      ) : billDetails && billDetails.transactions.length > 0 ? (
                        <div className="cards-mobile-detail-transactions">
                          {billDetails.transactions.map((transaction, index) => (
                            <div className="cards-mobile-detail-transaction" key={transaction.id ?? `${transaction.date}-${index}`}>
                              <div>
                                <strong>{transaction.description}</strong>
                                <span>
                                  {transaction.date || '交易日期未提供'}
                                  {transaction.cardLast4 ? ` · 尾号 ${transaction.cardLast4}` : ''}
                                </span>
                              </div>
                              {transactionAmount(transaction, billDetails.currency)}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="cards-mobile-detail-no-transactions">该期未解析到交易明细</div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {bills.length > INITIAL_BILL_COUNT && (
          <Button
            type="link"
            block
            className="cards-mobile-detail-more-bills"
            onClick={() => setVisibleCount((current) => (
              current >= bills.length ? INITIAL_BILL_COUNT : Math.min(bills.length, current + BILL_PAGE_INCREMENT)
            ))}
          >
            {visibleCount >= bills.length
              ? '收起历史账单'
              : `继续查看（剩余 ${bills.length - visibleCount} 笔）`}
          </Button>
        )}
      </section>
    </MobileFlow>
  );
}
