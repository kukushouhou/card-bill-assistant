import { useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { Alert, Button, Card, DatePicker, Empty, Input, Segmented, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { FilterOutlined } from '../skins/icons';
import { Popup } from 'antd-mobile';
import dayjs, { type Dayjs } from 'dayjs';
import { useResource } from '../lib/useResource';
import { displayDate, displayPeriod } from '../lib/displayDate';
import { useSourceReturn } from '../lib/billNavigation';
import type { CardRow, PagedTransactions, TransactionRow } from '../api/types';
import { Page } from '../components/Layout';
import { formatMoney } from '../lib/money';
import { useResponsive } from '../responsive';
import './transactions.css';

const { RangePicker } = DatePicker;

function transactionDate(row: TransactionRow): string {
  if (row.transactionDate) {
    return displayDate(row.transactionDate, { time: row.unbilled });
  }
  return row.date?.trim() || '-';
}

function transactionDirection(amount: number) {
  if (amount > 0) return <Tag color="red">支出</Tag>;
  if (amount < 0) return <Tag color="green">入账</Tag>;
  return <Tag>无金额</Tag>;
}

function hasUsefulOriginalAmount(row: TransactionRow): boolean {
  if (row.originalAmount == null || !row.originalCurrency) return false;
  return row.originalCurrency.toUpperCase() !== row.currency.toUpperCase()
    || Math.abs(row.originalAmount) !== Math.abs(row.amount);
}

function transactionAmount(row: TransactionRow) {
  const amount = row.amount < 0
    ? `+${formatMoney(Math.abs(row.amount), row.currency)}`
    : formatMoney(row.amount, row.currency);
  return (
    <div className="transaction-amount">
      <Typography.Text type={row.amount > 0 ? 'danger' : row.amount < 0 ? 'success' : undefined} strong>
        {amount}
      </Typography.Text>
      {hasUsefulOriginalAmount(row) && (
        <Typography.Text type="secondary" className="transaction-original-amount">
          原币 {formatMoney(Math.abs(row.originalAmount!), row.originalCurrency!)}
        </Typography.Text>
      )}
    </div>
  );
}

export default function Transactions() {
  const { isMobile } = useResponsive();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const back = useSourceReturn();
  const update = (values: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    Object.entries(values).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    setParams(next, { replace: true, state: location.state });
  };
  const bank = params.get('bank') ?? undefined;
  const cardId = params.get('cardId') ? Number(params.get('cardId')) : undefined;
  const dateFrom = params.get('dateFrom');
  const dateTo = params.get('dateTo');
  const dates = useMemo<[Dayjs | null, Dayjs | null] | null>(() => dateFrom || dateTo ? [dateFrom ? dayjs(dateFrom) : null, dateTo ? dayjs(dateTo) : null] : null, [dateFrom, dateTo]);
  const setBank = (value?: string) => update({ bank: value, cardId: undefined });
  const setCardId = (value?: number) => update({ cardId: value ? String(value) : undefined });
  const setDates = (value: [Dayjs | null, Dayjs | null] | null) => update({ dateFrom: value?.[0]?.format('YYYY-MM-DD'), dateTo: value?.[1]?.format('YYYY-MM-DD') });
  const setQuery = (value: string) => update({ q: value });
  const page = Number(params.get('page') ?? 1);
  const setPage = (value: number | ((page: number) => number)) => update({ page: String(typeof value === 'function' ? value(page) : value) });
  const [keyword, setKeyword] = useState(params.get('q') ?? '');
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftBank, setDraftBank] = useState<string>();
  const [draftCardId, setDraftCardId] = useState<number>();
  const [draftDates, setDraftDates] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const resource = useResource<PagedTransactions>('/api/transactions?' + params.toString());
  const data = resource.data ?? { total: 0, page: 1, pageSize: 20, items: [] };
  const { loading, error } = resource;
  const cardsResource = useResource<CardRow[]>('/api/cards');
  const cards = cardsResource.data ?? [];
  const billId = params.get('billId') ?? params.get('scopeBillId');
  const history = params.has('scopeBillId');
  const context = data.context;
  const scopedIds = context?.cards.map(card => card.id);
  const noRecords = params.has('q') || params.has('period') || params.has('dateFrom') || params.has('cardId') ? '没有符合筛选条件的明细' : billId && !history ? '该账单暂无明细' : '暂无账单明细';
  const banks = useMemo(() => [...new Set(cards.map((card) => card.bankName))].sort(), [cards]);
  const cardOptions = useMemo(
    () => cards
      .filter((card) => (!bank || card.bankName === bank) && (!billId || scopedIds?.includes(card.id)))
      .map((card) => ({ value: card.id, label: `${card.bankName}（${card.displayLast4}）` })),
    [bank, cards, billId, scopedIds],
  );
  const draftCardOptions = useMemo(
    () => cards
      .filter((card) => (!draftBank || card.bankName === draftBank) && (!billId || scopedIds?.includes(card.id)))
      .map((card) => ({ value: card.id, label: `${card.bankName}（${card.displayLast4}）` })),
    [cards, draftBank, billId, scopedIds],
  );
  const activeCard = useMemo(() => cards.find((card) => card.id === cardId), [cardId, cards]);
  const activeFilterCount = Number(Boolean(bank)) + Number(Boolean(cardId)) + Number(Boolean(dates?.[0] || dates?.[1]));

  const resetPage = () => {};
  const openFilters = () => {
    setDraftBank(bank);
    setDraftCardId(cardId);
    setDraftDates(dates);
    setFilterOpen(true);
  };
  const clearStructuredFilters = () => {
    update({ bank: undefined, cardId: undefined, dateFrom: undefined, dateTo: undefined });
  };
  const desktopFilters = (
    <div className="transaction-filters">
      <Select allowClear placeholder="全部银行" value={bank} options={banks.map((value) => ({ value, label: value }))}
        onChange={(value) => { setBank(value); }} />
      <Select allowClear showSearch optionFilterProp="label" placeholder="全部卡片" value={cardId} options={cardOptions}
        onChange={(value) => { setCardId(value); resetPage(); }} />
      <RangePicker value={dates} onChange={(value) => { setDates(value); resetPage(); }} />
      <Input.Search placeholder="搜索交易描述" value={keyword} allowClear
        onChange={(event) => {
          setKeyword(event.target.value);
          if (!event.target.value) { setQuery(''); resetPage(); }
        }}
        onSearch={(value) => { setQuery(value.trim()); resetPage(); }} />
    </div>
  );
  const mobileFilters = (
    <>
      <div className="transaction-mobile-toolbar">
        <Input.Search
          placeholder="搜索交易描述"
          value={keyword}
          allowClear
          onChange={(event) => {
            setKeyword(event.target.value);
            if (!event.target.value) { setQuery(''); resetPage(); }
          }}
          onSearch={(value) => { setQuery(value.trim()); resetPage(); }}
        />
        <Button icon={<FilterOutlined />} onClick={openFilters}>
          {activeFilterCount > 0 ? `筛选 ${activeFilterCount}` : '筛选'}
        </Button>
      </div>
      {activeFilterCount > 0 && (
        <div className="transaction-active-filters" aria-label="已启用筛选条件">
          {bank && <Tag closable onClose={() => { setBank(undefined); resetPage(); }}>{bank}</Tag>}
          {activeCard && (
            <Tag closable onClose={() => { setCardId(undefined); resetPage(); }}>
              卡尾 {activeCard.displayLast4}
            </Tag>
          )}
          {(dates?.[0] || dates?.[1]) && (
            <Tag closable onClose={() => { setDates(null); resetPage(); }}>
              {dates?.[0]?.format('MM-DD') ?? '不限'} 至 {dates?.[1]?.format('MM-DD') ?? '不限'}
            </Tag>
          )}
          <Button type="link" size="small" onClick={clearStructuredFilters}>清除</Button>
        </div>
      )}
      <Popup
        visible={filterOpen}
        position="bottom"
        destroyOnClose
        closeOnMaskClick
        closeOnSwipe
        onClose={() => setFilterOpen(false)}
        bodyClassName="transaction-filter-sheet"
      >
        <section role="dialog" aria-modal="true" aria-labelledby="transaction-filter-title">
          <div className="transaction-filter-sheet-handle" aria-hidden="true" />
          <div className="transaction-filter-sheet-header">
            <Typography.Title id="transaction-filter-title" level={4}>筛选明细</Typography.Title>
            <Button
              type="link"
              onClick={() => {
                setDraftBank(undefined);
                setDraftCardId(undefined);
                setDraftDates(null);
              }}
            >
              清空
            </Button>
          </div>
          <div className="transaction-filter-sheet-fields">
            <label>
              <span>银行</span>
              <Select
                allowClear
                placeholder="全部银行"
                value={draftBank}
                options={banks.map((value) => ({ value, label: value }))}
                onChange={(value) => { setDraftBank(value); setDraftCardId(undefined); }}
              />
            </label>
            <label>
              <span>卡片</span>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="全部卡片"
                value={draftCardId}
                options={draftCardOptions}
                onChange={setDraftCardId}
              />
            </label>
            <label>
              <span>交易日期</span>
              <RangePicker value={draftDates} onChange={setDraftDates} />
            </label>
          </div>
          <div className="transaction-filter-sheet-actions">
            <Button onClick={() => setFilterOpen(false)}>取消</Button>
            <Button
              type="primary"
              onClick={() => {
                update({ bank: draftBank, cardId: draftCardId ? String(draftCardId) : undefined, dateFrom: draftDates?.[0]?.format('YYYY-MM-DD'), dateTo: draftDates?.[1]?.format('YYYY-MM-DD') });
                setFilterOpen(false);
              }}
            >
              查看结果
            </Button>
          </div>
        </section>
      </Popup>
    </>
  );

  return (
    <Page title="账单明细">
      {billId && <section className="transaction-context" data-skin-slot="summary">
        <div className="transaction-context-heading"><div><h3>{context ? context.bankName + ' · ' + displayPeriod(context.period) : '账单明细'}</h3>{context && <span>卡尾 {context.cards.map(card => card.cardLast4).join(' / ')}</span>}</div><Button onClick={back}>返回来源</Button></div>
        <div className="transaction-context-controls">
        <Segmented value={history ? 'history' : 'bill'} options={[{ value: 'bill', label: '本账单' }, { value: 'history', label: '历史明细' }]} onChange={value => setParams({ [value === 'bill' ? 'billId' : 'scopeBillId']: billId }, { replace: true, state: location.state })} />
        {history && <DatePicker picker="month" aria-label="账期" placeholder="全部账期" value={params.get('period') ? dayjs(params.get('period')) : null} onChange={value => update({ period: value?.format('YYYY-MM') })} />}
        <Button onClick={() => setParams({}, { replace: true, state: location.state })}>查看全部明细</Button>
        </div>
      </section>}
      {(!billId || history) && (isMobile ? mobileFilters : desktopFilters)}
      {error && <Alert type="error" showIcon title="账单明细加载失败" description={error} action={<Button onClick={() => void resource.refresh()}>重试</Button>} />}
      {(!error || resource.data) && (isMobile ? (
        <div className="transaction-mobile-list">
          {loading && data.items.length === 0 ? <Spin /> : data.items.length === 0 ? <Empty description={noRecords} /> : data.items.map((row) => (
            <Card key={row.id} size="small" className="transaction-mobile-card">
              <div className="transaction-mobile-heading">
                <strong>{row.bankName}（{row.cardLast4 ?? '----'}）</strong>
                <Tag color={row.unbilled ? 'gold' : undefined}>{row.unbilled ? row.period : displayPeriod(row.period)}</Tag>
              </div>
              <Typography.Paragraph className="transaction-description">{row.description}</Typography.Paragraph>
              <div className="transaction-mobile-meta">
                <div className="transaction-mobile-date"><span>交易日</span><span>{transactionDate(row)}</span></div>
                <div className="transaction-mobile-direction-amount">
                  {transactionDirection(row.amount)}
                  {transactionAmount(row)}
                </div>
              </div>
            </Card>
          ))}
          {data.total > data.pageSize && (
            <Space className="transaction-mobile-pagination">
              <Button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
              <span>{page} / {Math.ceil(data.total / data.pageSize)}</span>
              <Button disabled={page * data.pageSize >= data.total} onClick={() => setPage((value) => value + 1)}>下一页</Button>
            </Space>
          )}
        </div>
      ) : (
        <Table<TransactionRow>
          rowKey="id"
          loading={loading}
          dataSource={data.items}
          locale={{ emptyText: <Empty description={noRecords} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, showTotal: (total) => `共 ${total} 笔`, onChange: setPage }}
          columns={[
            { title: '交易日', width: 175, render: (_, row) => transactionDate(row) },
            { title: '银行 / 卡尾', width: 190, render: (_, row) => `${row.bankName}（${row.cardLast4 ?? '----'}）` },
            { title: '方向', width: 80, align: 'center', render: (_, row) => transactionDirection(row.amount) },
            { title: '交易描述', dataIndex: 'description' },
            { title: '金额', width: 170, align: 'right', render: (_, row) => transactionAmount(row) },
            {
              title: '账期',
              dataIndex: 'period',
              width: 90,
              render: (value, row) => <Tag color={row.unbilled ? 'gold' : undefined}>{row.unbilled ? value : displayPeriod(value)}</Tag>,
            },
          ]}
        />
      ))}
    </Page>
  );
}
