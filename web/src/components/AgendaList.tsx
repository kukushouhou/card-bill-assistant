import { Popup } from 'antd-mobile';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, App, Button, Dropdown, Empty, Grid, Pagination, Skeleton, Space, Table, Tag } from 'antd';
import { BellOutlined, ClockCircleOutlined, CreditCardOutlined, DownOutlined, ExclamationCircleFilled, FileTextOutlined, MoreOutlined, RightOutlined } from '../skins/icons';
import type { AgendaItem, AgendaResult, AgendaSummary, BillRow, CardRow } from '../api/types';
import { api } from '../api/client';
import { useResponsive } from '../responsive';
import { displayDate, displayPeriod } from '../lib/displayDate';
import { formatMoney } from '../lib/money';
import { billDueNotice, type BillDueNotice } from '../lib/billDue';
import { hasMetMinimumPayment } from '../lib/billPayment';
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
  if (bill) {
    const amount = item.completed ? bill.amount : bill.remainingAmount;
    if (bill.missing || amount == null) return <strong className="agenda-amount-state">{bill.missing ? '未取得账单' : '金额待填写'}</strong>;
    return <strong className="agenda-amount">{formatMoney(amount, bill.currency)}</strong>;
  }
  if (item.previewAmount != null) return <span>{formatMoney(item.previewAmount, item.previewCurrency ?? 'CNY')}</span>;
  return null;
}

function Status({ item }: { item: AgendaItem }) {
  const bill = item.bill;
  if (!bill) return item.completed ? <Tag color="green">已完成</Tag> : <Tag>{item.kind === 'general' ? '待完成' : kinds[item.kind]}</Tag>;
  if (bill.missing) return null;
  if (hasMetMinimumPayment(bill)) return <Tag color="blue">已还最低</Tag>;
  const label = bill.paidStatus === 'paid'
    ? (bill.amount === 0 ? '无需还款' : '已还清')
    : bill.paidStatus === 'partial' ? '部分已还' : '待还';
  return <Tag color={bill.paidStatus === 'paid' ? 'green' : bill.paidStatus === 'partial' ? 'orange' : undefined}>{label}</Tag>;
}

function DueNotice({ notice }: { notice: BillDueNotice | null }) {
  return notice && <span className="agenda-due-notice" data-tone={notice.tone}>
    {notice.tone === 'overdue' ? <ExclamationCircleFilled aria-hidden="true" /> : <ClockCircleOutlined aria-hidden="true" />}<span>{notice.label}</span>
  </span>;
}

function Dates({ item }: { item: AgendaItem }) {
  return <div className="agenda-dates">
    {item.bill ? <>{item.bill.statementDate && <span>出账 {displayDate(item.bill.statementDate)}</span>}<span>还款 {displayDate(item.bill.dueDate)}</span>{item.bill.minAmount != null && <span>最低还款 {formatMoney(item.bill.minAmount, item.bill.currency)}</span>}</> : <span>{displayDate(item.date)}</span>}
  </div>;
}

/** 桌面按列组织信息：日期成对对齐，最低还款额与金额放在一起。 */
function DesktopDates({ item }: { item: AgendaItem }) {
  return <dl className="agenda-date-cell">
    <div><dt>{item.bill ? '还款' : item.kind === 'statement' ? '出账' : item.kind === 'fee' ? '年费' : '提醒'}</dt><dd>{displayDate(item.bill?.dueDate ?? item.date)}</dd></div>
    {item.bill?.statementDate && <div className="agenda-date-secondary"><dt>出账</dt><dd>{displayDate(item.bill.statementDate)}</dd></div>}
  </dl>;
}

function Notices({ item }: { item: AgendaItem }) {
  return item.notices.length > 0 ? <div className="agenda-notices">{item.notices.map((notice, index) => <span key={index}>{notice.title}{notice.date !== item.date ? ' · ' + displayDate(notice.date) : ''}</span>)}</div> : null;
}

