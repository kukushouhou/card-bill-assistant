import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api, ApiError } from '../api/client';
import type {
  BillDetails,
  BillRow,
  BillsSummary,
  BillsTrend,
  CardRow,
  PagedBills,
} from '../api/types';
import { Page } from '../components/Layout';
import MarkAbnormalModal, { type MarkAbnormalTarget } from '../components/MarkAbnormalModal';
import MarkPaidModal, { type MarkPaidTarget } from '../components/MarkPaidModal';
import TrendChart from '../components/TrendChart';
import {
  billCardTailsText as cardTailsText,
  DesktopBillDetailsContent,
  MobileBillDetails,
} from '../components/BillDetailsView';
import { useCoalescedRefresh, useMobileFlowNavigation } from '../components/MobilePrimitives';
import { useResetOnModeChange, useResponsive } from '../responsive';
import { useHistoryGate } from '../historyGate';
import { MobileBillsView } from './bills/MobileBillsView';
import {
  paidAmountOf,
  paymentStatusOf,
  remainingAmountOf,
} from '../lib/billPayment';
import { formatMoney } from '../lib/money';

function cardIdFromParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

class BillsAnalyticsLoadError extends Error {
  constructor() {
    super('账单走势或汇总暂时加载失败');
    this.name = 'BillsAnalyticsLoadError';
  }
}

