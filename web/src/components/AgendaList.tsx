import { Popup } from 'antd-mobile';
import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Dropdown, Empty, Pagination, Skeleton, Space, Table, Tag } from 'antd';
import { DownOutlined, RightOutlined } from '../skins/icons';
import type { AgendaItem, AgendaResult, AgendaSummary, BillRow, CardRow } from '../api/types';
import { api } from '../api/client';
import { useResponsive } from '../responsive';
import { displayDate, displayPeriod } from '../lib/displayDate';
import { formatMoney } from '../lib/money';
import { overdueText } from '../lib/overdue';
import { paymentTarget, useBillNavigation } from '../lib/billNavigation';
import { useResource } from '../lib/useResource';
import { useViewState } from '../lib/viewState';
import MarkPaidModal, { type MarkPaidTarget } from './MarkPaidModal';
import MarkAbnormalModal, { type MarkAbnormalTarget } from './MarkAbnormalModal';
import BusinessFlow from './BusinessFlow';
import AmountSummary from './AmountSummary';
import './agenda.css';

const kinds = { credit_bill: '信用卡账单', fixed_bill: '固定账单', dynamic_bill: '动态账单', general: '常规提醒', statement: '出账提醒', fee: '年费提醒', repayment: '还款提醒' };

export function AgendaTotals({ summary, pending = true }: { summary: AgendaSummary; pending?: boolean }) {
  const missing = summary.missingBillCount ?? 0;
  return <AmountSummary title={pending ? '待还合计' : '账单合计'} amounts={summary.totalsByCurrency}
    metrics={[{ count: summary.billCount, label: '笔账单' }, ...(summary.reminderCount > 0 ? [{ count: summary.reminderCount, label: '条提醒' }] : [])]}
    notices={[
      ...(missing > 0 ? [{ count: missing, label: '未取得账单' }] : []),
      ...(summary.unknownAmountCount > missing ? [{ count: summary.unknownAmountCount - missing, label: '金额待填写' }] : []),
    ]} />;
}

function Identity({ item }: { item: AgendaItem }) {
  return <div className="agenda-identity"><strong>{item.title}</strong><span>{item.cardTails.length > 0 ? '卡尾 ' + item.cardTails.join(' / ') : kinds[item.kind]}</span>{item.description && <span>{item.description}</span>}</div>;
}

function BillAmount({ item }: { item: AgendaItem }) {
  const bill = item.bill;
  if (bill) return <strong className="agenda-amount">{bill.missing ? '未取得账单' : (item.completed ? bill.amount : bill.remainingAmount) == null ? '金额待填写' : formatMoney((item.completed ? bill.amount : bill.remainingAmount)!, bill.currency)}</strong>;
  if (item.previewAmount != null) return <span>{formatMoney(item.previewAmount, item.previewCurrency ?? 'CNY')}</span>;
  return null;
}

function Status({ item }: { item: AgendaItem }) {
  const bill = item.bill;
  if (!bill) return item.completed ? <Tag color="green">已完成</Tag> : <Tag>{item.kind === 'general' ? '待完成' : kinds[item.kind]}</Tag>;
  if (bill.missing) return null;
  return <Tag color={bill.paidStatus === 'paid' ? 'green' : bill.paidStatus === 'partial' ? 'orange' : undefined}>{bill.missing ? '未取得账单' : bill.paidStatus === 'paid' ? '已还清' : bill.paidStatus === 'partial' ? '部分已还' : '待还'}</Tag>;
}

function Dates({ item }: { item: AgendaItem }) {
  return <div className="agenda-dates">
    {item.bill ? <>{item.bill.statementDate && <span>出账 {displayDate(item.bill.statementDate)}</span>}<span>还款 {displayDate(item.bill.dueDate)}</span>{item.bill.minAmount != null && <span>最低还款 {formatMoney(item.bill.minAmount, item.bill.currency)}</span>}</> : <span>{displayDate(item.date)}</span>}
    {item.daysOverdue != null && <span className="agenda-overdue">{overdueText(item.daysOverdue)}</span>}
  </div>;
}

function Notices({ item }: { item: AgendaItem }) {
  return item.notices.length > 0 ? <div className="agenda-notices">{item.notices.map((notice, index) => <span key={index}>{notice.title}{notice.date !== item.date ? ' · ' + displayDate(notice.date) : ''}</span>)}</div> : null;
}