/** 两端各自排版，共用身份、金额和单笔操作。 */
export function AgendaRows({ items, onChanged }: { items: AgendaItem[]; onChanged: () => void }) {
  const { isMobile } = useResponsive();
  const compactDesktop = !Grid.useBreakpoint().xl;
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
  const hasBill = (item: AgendaItem) => item.bill?.recordType === 'card' && item.bill.id != null && !item.bill.missing;
  const canOpen = (item: AgendaItem) => item.bill?.recordType !== 'custom' && (hasBill(item) || item.cardId != null);
  const openDetails = (item: AgendaItem) => {
    if (hasBill(item)) openBill(item.bill!.id!);
    else if (item.bill?.recordType !== 'custom' && item.cardId != null) openBill({ cardId: item.cardId });
  };
  const detailLabel = (item: AgendaItem) => `${item.title}（${item.cardTails.join(' / ')}）${displayPeriod(item.period)}，查看明细`;
  const navigationCell = (item: AgendaItem) => ({ className: canOpen(item) ? 'agenda-navigable-cell' : undefined });
  const dueNotices = new Map<string, BillDueNotice | null>(items.map(item => [item.key, item.completed ? null : item.bill
    ? billDueNotice(item.bill) : item.daysOverdue != null ? { tone: 'overdue', label: overdueText(item.daysOverdue) } : null]));
  const dueClass = (item: AgendaItem) => dueNotices.get(item.key) ? 'agenda-row-due-' + dueNotices.get(item.key)!.tone : '';
  const openStatus = (item: AgendaItem) => void execute(item.key, async () => {
    const cards = await api.get<CardRow[]>('/api/cards'); const card = cards.find(c => c.id === item.bill!.cardId);
    if (!card) throw new Error('卡片不存在，请刷新');
    setAbnormal({ cardId: card.id, bankName: card.bankName, cardLast4: card.displayLast4, status: card.status });
  });
  const actions = (item: AgendaItem) => <Space className="agenda-record-actions" size={isMobile ? 8 : 4} wrap onClick={event => event.stopPropagation()}>
    {canOpen(item) && <Button className="agenda-details-action" size={isMobile ? 'middle' : 'small'} onClick={() => openDetails(item)}>明细</Button>}
    {item.bill && <Button size={isMobile ? 'middle' : 'small'} type={isMobile && !item.completed ? 'primary' : 'default'} onClick={() => setPaid(paymentTarget(item.bill!))}>{item.completed ? '调整还款' : '还款'}</Button>}
    {item.action === 'complete' && item.occurrenceId != null && <Button size={isMobile ? 'middle' : 'small'} type={isMobile ? 'primary' : 'default'} loading={busy === item.key} onClick={() => void execute(item.key, async () => { await api.post('/api/reminders/occurrences/' + item.occurrenceId + '/complete'); message.success('已完成'); onChanged(); })}>完成</Button>}
    {item.bill?.recordType === 'card' && (isMobile ? <Button type="text" onClick={() => setMoreItem(item)}>更多</Button> : <Dropdown trigger={['click']} menu={{ items: [
      { key: 'status', label: '标记异常', onClick: () => openStatus(item) },
      ...(hasBill(item) ? [{ key: 'delete', label: '删除账单', danger: true, onClick: () => setDeleting(item.bill) }] : []),
    ] }}><Button className="agenda-more-button" size="small" type="text" aria-label="更多" title="更多" icon={<MoreOutlined />} loading={busy === item.key} /></Dropdown>)}
  </Space>;
  return <>
    {isMobile ? <div className="agenda-mobile-list">{items.map(item => <article key={item.key} data-row-key={item.key} className={'agenda-mobile-row ' + dueClass(item)} data-skin-slot="list-row">
      <button type="button" className="agenda-row-body" disabled={!canOpen(item)} onClick={() => openDetails(item)} aria-label={canOpen(item) ? detailLabel(item) : undefined}>
        <div className="agenda-mobile-top"><Identity item={item} /><span className="agenda-mobile-period">{displayPeriod(item.period)}{canOpen(item) && <RightOutlined aria-hidden="true" />}</span></div>
        <div className="agenda-mobile-main"><BillAmount item={item} /><div className="agenda-status-cell"><DueNotice notice={dueNotices.get(item.key) ?? null} /><Status item={item} /></div></div>
        <Dates item={item} /><Notices item={item} />
      </button>
      {(canOpen(item) || item.bill || item.action === 'complete') && <div className="agenda-row-actions">{actions(item)}</div>}
    </article>)}</div> : <Table<AgendaItem> className={'agenda-table' + (compactDesktop ? ' agenda-table-compact' : '')} rowKey="key" rowClassName={dueClass} pagination={false} dataSource={items} size="middle" tableLayout="fixed" scroll={{ x: compactDesktop ? 740 : 860 }} columns={[
      { title: '账单 / 提醒', key: 'identity', width: 170, onCell: navigationCell, render: (_, item) => {
        const identity = <div className="agenda-record-identity"><span className="agenda-record-mark" aria-hidden="true">{item.bill?.recordType === 'card' ? <CreditCardOutlined /> : item.bill ? <FileTextOutlined /> : <BellOutlined />}</span><div className="agenda-record-description"><Identity item={item} /><Notices item={item} /></div></div>;
        return canOpen(item) ? <button type="button" className="agenda-cell-link" aria-label={detailLabel(item)} onClick={() => openDetails(item)}>{identity}</button> : identity;
      } },
      { title: '账期', key: 'period', width: 100, onCell: navigationCell, render: (_, item) => <span className="agenda-period">{canOpen(item) ? <button type="button" className="agenda-cell-link agenda-period-link" onClick={() => openDetails(item)}>{displayPeriod(item.period)}</button> : <span>{displayPeriod(item.period)}</span>}</span> },
      { title: '日期', key: 'date', width: 150, render: (_, item) => <><DesktopDates item={item} />{compactDesktop && item.bill?.minAmount != null && <span className="agenda-compact-minimum">最低还款 {formatMoney(item.bill.minAmount, item.bill.currency)}</span>}</> },
      { title: compactDesktop ? '金额 / 状态' : '金额', key: 'amount', width: 135, align: 'right', render: (_, item) => <div className="agenda-money-cell"><BillAmount item={item} />{compactDesktop && <div className="agenda-status-cell"><DueNotice notice={dueNotices.get(item.key) ?? null} />{(!dueNotices.get(item.key) || item.bill?.paidStatus === 'partial') && <Status item={item} />}</div>}{!compactDesktop && item.bill?.minAmount != null && <span className="agenda-minimum">最低还款 {formatMoney(item.bill.minAmount, item.bill.currency)}</span>}</div> },
      ...(!compactDesktop ? [{ title: '状态', key: 'status', width: 125, render: (_: unknown, item: AgendaItem) => <div className="agenda-status-cell"><DueNotice notice={dueNotices.get(item.key) ?? null} /><Status item={item} /></div> }] : []),
      { title: '操作', key: 'actions', width: 180, fixed: 'right', render: (_, item) => actions(item) },
    ]} />}
    <Popup visible={moreItem != null} position="bottom" closeOnMaskClick onClose={() => setMoreItem(null)} bodyClassName="agenda-more-sheet">
      {moreItem && <section role="dialog" aria-label="账单操作"><Identity item={moreItem} /><Button block onClick={() => { openStatus(moreItem); setMoreItem(null); }}>标记异常</Button>{hasBill(moreItem) && <Button block danger onClick={() => { setDeleting(moreItem.bill); setMoreItem(null); }}>删除账单</Button>}<Button block onClick={() => setMoreItem(null)}>取消</Button></section>}
    </Popup>
    <MarkPaidModal target={paid} onClose={() => setPaid(null)} onDone={onChanged} />
    <MarkAbnormalModal target={abnormal} onClose={() => setAbnormal(null)} onDone={onChanged} />
    {deleting && <BusinessFlow title="删除账单" width={560} onClose={() => { if (!lock.current) setDeleting(null); }} footer={<Space><Button disabled={!!busy} onClick={() => setDeleting(null)}>取消</Button><Button danger type="primary" loading={!!busy} onClick={() => void execute('delete', async () => { await api.delete('/api/bills/' + deleting.id); setDeleting(null); message.success('账单已删除'); onChanged(); })}>删除账单</Button></Space>}>
      <p>删除 {deleting.bankName}（{deleting.cardTails.join(' / ')}）{displayPeriod(deleting.period)}账单及其明细？此操作无法撤销。</p>
    </BusinessFlow>}
  </>;
}