export default function Bills() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const navigateFromMobileFlow = useMobileFlowNavigation();
  const { isMobile } = useResponsive();
  const { blocked, blockedReason, mayRunRestrictedAction } = useHistoryGate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cards, setCards] = useState<CardRow[]>([]);
  const [cardId, setCardId] = useState<number | undefined>(() => cardIdFromParam(searchParams.get('cardId')));
  const [bank, setBank] = useState<string | undefined>();
  const [data, setData] = useState<PagedBills>({ total: 0, page: 1, pageSize: 20, items: [] });
  const [trend, setTrend] = useState<BillsTrend>({ months: 12, currency: 'CNY', currencies: ['CNY'], items: [] });
  const [trendMonths, setTrendMonths] = useState(12);
  const [trendCurrency, setTrendCurrency] = useState('CNY');
  const [summary, setSummary] = useState<BillsSummary | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailBill, setDetailBill] = useState<BillRow | null>(null);
  const [details, setDetails] = useState<BillDetails | null>(null);
  const [markTarget, setMarkTarget] = useState<MarkPaidTarget | null>(null);
  const [abnormalTarget, setAbnormalTarget] = useState<MarkAbnormalTarget | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState<BillRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const mobileFlowActive = isMobile && (detailOpen || markTarget != null || abnormalTarget != null);
  const loadGeneration = useRef(0);
  const cardsGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const readsInFlight = useRef(new Map<string, Promise<void>>());
  const loadMoreRequested = useRef(false);
  const deletingRef = useRef(false);

  const banks = Array.from(new Set(cards.map((c) => c.bankName))).sort();
  const cardOptions = cards
    .filter((c) => !bank || c.bankName === bank)
    .map((c) => ({ value: c.id, label: `${c.bankName}（${c.cardLast4}）` }));
  const bankFilter = cardId ? undefined : bank;

  const openCardStatus = useCallback((row: BillRow) => {
    if (row.recordType !== 'card' || row.cardId == null || !row.bankName || !row.cardLast4) return;
    const card = cards.find((item) => item.id === row.cardId);
    if (!card) {
      message.error('卡片状态暂时无法读取，请刷新后重试');
      return;
    }
    setAbnormalTarget({
      cardId: row.cardId,
      bankName: row.bankName,
      cardLast4: row.cardLast4,
      status: card.status,
    });
  }, [cards, message]);

  const load = useCallback((
    force = false,
    options?: { requestedPage?: number; append?: boolean },
  ) => {
    const requestedPage = options?.requestedPage ?? page;
    const append = options?.append ?? (isMobile && requestedPage > 1);
    const scopeKey = `${requestedPage}|${cardId ?? ''}|${bankFilter ?? ''}|${trendMonths}|${trendCurrency}|${append ? 'append' : 'replace'}`;
    const existing = readsInFlight.current.get(scopeKey);
    if (!force && existing) return existing;

    const generation = ++loadGeneration.current;
    let pending: Promise<void>;
    pending = (async () => {
      if (append) {
        setLoadingMore(true);
        setLoadMoreError(null);
      } else {
        loadMoreRequested.current = false;
        setLoadingMore(false);
        setLoadMoreError(null);
        setLoading(true);
        setLoadError(null);
        setAnalyticsError(null);
      }
      try {
        const q = new URLSearchParams({ page: String(requestedPage), pageSize: '20' });
        if (cardId) q.set('cardId', String(cardId));
        else if (bankFilter) q.set('bank', bankFilter);
        if (append) {
          const next = await api.get<PagedBills>(`/api/bills?${q}`);
          if (generation !== loadGeneration.current) return;
          setData((current) => {
            const seen = new Set<string>();
            const items = [...current.items, ...next.items].filter((row) => {
              const key = row.id != null ? `${row.recordType}-${row.id}` : `missing-${row.cardId}-${row.period}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            return { ...next, items };
          });
        } else {
          const filterQuery = cardId
            ? `cardId=${cardId}`
            : bankFilter
              ? `bank=${encodeURIComponent(bankFilter)}`
              : '';
          const [billsResult, trendResult, summaryResult] = await Promise.allSettled([
            api.get<PagedBills>(`/api/bills?${q}`),
            api.get<BillsTrend>(`/api/bills/trend?months=${trendMonths}&currency=${trendCurrency}${filterQuery ? `&${filterQuery}` : ''}`),
            api.get<BillsSummary>(`/api/bills/summary?${filterQuery}`),
          ]);
          if (generation !== loadGeneration.current) return;

          if (trendResult.status === 'fulfilled') {
            setTrend(trendResult.value);
            if (trendResult.value.currency !== trendCurrency) setTrendCurrency(trendResult.value.currency);
          }
          if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value);
          if (trendResult.status === 'rejected' || summaryResult.status === 'rejected') {
            setAnalyticsError('账单走势或汇总暂时加载失败，账单列表仍可正常使用。');
          }

          if (billsResult.status === 'rejected') throw billsResult.reason;
          setData(billsResult.value);
          // 列表成功时继续保留并展示；但让下拉刷新感知局部失败，不能误报“已完成”。
          if (trendResult.status === 'rejected' || summaryResult.status === 'rejected') {
            throw new BillsAnalyticsLoadError();
          }
        }
      } catch (err) {
        if (generation !== loadGeneration.current) return;
        if (err instanceof BillsAnalyticsLoadError) throw err;
        const text = err instanceof ApiError ? err.message : '账单数据加载失败';
        if (append) setLoadMoreError(text);
        else setLoadError(text);
        throw err;
      } finally {
        if (generation === loadGeneration.current) {
          if (append) {
            loadMoreRequested.current = false;
            setLoadingMore(false);
          } else {
            setLoading(false);
          }
        }
      }
    })().finally(() => {
      if (readsInFlight.current.get(scopeKey) === pending) readsInFlight.current.delete(scopeKey);
    });

    readsInFlight.current.set(scopeKey, pending);
    return pending;
  }, [page, cardId, bankFilter, trendMonths, trendCurrency, isMobile]);

  const refresh = useCoalescedRefresh(() => {
    if (!isMobile) return load(false);
    loadMoreRequested.current = false;
    if (page !== 1) setPage(1);
    return load(false, { requestedPage: 1, append: false });
  });

  const loadCards = useCallback(async () => {
    const generation = ++cardsGeneration.current;
    try {
      const next = await api.get<CardRow[]>('/api/cards');
      if (generation === cardsGeneration.current) setCards(next);
    } catch {
      // 卡片筛选参考数据失败不覆盖已加载内容，账单本体仍可独立重试。
    }
  }, []);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  useEffect(
    () => () => {
      loadGeneration.current += 1;
      cardsGeneration.current += 1;
      detailGeneration.current += 1;
      readsInFlight.current.clear();
    },
    [],
  );

  useResetOnModeChange(() => {
    loadMoreRequested.current = false;
    setPage(1);
    setExpandedRows(new Set());
    setDeleteTarget(null);
  });

  // 外部跳转（如首页未来 14 天）带 cardId 参数时自动筛选
  useEffect(() => {
    const id = cardIdFromParam(searchParams.get('cardId'));
    setCardId((prev) => (prev === id ? prev : id));
    if (id) {
      const card = cards.find((c) => c.id === id);
      if (card) setBank((current) => (current === card.bankName ? current : card.bankName));
    }
  }, [searchParams, cards]);

  const changeCard = (v: number | undefined) => {
    loadMoreRequested.current = false;
    setPage(1);
    setCardId(v);
    const next = new URLSearchParams(searchParams);
    if (v) next.set('cardId', String(v));
    else next.delete('cardId');
    setSearchParams(next, { replace: true });
  };

  const changeBank = (v: string | undefined) => {
    loadMoreRequested.current = false;
    setPage(1);
    setBank(v);
    // 切换银行时若当前卡片不属于该银行则清空卡片选择
    if (v && cardId) {
      const card = cards.find((c) => c.id === cardId);
      if (card && card.bankName !== v) changeCard(undefined);
    }
  };

  const reloadAfterWrite = useCallback(() => {
    if (!isMobile) return load(true);
    loadMoreRequested.current = false;
    if (page !== 1) setPage(1);
    return load(true, { requestedPage: 1, append: false });
  }, [isMobile, load, page]);

  const loadNextPage = useCallback(() => {
    if (!isMobile || loading || loadingMore || loadMoreRequested.current || data.items.length >= data.total) return;
    loadMoreRequested.current = true;
    if (loadMoreError) {
      void load(true, { requestedPage: page, append: true }).catch(() => undefined);
      return;
    }
    setPage((current) => current + 1);
  }, [data.items.length, data.total, isMobile, load, loadMoreError, loading, loadingMore, page]);

  const changeTrendMonths = (value: number) => {
    setTrendMonths(value);
    if (isMobile) {
      loadMoreRequested.current = false;
      setPage(1);
    }
  };

  const changeTrendCurrency = (value: string) => {
    setTrendCurrency(value);
    if (isMobile) {
      loadMoreRequested.current = false;
      setPage(1);
    }
  };

  const remove = async (id: number) => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await api.delete(`/api/bills/${id}`);
      message.success('已删除');
      setDeleteTarget(null);
      await reloadAfterWrite().catch(() => undefined);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const openDetails = async (bill: BillRow) => {
    if (bill.id == null) return;
    if (!mayRunRestrictedAction()) {
      if (detailBill?.id === bill.id && details != null) {
        setDetailOpen(true);
        setDetailError(null);
        return;
      }
      message.warning(blockedReason);
      return;
    }
    const generation = ++detailGeneration.current;
    setDetailBill(bill);
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    setDetails(null);
    try {
      const next = await api.get<BillDetails>(`/api/bills/${bill.id}/details`);
      if (generation === detailGeneration.current) setDetails(next);
    } catch (err) {
      if (generation !== detailGeneration.current) return;
      setDetailError(err instanceof ApiError ? err.message : '获取明细失败');
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  };

  const closeDetails = () => {
    detailGeneration.current += 1;
    setDetailOpen(false);
    setDetailLoading(false);
    setDetailError(null);
  };

  const rowKey = (row: BillRow) =>
    row.id != null ? `${row.recordType}-${row.id}` : `missing-${row.cardId}-${row.period}`;

  const toggleRow = (row: BillRow) => {
    const key = rowKey(row);
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setPaymentTarget = (row: BillRow) => {
    if (row.recordType === 'custom' && row.customOccurrenceId && row.customBusinessType && row.customName) {
      setMarkTarget({
        targetType: 'custom',
        occurrenceId: row.customOccurrenceId,
        businessType: row.customBusinessType,
        name: row.customName,
        cardId: 0,
        bankName: row.customName,
        cardLast4: '',
        period: '',
        currency: row.currency,
        amount: row.amount,
        paidStatus: row.paidStatus,
      });
      return;
    }
    if (row.cardId == null || !row.bankName || !row.cardLast4) return;
    setMarkTarget(
      row.missing
        ? {
            cardId: row.cardId,
            bankName: row.bankName,
            cardLast4: row.cardLast4,
            period: row.period,
            currency: row.currency,
          }
        : {
            cardId: row.cardId,
            bankName: row.bankName,
            cardLast4: row.cardLast4,
            period: row.period,
            currency: row.currency,
            billId: row.id ?? undefined,
            amount: row.amount,
            minAmount: row.minAmount,
            paidStatus: row.paidStatus,
            paidAmount: row.paidAmount,
          },
    );
  };

  const trendTitle = cardId
    ? '该卡各期账单金额'
    : bank
      ? `${bank} 每月账单合计`
      : '每月账单合计';

  return (
    <>
      <div aria-hidden={mobileFlowActive || undefined} inert={mobileFlowActive || undefined}>
        <Page
          title="账单记录"
          extra={
            <Space>
              <Select
                allowClear
                placeholder="全部银行"
                style={{ width: 150 }}
                value={bank}
                onChange={changeBank}
                options={banks.map((b) => ({ value: b, label: b }))}
              />
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="全部卡片"
                style={{ width: 200 }}
                value={cardId}
                onChange={changeCard}
                options={cardOptions}
              />
              <Button
                icon={<ReloadOutlined />}
                onClick={() => void refresh().catch(() => undefined)}
                loading={loading}
                disabled={deleting}
              >
                刷新
              </Button>
            </Space>
          }
        >
          {isMobile ? (
            <MobileBillsView
              cards={cards}
              banks={banks}
              cardOptions={cardOptions}
              bank={bank}
              cardId={cardId}
              data={data}
              trend={trend}
              trendMonths={trendMonths}
              trendCurrency={trendCurrency}
              summary={summary}
              trendTitle={trendTitle}
              loading={loading}
              loadingMore={loadingMore}
              loadMoreError={loadMoreError}
              loadError={loadError}
              analyticsError={analyticsError}
              blocked={blocked}
              blockedReason={blockedReason}
              loadedDetailBillId={details != null ? detailBill?.id ?? null : null}
              expandedRows={expandedRows}
              deleteTarget={deleteTarget}
              deleting={deleting}
              onBankChange={changeBank}
              onCardChange={changeCard}
              onTrendMonthsChange={changeTrendMonths}
              onTrendCurrencyChange={changeTrendCurrency}
              onLoadMore={loadNextPage}
              onToggle={toggleRow}
              onDetails={(row) => void openDetails(row)}
              onPay={setPaymentTarget}
              onDeleteStart={setDeleteTarget}
              onDeleteCancel={() => setDeleteTarget(null)}
              onDeleteConfirm={() => {
                if (deleteTarget?.id != null) void remove(deleteTarget.id);
              }}
              onAbnormal={openCardStatus}
              onRefresh={refresh}
              onViewHistory={() => navigate('/email', { state: { showHistoryProgress: true } })}
            />
          ) : (
            <>
      {blocked && (
        <Alert
          type="warning"
          showIcon
          title={blockedReason}
          description="账单台账仍可查看，新的交易明细将在历史拉取结束后开放。"
          action={<Button onClick={() => navigate('/email', { state: { showHistoryProgress: true } })}>查看进度</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      {loadError && (
        <Alert
          type="error"
          showIcon
          title="账单数据刷新失败"
          description={loadError}
          action={<Button onClick={() => void refresh().catch(() => undefined)}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      <Card size="small" style={{ marginBottom: 16 }} variant="outlined" title={trendTitle} extra={
        <Space size={12}>
          {summary ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {summary.billCount} 笔
              {summary.totalsByCurrency.filter((entry) => entry.unpaidCount > 0).map((entry) => (
                <Typography.Text key={entry.currency} type="danger" style={{ marginLeft: 8 }}>
                  待还 {formatMoney(entry.unpaidTotal, entry.currency)}
                </Typography.Text>
              ))}
              {summary.unknownAmountCount > 0 && (
                <Typography.Text style={{ marginLeft: 8 }}>
                  {summary.unknownAmountCount} 笔金额待填写
                </Typography.Text>
              )}
            </Typography.Text>
          ) : null}
          <Select
            size="small"
            style={{ width: 86 }}
            value={trendCurrency}
            onChange={setTrendCurrency}
            options={trend.currencies.map((currency) => ({ value: currency, label: currency }))}
          />
          <Select
            size="small"
            style={{ width: 92 }}
            value={trendMonths}
            onChange={setTrendMonths}
            options={[
              { value: 6, label: '近 6 月' },
              { value: 12, label: '近 12 月' },
              { value: 24, label: '近 24 月' },
              { value: 60, label: '近 60 月' },
            ]}
          />
        </Space>
      }>
        {analyticsError && (
          <Alert
            type="warning"
            showIcon
            title={analyticsError}
            action={<Button onClick={() => void refresh().catch(() => undefined)}>重试</Button>}
            style={{ marginBottom: 12 }}
          />
        )}
        <TrendChart items={trend.items} currency={trend.currency} height={180} />
      </Card>

      <Table<BillRow>
        rowKey={rowKey}
        loading={loading}
        dataSource={data.items}
        pagination={{
          current: data.page,
          pageSize: data.pageSize,
          total: data.total,
          onChange: setPage,
          showTotal: (t) => `共 ${t} 条`,
        }}
        columns={[
          {
            title: '账期 / 日期',
            key: 'period',
            width: 110,
            render: (_, row) => row.recordType === 'custom' ? dayjs(row.dueDate).format('YYYY-MM-DD') : row.period,
          },
          {
            title: '银行 / 尾号',
            key: 'bank',
            width: 170,
            render: (_, row) => row.recordType === 'custom' ? (
              <span>
                {row.customName}
                <Tag color={row.customBusinessType === 'fixed_bill' ? 'blue' : 'gold'} style={{ marginLeft: 6 }}>
                  {row.customBusinessType === 'fixed_bill' ? '固定账单' : '动态账单'}
                </Tag>
              </span>
            ) : `${row.bankName}（${cardTailsText(row.cardTails)}）`,
          },
          {
            title: '出账日',
            dataIndex: 'statementDate',
            width: 110,
            render: (value: string | null) => value ? dayjs(value).format('YYYY-MM-DD') : '-',
          },
          {
            title: '还款日',
            dataIndex: 'dueDate',
            width: 110,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
          },
          {
            title: '待还金额',
            dataIndex: 'amount',
            width: 130,
            align: 'right',
            render: (_: number | null, r) => {
              const remainingAmount = remainingAmountOf(r);
              if (remainingAmount == null) return <Tag>{r.recordType === 'custom' ? '金额待填写' : '未取得账单'}</Tag>;

              const paidAmount = paidAmountOf(r);
              return (
                <>
                  <Tooltip
                    title={(
                      <div>
                        <div>账单总额 {formatMoney(r.amount!, r.currency)}</div>
                        <div>已还金额 {formatMoney(paidAmount, r.currency)}</div>
                      </div>
                    )}
                  >
                    <Typography.Text
                      type={remainingAmount > 0 ? 'danger' : 'secondary'}
                      className="amount-strong"
                      tabIndex={0}
                      aria-label={`待还金额 ${remainingAmount.toFixed(2)} 元；账单总额 ${r.amount!.toFixed(2)} 元；已还金额 ${paidAmount.toFixed(2)} 元`}
                      style={{ cursor: 'help' }}
                    >
                      {formatMoney(remainingAmount, r.currency)}
                    </Typography.Text>
                  </Tooltip>
                  {r.source === 'manual' && (
                    <div style={{ marginTop: 2 }}>
                      <Tag color={r.amount === 0 ? 'green' : 'blue'}>{r.amount === 0 ? '无需还款' : '手动标记'}</Tag>
                    </div>
                  )}
                  {r.annualFeeAmount != null && r.annualFeeAmount > 0 && (
                    <div style={{ marginTop: 2 }}>
                      <Tag color="red">含年费 {formatMoney(r.annualFeeAmount, r.currency)}</Tag>
                    </div>
                  )}
                </>
              );
            },
          },
          {
            title: '最低还款',
            dataIndex: 'minAmount',
            width: 100,
            align: 'right',
            render: (v: number | null, row) => (v != null ? formatMoney(v, row.currency) : '-'),
          },
          {
            title: '还款状态',
            dataIndex: 'paidStatus',
            width: 130,
            render: (_: BillRow['paidStatus'], r) => {
              const status = paymentStatusOf(r);
              return <Tag color={status.color}>{status.label}</Tag>;
            },
          },
          {
            title: '操作',
            key: 'op',
            width: 280,
            render: (_, r) => {
              return (
                <Space size={4} wrap>
                  {r.recordType === 'card' && !r.missing && r.hasDetails && r.id != null && (
                    <Button
                      size="small"
                      disabled={blocked && !(details != null && detailBill?.id === r.id)}
                      onClick={() => void openDetails(r)}
                    >
                      明细
                    </Button>
                  )}
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    onClick={() => setPaymentTarget(r)}
                  >
                    {r.recordType === 'custom' && r.paidStatus === 'paid' ? '恢复待还' : '还款'}
                  </Button>
                  {r.recordType === 'card' && !r.missing && r.id != null && (
                    <Popconfirm title="删除该账单记录？" onConfirm={() => r.id != null && remove(r.id)}>
                      <Button size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                  {r.recordType === 'card' && (
                    <Button size="small" onClick={() => openCardStatus(r)}>
                      标记异常
                    </Button>
                  )}
                </Space>
              );
            },
          },
        ]}
        summary={(rows) =>
          rows.length > 0 ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={4}>
                本页合计（待还）
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right" colSpan={2}>
                <Space size={8} wrap>
                  {[...rows.reduce((map, row) => {
                    const amount = remainingAmountOf(row);
                    if (amount != null) map.set(row.currency, (map.get(row.currency) ?? 0) + amount);
                    return map;
                  }, new Map<string, number>())].map(([currency, amount]) => (
                    <Typography.Text key={currency} type="danger" className="amount-strong">
                      {formatMoney(amount, currency)}
                    </Typography.Text>
                  ))}
                </Space>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} colSpan={2}>
                {rows.filter((r) => r.paidStatus !== 'paid' && r.amount != null).length} 笔未还
              </Table.Summary.Cell>
            </Table.Summary.Row>
          ) : null
        }
      />
            </>
          )}
        </Page>
      </div>

      <MarkPaidModal
        target={markTarget}
        onClose={() => setMarkTarget(null)}
        onDone={() => void reloadAfterWrite().catch(() => undefined)}
      />
      <MarkAbnormalModal
        target={abnormalTarget}
        onClose={() => setAbnormalTarget(null)}
        onDone={() => {
          void reloadAfterWrite().catch(() => undefined);
          void loadCards();
        }}
      />

      {detailOpen && isMobile && detailBill && (
        <MobileBillDetails
          target={{
            billId: detailBill.id!,
            bankName: detailBill.bankName ?? '',
            cardTails: detailBill.cardTails,
            period: detailBill.period,
          }}
          details={details}
          loading={detailLoading}
          error={detailError}
          blocked={blocked}
          blockedReason={blockedReason}
          onBack={closeDetails}
          onRetry={() => void openDetails(detailBill)}
          onViewHistory={() => navigateFromMobileFlow('/email', { state: { showHistoryProgress: true } })}
        />
      )}

      {!isMobile && (
      <Modal
        open={detailOpen}
        onCancel={closeDetails}
        footer={null}
        width={720}
        title={`${detailBill?.bankName ?? ''}（${detailBill ? cardTailsText(detailBill.cardTails) : ''}）${detailBill?.period ?? ''} 账单明细`}
      >
        <DesktopBillDetailsContent
          details={details}
          loading={detailLoading}
          error={detailError}
          blocked={blocked}
          onRetry={() => detailBill && void openDetails(detailBill)}
          onViewHistory={() => navigate('/email', { state: { showHistoryProgress: true } })}
        />
      </Modal>
      )}
    </>
  );
}