/** 两端各自排版，共用身份、金额和单笔操作。 */
export function AgendaRows({ items, onChanged }: { items: AgendaItem[]; onChanged: () => void }) {
  const { isMobile } = useResponsive();
  const { message } = App.useApp();
  const openBill = useBillNavigation();
  const [paid, setPaid] = useState<MarkPaidTarget | null>(null);
  const [abnormal, setAbnormal] = useState<MarkAbnormalTarget | null>(null);
  const [deleting, setDeleting] = useState<BillRow | null>(null);
  const [moreItem, setMoreItem] = useState<AgendaItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const execute = async (key: string, fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(key);
    try { await fn(); } catch (e) { message.error(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { lock.current = false; setBusy(null); }
  };
  const canOpen = (item: AgendaItem) => item.bill?.recordType === 'card' && item.bill.id != null && !item.bill.missing;
  const openStatus = (item: AgendaItem) => void execute(item.key, async () => {
    const cards = await api.get<CardRow[]>('/api/cards'); const card = cards.find(c => c.id === item.bill!.cardId);
    if (!card) throw new Error('卡片不存在，请刷新');
    setAbnormal({ cardId: card.id, bankName: card.bankName, cardLast4: card.displayLast4, status: card.status });
  });
  const actions = (item: AgendaItem) => <Space size={8} wrap onClick={event => event.stopPropagation()}>
    {item.bill && <Button type={isMobile && !item.completed ? 'primary' : 'default'} onClick={() => setPaid(paymentTarget(item.bill!))}>{item.completed ? '调整还款' : '还款'}</Button>}
    {item.action === 'complete' && item.occurrenceId != null && <Button type={isMobile ? 'primary' : 'default'} loading={busy === item.key} onClick={() => void execute(item.key, async () => { await api.post('/api/reminders/occurrences/' + item.occurrenceId + '/complete'); message.success('已完成'); onChanged(); })}>完成</Button>}
    {item.bill?.recordType === 'card' && (isMobile ? <Button type="text" onClick={() => setMoreItem(item)}>更多</Button> : <Dropdown trigger={['click']} menu={{ items: [
      { key: 'status', label: '标记异常', onClick: () => openStatus(item) },
      ...(canOpen(item) ? [{ key: 'delete', label: '删除账单', danger: true, onClick: () => setDeleting(item.bill) }] : []),
    ] }}><Button type="text" loading={busy === item.key}>更多</Button></Dropdown>)}
  </Space>;
  return <>
    {isMobile ? <div className="agenda-mobile-list">{items.map(item => <article key={item.key} className="agenda-mobile-row" data-skin-slot="list-row">
      <button type="button" className="agenda-row-body" disabled={!canOpen(item)} onClick={() => openBill(item.bill!.id!)} aria-label={canOpen(item) ? item.title + ' ' + displayPeriod(item.period) + '，查看明细' : undefined}>
        <div className="agenda-mobile-top"><Identity item={item} /><span>{displayPeriod(item.period)}</span></div>
        <div className="agenda-mobile-main"><BillAmount item={item} /><Status item={item} /></div>
        <Dates item={item} /><Notices item={item} />
      </button>
      {(item.bill || item.action === 'complete') && <div className="agenda-row-actions">{actions(item)}</div>}
    </article>)}</div> : <Table<AgendaItem> rowKey="key" pagination={false} dataSource={items} size="middle" columns={[
      { title: '账单 / 提醒', key: 'identity', render: (_, item) => <><Identity item={item} /><Notices item={item} /></> },
      { title: '账期', key: 'period', width: 110, render: (_, item) => <span className="agenda-period">{canOpen(item) ? <Button className="agenda-period-link" type="link" onClick={() => openBill(item.bill!.id!)}>{displayPeriod(item.period)}</Button> : <span>{displayPeriod(item.period)}</span>}</span> },
      { title: '日期', key: 'date', render: (_, item) => <Dates item={item} /> },
      { title: '金额', key: 'amount', align: 'right', render: (_, item) => <BillAmount item={item} /> },
      { title: '状态', key: 'status', width: 100, render: (_, item) => <Status item={item} /> },
      { title: '操作', key: 'actions', render: (_, item) => actions(item) },
    ]} />}
    <Popup visible={moreItem != null} position="bottom" closeOnMaskClick onClose={() => setMoreItem(null)} bodyClassName="agenda-more-sheet">
      {moreItem && <section role="dialog" aria-label="账单操作"><Identity item={moreItem} /><Button block onClick={() => { openStatus(moreItem); setMoreItem(null); }}>标记异常</Button>{canOpen(moreItem) && <Button block danger onClick={() => { setDeleting(moreItem.bill); setMoreItem(null); }}>删除账单</Button>}<Button block onClick={() => setMoreItem(null)}>取消</Button></section>}
    </Popup>
    <MarkPaidModal target={paid} onClose={() => setPaid(null)} onDone={onChanged} />
    <MarkAbnormalModal target={abnormal} onClose={() => setAbnormal(null)} onDone={onChanged} />
    {deleting && <BusinessFlow title="删除账单" width={560} onClose={() => { if (!lock.current) setDeleting(null); }} footer={<Space><Button disabled={!!busy} onClick={() => setDeleting(null)}>取消</Button><Button danger type="primary" loading={!!busy} onClick={() => void execute('delete', async () => { await api.delete('/api/bills/' + deleting.id); setDeleting(null); message.success('账单已删除'); onChanged(); })}>删除账单</Button></Space>}>
      <p>删除 {deleting.bankName}（{deleting.cardTails.join(' / ')}）{displayPeriod(deleting.period)}账单及其明细？此操作无法撤销。</p>
    </BusinessFlow>}
  </>;
}

/** 每个账期拥有自己的分页，不用第一页代替完整汇总。 */
export function AgendaPage({ query, revision = 0, onChanged, initialPage = 1 }: { query: string; revision?: number; onChanged?: () => void; initialPage?: number }) {
  const [page, setPage] = useViewState('agenda-page:' + query, initialPage);
  const params = new URLSearchParams(query); params.set('page', String(page));
  // 分页由同一清单控制，不追加同一范围的重复内容。
  return <PagedAgenda query={params.toString()} revision={revision} onChanged={onChanged} onPage={setPage} />;
}

function PagedAgenda({ query, revision, onChanged, onPage }: { query: string; revision: number; onChanged?: () => void; onPage: (page: number) => void }) {
  const { data, error, loading, refresh } = useResource<AgendaResult>('/api/agenda?' + query, revision);
  const [expanded, setExpanded] = useViewState<string[]>('agenda-open:' + query.replace(/&?page=\d+/, ''), []);
  useEffect(() => { if (data && data.page > Math.max(1, Math.ceil(data.total / data.pageSize))) onPage(Math.max(1, Math.ceil(data.total / data.pageSize))); }, [data, onPage]);
  const changed = () => { void refresh(); onChanged?.(); };
  return <div className="agenda-list" aria-busy={loading}>
    {error && <Alert type="error" title={data ? '刷新失败，仍显示上次内容' : '暂时无法加载'} description={error} action={<Button onClick={() => void refresh()}>重试</Button>} />}
    {!data && loading && <Skeleton active paragraph={{ rows: 4 }} />}
    {data && <>
      {!new URLSearchParams(query).has('period') && <AgendaTotals summary={data.summary} pending={data.view !== 'history'} />}
      {data.total === 0 && <Empty description={new URLSearchParams(query).has('q') || new URLSearchParams(query).has('kind') ? '没有符合筛选条件的记录' : '暂无记录'} />}
      {data.grouped ? data.groups.map(group => <section className="agenda-history-group" key={group.period}>
        <button className="agenda-history-heading" aria-expanded={expanded.includes(group.period)} onClick={() => setExpanded(current => current.includes(group.period) ? current.filter(p => p !== group.period) : [...current, group.period])}>
          {expanded.includes(group.period) ? <DownOutlined /> : <RightOutlined />}<strong>{displayPeriod(group.period)}</strong><span>{group.count} 笔</span><span className="agenda-history-amounts">{group.totalsByCurrency.map(total => <strong key={total.currency}>{formatMoney(total.amount, total.currency)}</strong>)}</span>
        </button>
        {expanded.includes(group.period) && <AgendaPage query={query.replace(/&?page=\d+/, '') + '&period=' + group.period} revision={revision} onChanged={changed} />}
      </section>) : <AgendaRows items={data.items} onChanged={changed} />}
      {data.total > data.pageSize && <Pagination current={data.page} total={data.total} pageSize={data.pageSize} showSizeChanger={false} onChange={onPage} />}
    </>}
  </div>;
}