/** 每个账期拥有自己的分页，不用第一页代替完整汇总。 */
export function AgendaPage({ query, revision = 0, onChanged, initialPage = 1, controls }: { query: string; revision?: number; onChanged?: () => void; initialPage?: number; controls?: ReactNode }) {
  const [page, setPage] = useViewState('agenda-page:' + query, initialPage);
  const params = new URLSearchParams(query); params.set('page', String(page));
  // 分页由同一清单控制，不追加同一范围的重复内容。
  return <PagedAgenda query={params.toString()} revision={revision} onChanged={onChanged} onPage={setPage} controls={controls} />;
}

function PagedAgenda({ query, revision, onChanged, onPage, controls }: { query: string; revision: number; onChanged?: () => void; onPage: (page: number) => void; controls?: ReactNode }) {
  const { data, error, loading, refresh } = useResource<AgendaResult>('/api/agenda?' + query, revision);
  const [expanded, setExpanded] = useViewState<string[]>('agenda-open:' + query.replace(/&?page=\d+/, ''), []);
  useEffect(() => { if (data && data.page > Math.max(1, Math.ceil(data.total / data.pageSize))) onPage(Math.max(1, Math.ceil(data.total / data.pageSize))); }, [data, onPage]);
  const changed = () => { void refresh(); onChanged?.(); };
  return <div className="agenda-list" aria-busy={loading}>
    {error && <Alert type="error" title={data ? '刷新失败，仍显示上次内容' : '暂时无法加载'} description={error} action={<Button onClick={() => void refresh()}>重试</Button>} />}
    {!data && loading && <Skeleton active paragraph={{ rows: 4 }} />}
    {data && !new URLSearchParams(query).has('period') && <AgendaTotals summary={data.summary} pending={data.view !== 'history'} />}
    <div className={controls ? 'agenda-workspace' : 'agenda-results'}>
      {controls}
      {data && <>
      {data.total === 0 && <Empty description={new URLSearchParams(query).has('q') || new URLSearchParams(query).has('kind') ? '没有符合筛选条件的记录' : '暂无记录'} />}
      {data.grouped ? data.groups.map(group => <section className="agenda-history-group" key={group.period}>
        <button className="agenda-history-heading" aria-expanded={expanded.includes(group.period)} onClick={() => setExpanded(current => current.includes(group.period) ? current.filter(p => p !== group.period) : [...current, group.period])}>
          {expanded.includes(group.period) ? <DownOutlined /> : <RightOutlined />}<strong>{displayPeriod(group.period)}</strong><span>{group.count} 笔</span><span className="agenda-history-amounts">{group.totalsByCurrency.map(total => <strong key={total.currency}>{formatMoney(total.amount, total.currency)}</strong>)}</span>
        </button>
        {expanded.includes(group.period) && <AgendaPage query={query.replace(/&?page=\d+/, '') + '&period=' + group.period} revision={revision} onChanged={changed} />}
      </section>) : <AgendaRows items={data.items} onChanged={changed} />}
      {data.total > data.pageSize && <Pagination current={data.page} total={data.total} pageSize={data.pageSize} showSizeChanger={false} onChange={onPage} />}
      </>}
    </div>
  </div>;
}
