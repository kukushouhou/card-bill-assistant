import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, App, Button, Card, Col, Empty, Modal, Row, Select, Space, Spin, Statistic, Table, Tag, Typography } from 'antd';
import {
  CreditCardOutlined,
  PayCircleOutlined,
  ClockCircleOutlined,
  MailOutlined,
  ReloadOutlined,
  SyncOutlined,
  FileTextOutlined,
  ExclamationCircleFilled,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import type { AnnualFeeNotice, BillDetails, BillsTrend, DashboardSummary, TodoItem, UpcomingItem } from '../api/types';
import { overdueText } from '../lib/overdue';
import { hasMetMinimumPayment } from '../lib/billPayment';
import { Page } from '../components/Layout';
import MarkPaidModal, { type MarkPaidTarget } from '../components/MarkPaidModal';
import {
  billCardTailsText,
  DesktopBillDetailsContent,
  MobileBillDetails,
} from '../components/BillDetailsView';
import TrendChart from '../components/TrendChart';
import dayjs from 'dayjs';
import { useResponsive } from '../responsive';
import { MobileFlow, MobilePullToRefresh, useCoalescedRefresh, useMobileFlowNavigation } from '../components/MobilePrimitives';
import './dashboard.css';
import { formatMoney } from '../lib/money';
import { useHistoryGate } from '../historyGate';

type AnnualFeeNoticeItem = AnnualFeeNotice['items'][number];

const TYPE_TAG: Record<UpcomingItem['type'], { color: string; text: string }> = {
  due: { color: 'red', text: '还款日' },
  fee: { color: 'gold', text: '年费' },
  statement: { color: 'blue', text: '出账日' },
  custom: { color: 'purple', text: '自定义' },
};

/** 待办卡尾展示：单卡（1234）；多卡（5888 等2张卡） */
function todoTails(tails: string[]): string {
  if (tails.length <= 1) return tails[0] ?? '';
  return `${tails[0]} 等${tails.length}张卡`;
}

function todoBandClass(t: TodoItem): string {
  if (t.daysOverdue != null) return 'todo-item todo-item-overdue';
  const daysLeft = dayjs(t.dueDate).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (daysLeft === 0) return 'todo-item todo-item-today';
  return 'todo-item';
}

function todoTitle(item: TodoItem): string {
  if (item.recordType === 'custom') return item.name ?? '';
  const tails = item.cardTails ?? [];
  return tails.length > 1
    ? `${item.bankName} ${tails.length} 张卡`
    : `${item.bankName} ${todoTails(tails)}`;
}

function todoDueCopy(item: TodoItem): string {
  const daysLeft = dayjs(item.dueDate).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (item.action === 'complete') {
    if (daysLeft === 0) return '今天';
    if (daysLeft === 1) return '明天';
    return `${Math.max(0, daysLeft)} 天后`;
  }
  if (item.daysOverdue != null) return overdueText(item.daysOverdue);
  if (daysLeft === 0) return '今天到期';
  if (daysLeft === 1) return '明天到期';
  return `${Math.max(0, daysLeft)} 天后到期`;
}

function upcomingTag(item: UpcomingItem) {
  if (item.type !== 'custom') return <Tag color={TYPE_TAG[item.type].color}>{TYPE_TAG[item.type].text}</Tag>;
  if (item.customBusinessType === 'fixed_bill') return <Tag color="blue">固定账单</Tag>;
  if (item.customBusinessType === 'dynamic_bill') return <Tag color="gold">动态账单</Tag>;
  return <Tag color="purple">常规提醒</Tag>;
}

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : '加载失败';
}

function AnnualFeeNoticeAlert({
  notice,
  acknowledging,
  mobile = false,
  onView,
  onAcknowledge,
}: {
  notice: AnnualFeeNotice;
  acknowledging: boolean;
  mobile?: boolean;
  onView: () => void;
  onAcknowledge: () => void;
}) {
  const multipleBanks = notice.banks.length > 1;
  return (
    <section
      className={`annual-fee-notice${mobile ? ' mobile-dashboard-alert' : ''}`}
      role="status"
      aria-label="年费提醒"
    >
      <span className="annual-fee-notice-icon" aria-hidden="true">
        <ExclamationCircleFilled />
      </span>
      <div className="annual-fee-notice-content">
        <div className="annual-fee-notice-title">
          {notice.banks.map((bank) => bank.bankName).join('、')}产生年费
        </div>
        <div className="annual-fee-notice-details">
          {notice.banks.map((bank) => {
            const meta = [
              bank.cardTails.length > 0 ? `尾号 ${bank.cardTails.join('、')}` : null,
              bank.billCount > 1 || bank.cardTails.length === 0 ? `${bank.billCount} 张账单` : null,
            ].filter(Boolean).join(' · ');
            return (
              <div className="annual-fee-notice-bank" key={bank.bankName}>
                <div className="annual-fee-notice-bank-name">
                  {multipleBanks && <strong>{bank.bankName}</strong>}
                  {meta && <span>{meta}</span>}
                </div>
                <strong className="annual-fee-notice-amount">
                  {bank.totalsByCurrency.map((entry) => formatMoney(entry.amount, entry.currency)).join(' · ')}
                </strong>
              </div>
            );
          })}
        </div>
      </div>
      <Space size={8} className="annual-fee-notice-actions">
        <Button size="small" className="annual-fee-notice-view" onClick={onView}>
          {notice.items.length === 1 ? '查看明细' : `查看 ${notice.items.length} 笔`}
        </Button>
        <Button
          size="small"
          className="annual-fee-notice-ack"
          loading={acknowledging}
          onClick={onAcknowledge}
        >
          知道了
        </Button>
      </Space>
    </section>
  );
}

function AnnualFeeNoticeList({
  notice,
  onSelect,
}: {
  notice: AnnualFeeNotice;
  onSelect: (item: AnnualFeeNoticeItem) => void;
}) {
  return (
    <div className="annual-fee-panel-list" role="list">
      {notice.items.map((item) => (
        <div key={item.billId} role="listitem">
          <button
            type="button"
            className="annual-fee-panel-item"
            onClick={() => onSelect(item)}
          >
            <span className="annual-fee-panel-item-main">
              <strong>{item.bankName}</strong>
              <span>
                {item.period}期
                {item.cardTails.length > 0 ? ` · 尾号 ${item.cardTails.join('、')}` : ''}
                {!item.hasDetails ? ' · 暂无交易明细' : ''}
              </span>
            </span>
            <strong className="annual-fee-panel-item-amount">
              {formatMoney(item.annualFeeAmount, item.currency)}
            </strong>
            <RightOutlined className="annual-fee-panel-item-chevron" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const navigateFromMobileFlow = useMobileFlowNavigation();
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const { blocked, blockedReason, mayRunRestrictedAction } = useHistoryGate();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [trend, setTrend] = useState<BillsTrend>({ months: 6, currency: 'CNY', currencies: ['CNY'], items: [] });
  const [trendCurrency, setTrendCurrency] = useState('CNY');
  const [statsLoading, setStatsLoading] = useState(false);
  const [todosLoading, setTodosLoading] = useState(false);
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [trendLoading, setTrendLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [todosError, setTodosError] = useState<string | null>(null);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [statsKey, setStatsKey] = useState(0);
  const [todosKey, setTodosKey] = useState(0);
  const [upcomingKey, setUpcomingKey] = useState(0);
  const [trendKey, setTrendKey] = useState(0);
  const [markTarget, setMarkTarget] = useState<MarkPaidTarget | null>(null);
  const [annualFeeAcknowledging, setAnnualFeeAcknowledging] = useState(false);
  const [annualFeeSnapshot, setAnnualFeeSnapshot] = useState<AnnualFeeNotice | null>(null);
  const [annualFeeDetailItem, setAnnualFeeDetailItem] = useState<AnnualFeeNoticeItem | null>(null);
  const [annualFeeDetails, setAnnualFeeDetails] = useState<BillDetails | null>(null);
  const [annualFeeDetailLoading, setAnnualFeeDetailLoading] = useState(false);
  const [annualFeeDetailError, setAnnualFeeDetailError] = useState<string | null>(null);
  const annualFeeDetailGeneration = useRef(0);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      setSummary(await api.get<DashboardSummary>('/api/dashboard/summary'));
    } catch (error) {
      setStatsError(errMsg(error));
      throw error;
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadTodos = useCallback(async () => {
    setTodosLoading(true);
    setTodosError(null);
    try {
      setTodos((await api.get<{ items: TodoItem[] }>('/api/reminders/todos')).items);
    } catch (error) {
      setTodosError(errMsg(error));
      throw error;
    } finally {
      setTodosLoading(false);
    }
  }, []);

  const loadUpcoming = useCallback(async () => {
    setUpcomingLoading(true);
    setUpcomingError(null);
    try {
      setUpcoming((await api.get<{ items: UpcomingItem[] }>('/api/reminders/upcoming?days=14')).items);
    } catch (error) {
      setUpcomingError(errMsg(error));
      throw error;
    } finally {
      setUpcomingLoading(false);
    }
  }, []);

  const loadTrend = useCallback(async () => {
    setTrendLoading(true);
    setTrendError(null);
    try {
      const result = await api.get<BillsTrend>(`/api/bills/trend?months=6&currency=${trendCurrency}`);
      setTrend(result);
      if (result.currency !== trendCurrency) setTrendCurrency(result.currency);
    } catch (error) {
      setTrendError(errMsg(error));
      throw error;
    } finally {
      setTrendLoading(false);
    }
  }, [trendCurrency]);

  const refreshStats = useCoalescedRefresh(loadStats);
  const refreshTodos = useCoalescedRefresh(loadTodos);
  const refreshUpcoming = useCoalescedRefresh(loadUpcoming);
  const refreshTrend = useCoalescedRefresh(loadTrend);

  useEffect(() => {
    void refreshStats().catch(() => undefined);
  }, [refreshStats, statsKey]);
  useEffect(() => {
    void refreshTodos().catch(() => undefined);
  }, [refreshTodos, todosKey]);
  useEffect(() => {
    void refreshUpcoming().catch(() => undefined);
  }, [refreshUpcoming, upcomingKey]);
  useEffect(() => {
    void refreshTrend().catch(() => undefined);
  }, [refreshTrend, trendKey]);

  const reloadPaid = () => {
    // 写提交后必须排队执行新读取；汇总同时刷新，让年费提醒按还款状态即时消失。
    void Promise.allSettled([
      refreshStats({ freshAfterInFlight: true }),
      refreshTodos({ freshAfterInFlight: true }),
      refreshUpcoming({ freshAfterInFlight: true }),
    ]).then((results) => {
      if (results.some((result) => result.status === 'rejected')) {
        message.warning('还款已保存，部分数据刷新失败，请在对应分区重试');
      }
    });
  };

  const acknowledgeAnnualFeeNotice = async (notice = summary?.annualFeeNotice): Promise<boolean> => {
    if (!notice || annualFeeAcknowledging) return false;
    const targetBillId = notice.acknowledgeThroughBillId;
    setAnnualFeeAcknowledging(true);
    try {
      await api.post('/api/dashboard/annual-fee-notice/acknowledge', {
        acknowledgeThroughBillId: targetBillId,
      });
    } catch (error) {
      message.error(`年费提醒确认失败：${errMsg(error)}`);
      setAnnualFeeAcknowledging(false);
      return false;
    }

    setSummary((current) => current?.annualFeeNotice?.acknowledgeThroughBillId === targetBillId
      ? { ...current, annualFeeNotice: null }
      : current);
    try {
      await refreshStats({ freshAfterInFlight: true });
    } catch {
      message.warning('年费提醒已确认，首页数据刷新失败，请重试');
    } finally {
      setAnnualFeeAcknowledging(false);
    }
    return true;
  };

  const closeAnnualFeePanel = () => {
    annualFeeDetailGeneration.current += 1;
    setAnnualFeeSnapshot(null);
    setAnnualFeeDetailItem(null);
    setAnnualFeeDetails(null);
    setAnnualFeeDetailLoading(false);
    setAnnualFeeDetailError(null);
  };

  const backFromAnnualFeeDetail = () => {
    if ((annualFeeSnapshot?.items.length ?? 0) <= 1) {
      closeAnnualFeePanel();
      return;
    }
    annualFeeDetailGeneration.current += 1;
    setAnnualFeeDetailItem(null);
    setAnnualFeeDetails(null);
    setAnnualFeeDetailLoading(false);
    setAnnualFeeDetailError(null);
  };

  const openAnnualFeeDetail = async (
    notice: AnnualFeeNotice,
    item: AnnualFeeNoticeItem,
    acknowledgeAfterLoad: boolean,
  ) => {
    if (!mayRunRestrictedAction()) {
      message.warning(blockedReason);
      return;
    }
    const generation = ++annualFeeDetailGeneration.current;
    setAnnualFeeSnapshot(notice);
    setAnnualFeeDetailItem(item);
    setAnnualFeeDetails(null);
    setAnnualFeeDetailError(null);
    setAnnualFeeDetailLoading(true);
    try {
      const details = await api.get<BillDetails>(`/api/bills/${item.billId}/details`);
      if (generation !== annualFeeDetailGeneration.current) return;
      setAnnualFeeDetails(details);
      if (acknowledgeAfterLoad) void acknowledgeAnnualFeeNotice(notice);
    } catch (error) {
      if (generation !== annualFeeDetailGeneration.current) return;
      setAnnualFeeDetailError(errMsg(error));
    } finally {
      if (generation === annualFeeDetailGeneration.current) setAnnualFeeDetailLoading(false);
    }
  };

  const openAnnualFeeNotice = () => {
    const notice = summary?.annualFeeNotice;
    if (!notice || notice.items.length === 0) return;
    if (notice.items.length === 1) {
      void openAnnualFeeDetail(notice, notice.items[0], true);
      return;
    }
    setAnnualFeeSnapshot(notice);
    setAnnualFeeDetailItem(null);
    setAnnualFeeDetails(null);
    setAnnualFeeDetailError(null);
    setAnnualFeeDetailLoading(false);
    void acknowledgeAnnualFeeNotice(notice);
  };

  const markPaid = (item: TodoItem) => {
    if (item.recordType === 'custom' && item.occurrenceId && item.businessType && item.businessType !== 'general') {
      setMarkTarget({
        targetType: 'custom',
        occurrenceId: item.occurrenceId,
        businessType: item.businessType,
        name: item.name,
        cardId: 0,
        bankName: item.name ?? '',
        cardLast4: '',
        period: '',
        currency: item.currency ?? 'CNY',
        amount: item.amount,
        paidStatus: item.paidStatus,
      });
      return;
    }
    if (item.cardId == null || !item.bankName || !item.cardTails || !item.period) return;
    setMarkTarget({
      cardId: item.cardId,
      bankName: item.bankName,
      cardLast4: item.cardTails[0] ?? '',
      period: item.period,
      currency: item.currency ?? 'CNY',
      billId: item.billId ?? undefined,
      amount: item.amount,
      minAmount: item.minAmount ?? null,
      paidStatus: item.paidStatus,
      paidAmount: item.paidAmount ?? null,
    });
  };

  const complete = async (occurrenceId: number) => {
    try {
      await api.post(`/api/reminders/occurrences/${occurrenceId}/complete`);
      message.success('已完成');
      await Promise.allSettled([refreshTodos({ freshAfterInFlight: true }), refreshUpcoming({ freshAfterInFlight: true })]);
    } catch (error) {
      message.error(errMsg(error));
    }
  };

  const handleTodo = (item: TodoItem) => {
    if (item.action === 'complete' && item.occurrenceId) {
      void complete(item.occurrenceId);
      return;
    }
    markPaid(item);
  };

  const openTodoCard = (item: TodoItem) => {
    if (!isMobile || item.recordType !== 'card' || item.cardId == null) return;
    navigate('/cards', { state: { mobileCardId: item.cardId } });
  };

  const handleUpcoming = (item: UpcomingItem) => {
    if (item.cardId) {
      navigate(`/bills?cardId=${item.cardId}`);
      return;
    }
    if (!item.actionable || !item.customOccurrenceId) return;
    if (item.customAction === 'complete') {
      void complete(item.customOccurrenceId);
      return;
    }
    if (item.customBusinessType && item.customBusinessType !== 'general') {
      setMarkTarget({
        targetType: 'custom',
        occurrenceId: item.customOccurrenceId,
        businessType: item.customBusinessType,
        name: item.title,
        cardId: 0,
        bankName: item.title,
        cardLast4: '',
        period: '',
        currency: item.currency ?? 'CNY',
        amount: item.amount,
        paidStatus: item.paidStatus,
      });
    }
  };

  const todoStatus = (t: TodoItem) => {
    if (t.daysOverdue != null) return <Tag color="red">{overdueText(t.daysOverdue)}</Tag>;
    if (hasMetMinimumPayment({ paidStatus: t.paidStatus, paidAmount: t.paidAmount ?? null, minAmount: t.minAmount ?? null })) {
      return <Tag color="blue">已还最低</Tag>;
    }
    const daysLeft = dayjs(t.dueDate).startOf('day').diff(dayjs().startOf('day'), 'day');
    if (t.action === 'complete') return <Tag color="purple">{daysLeft === 0 ? '今天' : daysLeft === 1 ? '明天' : `${daysLeft} 天后`}</Tag>;
    if (daysLeft === 0) return <Tag color="red">今天还款日</Tag>;
    return <Tag color="orange">{daysLeft === 1 ? '明天' : `${daysLeft} 天后`}还款</Tag>;
  };

  const refreshAll = async () => {
    const results = await Promise.allSettled([
      refreshStats(),
      refreshTodos(),
      refreshUpcoming(),
      refreshTrend(),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      message.warning('部分数据刷新失败，请在对应分区重试');
      throw new Error('部分数据刷新失败');
    }
  };

  if (isMobile) {
    const visibleTodos = todos.slice(0, 6);
    return (
      <>
        {!markTarget && <Page title="仪表盘" className="dashboard-page">
          <MobilePullToRefresh onRefresh={refreshAll}>
          <div className="mobile-dashboard">
            <section className="mobile-dashboard-section mobile-dashboard-summary" aria-label="还款概览">
              {statsError ? (
                <Alert
                  type="error"
                  showIcon
                  title={statsError}
                  action={<Button onClick={() => setStatsKey((key) => key + 1)}>重试</Button>}
                />
              ) : (
                <Spin spinning={statsLoading}>
                  <Row gutter={10} className="mobile-dashboard-key-stats">
                    <Col span={12}>
                      <Card className="mobile-dashboard-key-stat mobile-dashboard-key-stat-primary" size="small">
                        <Typography.Text type="secondary">当前待还</Typography.Text>
                        <strong>{summary?.currentPeriod.unpaidCount ?? 0} 笔</strong>
                        <div className="mobile-dashboard-key-stat-detail">
                          {summary?.currentPeriod.totalsByCurrency.some((entry) => entry.unpaidTotal > 0)
                            ? summary.currentPeriod.totalsByCurrency
                                .filter((entry) => entry.unpaidTotal > 0)
                                .map((entry) => formatMoney(entry.unpaidTotal, entry.currency))
                                .join(' · ')
                            : '暂无待还金额'}
                        </div>
                      </Card>
                    </Col>
                    <Col span={12}>
                      <Card className="mobile-dashboard-key-stat" size="small">
                        <Typography.Text type="secondary">14 天内到期</Typography.Text>
                        <strong>{summary?.upcoming14d.dueCount ?? 0} 项</strong>
                        <div className="mobile-dashboard-key-stat-detail">
                          {summary?.upcoming14d.dueCount ? '请留意近期安排' : '暂无到期事项'}
                        </div>
                      </Card>
                    </Col>
                  </Row>
                  {(summary?.currentPeriod.unknownAmountCount ?? 0) > 0 && (
                    <Typography.Text type="secondary" className="mobile-dashboard-unknown-note">
                      {summary!.currentPeriod.unknownAmountCount} 笔账单金额待填写
                    </Typography.Text>
                  )}
                </Spin>
              )}
              {summary?.annualFeeNotice && (
                <AnnualFeeNoticeAlert
                  notice={summary.annualFeeNotice}
                  acknowledging={annualFeeAcknowledging}
                  mobile
                  onView={openAnnualFeeNotice}
                  onAcknowledge={() => void acknowledgeAnnualFeeNotice()}
                />
              )}
            </section>

            <Card
              title="今日待办"
              extra={
                todos.length > visibleTodos.length ? (
                  <Button type="link" onClick={() => navigate('/reminders')}>查看全部 {todos.length}</Button>
                ) : undefined
              }
              size="small"
              variant="outlined"
              className="mobile-dashboard-section"
            >
              {todosError ? (
                <Alert
                  type="error"
                  showIcon
                  title={todosError}
                  action={<Button onClick={() => setTodosKey((key) => key + 1)}>重试</Button>}
                />
              ) : todosLoading && todos.length === 0 ? (
                <div className="mobile-section-loading"><Spin /></div>
              ) : todos.length === 0 ? (
                <Empty description="暂无待办" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <div className="dashboard-list" role="list">
                  {visibleTodos.map((item) => (
                    <article
                      key={item.recordType === 'custom' ? `custom-${item.occurrenceId}` : `${item.cardId}-${item.period}`}
                      className={`dashboard-list-item mobile-todo-card ${todoBandClass(item)}${item.recordType === 'card' ? ' is-card' : ''}`}
                      role="listitem"
                      onClick={() => openTodoCard(item)}
                      onKeyDown={(event) => {
                        if (item.recordType !== 'card' || (event.key !== 'Enter' && event.key !== ' ')) return;
                        event.preventDefault();
                        openTodoCard(item);
                      }}
                      tabIndex={item.recordType === 'card' ? 0 : undefined}
                      aria-label={item.recordType === 'card' ? `查看 ${todoTitle(item)} 卡片详情` : undefined}
                    >
                      <header className="mobile-todo-card-heading">
                        <div className="mobile-todo-card-title">
                          <span className={`mobile-todo-bank-mark${item.daysOverdue != null ? ' is-overdue' : ''}`} aria-hidden="true">
                            {item.recordType === 'card' ? (item.bankName?.slice(0, 1) ?? '卡') : '提'}
                          </span>
                          <Typography.Text strong>{todoTitle(item)}</Typography.Text>
                        </div>
                        {item.recordType === 'card' && <span className="mobile-todo-card-chevron" aria-hidden="true">›</span>}
                      </header>
                      <div className="mobile-todo-card-facts">
                        <div className="mobile-todo-card-amount">
                          {item.amount != null ? (
                            <Typography.Text type="danger" className="amount-strong">
                              {formatMoney(item.amount, item.currency ?? 'CNY')}
                            </Typography.Text>
                          ) : (
                            <Typography.Text type="secondary">
                              {item.recordType === 'custom' ? (item.action === 'complete' ? item.note || '待完成' : '金额待填写') : '未取得账单'}
                            </Typography.Text>
                          )}
                          <span>{item.recordType === 'custom' ? '提醒事项' : '本期账单'}</span>
                          {item.paidStatus === 'partial' && item.amount != null && (
                            <Typography.Text type="secondary" className="mobile-inline-detail">
                              已还 {formatMoney(item.paidAmount ?? 0, item.currency ?? 'CNY')}，剩{' '}
                              {formatMoney(Math.max(0, item.amount - (item.paidAmount ?? 0)), item.currency ?? 'CNY')}
                            </Typography.Text>
                          )}
                        </div>
                        <div className={`mobile-todo-card-due${item.daysOverdue != null ? ' is-overdue' : ''}`}>
                          <strong>{todoDueCopy(item)}</strong>
                          <span>{dayjs(item.dueDate).format('MM-DD')}</span>
                        </div>
                        {item.paidStatus !== 'paid' && (
                          <Button
                            type="primary"
                            ghost
                            onClick={(event) => {
                              event.stopPropagation();
                              handleTodo(item);
                            }}
                          >
                            {item.action === 'complete' ? '完成' : item.action === 'custom_payment' ? '还款' : '标记已还'}
                          </Button>
                        )}
                      </div>
                      {item.recordType === 'custom' && item.note && item.action !== 'complete' && (
                        <Typography.Text type="secondary" className="mobile-todo-card-note">
                          {item.note}
                        </Typography.Text>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="未来 14 天"
              extra={
                upcoming.length > 5 ? (
                  <Button type="link" onClick={() => navigate('/reminders')}>查看全部 {upcoming.length}</Button>
                ) : undefined
              }
              size="small"
              variant="outlined"
              className="mobile-dashboard-section"
            >
              {upcomingError ? (
                <Alert
                  type="error"
                  showIcon
                  title={upcomingError}
                  action={<Button onClick={() => setUpcomingKey((key) => key + 1)}>重试</Button>}
                />
              ) : upcomingLoading && upcoming.length === 0 ? (
                <div className="mobile-section-loading"><Spin /></div>
              ) : upcoming.length === 0 ? (
                <Empty description="14 天内暂无事项" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <div className="dashboard-list" role="list">
                  {upcoming.slice(0, 5).map((item) => (
                    <div
                      key={item.sourceKey}
                      className="dashboard-list-item"
                      onClick={() => handleUpcoming(item)}
                      onKeyDown={(event) => {
                        if ((!item.cardId && !item.actionable) || (event.key !== 'Enter' && event.key !== ' ')) return;
                        event.preventDefault();
                        handleUpcoming(item);
                      }}
                      role={item.cardId || item.actionable ? 'button' : undefined}
                      tabIndex={item.cardId || item.actionable ? 0 : undefined}
                      aria-label={item.cardId || item.actionable ? item.title : undefined}
                    >
                      <div className="mobile-upcoming-row">
                        <div className="mobile-upcoming-date">
                          <Typography.Text strong>{dayjs(item.date).format('MM-DD')}</Typography.Text>
                          <Typography.Text type="secondary">{item.daysLeft === 0 ? '今天' : `${item.daysLeft} 天后`}</Typography.Text>
                        </div>
                        <div className="mobile-upcoming-main">
                          <div>
                            {upcomingTag(item)}
                            {item.linkedCount != null && item.linkedCount > 1 && <Tag>{item.linkedCount} 张卡</Tag>}
                          </div>
                          <Typography.Text strong>{item.title}</Typography.Text>
                          {item.detail && <Typography.Text type="secondary">{item.detail}</Typography.Text>}
                        </div>
                        {item.amount != null && (
                          <Typography.Text type="danger" className="amount-strong">{formatMoney(item.amount, item.currency ?? 'CNY')}</Typography.Text>
                        )}
                        {item.type === 'custom' && item.actionable && (
                          <Button size="small" type="primary" ghost>
                            {item.customAction === 'complete' ? '完成' : '还款'}
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="每月账单合计"
              size="small"
              variant="outlined"
              className="mobile-dashboard-section"
              extra={trend.currencies.length > 1 ? (
                <Select
                  size="small"
                  value={trendCurrency}
                  options={trend.currencies.map((currency) => ({ value: currency, label: currency }))}
                  onChange={setTrendCurrency}
                />
              ) : null}
            >
              {trendError ? (
                <Alert
                  type="error"
                  showIcon
                  title={trendError}
                  action={<Button onClick={() => setTrendKey((key) => key + 1)}>重试</Button>}
                />
              ) : (
                <Spin spinning={trendLoading}><TrendChart items={trend.items} currency={trend.currency} height={180} /></Spin>
              )}
            </Card>

            <Card title="快捷入口" size="small" variant="outlined" className="mobile-dashboard-section">
              <div className="mobile-quick-actions">
                <Button icon={<CreditCardOutlined />} onClick={() => navigate('/cards')}>卡片</Button>
                <Button icon={<FileTextOutlined />} onClick={() => navigate('/bills')}>账单</Button>
                <Button icon={<SyncOutlined />} onClick={() => navigate('/email')}>邮箱</Button>
              </div>
            </Card>
          </div>
          </MobilePullToRefresh>
        </Page>}
        <MarkPaidModal target={markTarget} onClose={() => setMarkTarget(null)} onDone={reloadPaid} />
        {annualFeeSnapshot && !annualFeeDetailItem && (
          <MobileFlow title={`年费账单（${annualFeeSnapshot.items.length} 笔）`} onBack={closeAnnualFeePanel}>
            <AnnualFeeNoticeList
              notice={annualFeeSnapshot}
              onSelect={(item) => void openAnnualFeeDetail(annualFeeSnapshot, item, false)}
            />
          </MobileFlow>
        )}
        {annualFeeSnapshot && annualFeeDetailItem && (
          <MobileBillDetails
            target={{
              billId: annualFeeDetailItem.billId,
              bankName: annualFeeDetailItem.bankName,
              cardTails: annualFeeDetailItem.cardTails,
              period: annualFeeDetailItem.period,
            }}
            details={annualFeeDetails}
            loading={annualFeeDetailLoading}
            error={annualFeeDetailError}
            blocked={blocked}
            blockedReason={blockedReason}
            onBack={backFromAnnualFeeDetail}
            onRetry={() => void openAnnualFeeDetail(
              annualFeeSnapshot,
              annualFeeDetailItem,
              annualFeeSnapshot.items.length === 1,
            )}
            onViewHistory={() => navigateFromMobileFlow('/email', { state: { showHistoryProgress: true } })}
          />
        )}
      </>
    );
  }

  return (
    <>
    <Page
      title="仪表盘"
      extra={
        <Space>
          <Button icon={<SyncOutlined />} onClick={() => navigate('/email')}>
            同步邮件
          </Button>
          <Button icon={<CreditCardOutlined />} onClick={() => navigate('/cards')}>
            卡片
          </Button>
          <Button icon={<FileTextOutlined />} onClick={() => navigate('/bills')}>
            账单
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setStatsKey((k) => k + 1);
              setTodosKey((k) => k + 1);
              setUpcomingKey((k) => k + 1);
              setTrendKey((k) => k + 1);
            }}
            loading={statsLoading || todosLoading || upcomingLoading || trendLoading}
          >
            刷新
          </Button>
        </Space>
      }
    >
      <div className="dash-section">
        {statsError ? (
          <Alert
            type="error"
            showIcon
            title={statsError}
            action={
              <Button size="small" onClick={() => setStatsKey((k) => k + 1)}>
                重试
              </Button>
            }
          />
        ) : (
          <Spin spinning={statsLoading}>
            <Row gutter={[16, 16]}>
              <Col xs={12} lg={12} xl={6}>
                <Card className="stat-card dash-stat-card" variant="outlined">
                  <Statistic
                    title="启用卡片"
                    value={summary ? `${summary.cards.active}/${summary.cards.total}` : '-'}
                    prefix={<CreditCardOutlined style={{ color: '#1677ff' }} />}
                    styles={{ content: { color: '#1677ff' } }}
                  />
                </Card>
              </Col>
              <Col xs={12} lg={12} xl={6}>
                <Card className="stat-card dash-stat-card" variant="outlined">
                  <Statistic
                    title="当前待还"
                    value={summary ? summary.currentPeriod.unpaidCount : 0}
                    precision={0}
                    prefix={<PayCircleOutlined style={{ color: summary && summary.currentPeriod.unpaidCount > 0 ? '#cf1322' : undefined }} />}
                    suffix="笔待还"
                    styles={summary && summary.currentPeriod.unpaidCount > 0 ? { content: { color: '#cf1322' } } : undefined}
                  />
                  <Space size={8} wrap>
                    {summary?.currentPeriod.totalsByCurrency.filter((entry) => entry.unpaidTotal > 0).map((entry) => (
                      <Typography.Text key={entry.currency} type="danger">{formatMoney(entry.unpaidTotal, entry.currency)}</Typography.Text>
                    ))}
                  </Space>
                  {(summary?.currentPeriod.unknownAmountCount ?? 0) > 0 && (
                    <Typography.Text type="secondary" className="dash-stat-note">
                      {summary!.currentPeriod.unknownAmountCount} 笔金额待填写
                    </Typography.Text>
                  )}
                </Card>
              </Col>
              <Col xs={12} lg={12} xl={6}>
                <Card className="stat-card dash-stat-card" variant="outlined">
                  <Statistic
                    title="14 天内到期"
                    value={summary ? summary.upcoming14d.dueCount : 0}
                    prefix={<ClockCircleOutlined style={{ color: summary && summary.upcoming14d.dueCount > 0 ? '#faad14' : undefined }} />}
                    styles={summary && summary.upcoming14d.dueCount > 0 ? { content: { color: '#faad14' } } : undefined}
                  />
                </Card>
              </Col>
              <Col xs={12} lg={12} xl={6}>
                <Card className="stat-card dash-stat-card" variant="outlined">
                  <Statistic
                    title="邮箱账户"
                    value={summary ? `${summary.email.enabled}/${summary.email.total}` : '-'}
                    prefix={<MailOutlined style={{ color: '#52c41a' }} />}
                    styles={{ content: { color: '#52c41a' } }}
                  />
                  {summary?.email.lastSyncAt && (
                    <Typography.Text type="secondary" className="dash-stat-note">
                      上次同步 {dayjs(summary.email.lastSyncAt).format('MM-DD HH:mm')}
                    </Typography.Text>
                  )}
                </Card>
              </Col>
            </Row>
          </Spin>
        )}
      </div>

      {summary?.annualFeeNotice && (
        <AnnualFeeNoticeAlert
          notice={summary.annualFeeNotice}
          acknowledging={annualFeeAcknowledging}
          onView={openAnnualFeeNotice}
          onAcknowledge={() => void acknowledgeAnnualFeeNotice()}
        />
      )}

      <div className="dash-section" style={{ marginTop: 16 }}>
        <Card
          size="small"
          variant="outlined"
          title="每月账单合计"
          extra={trend.currencies.length > 1 ? (
            <Select
              size="small"
              value={trendCurrency}
              options={trend.currencies.map((currency) => ({ value: currency, label: currency }))}
              onChange={setTrendCurrency}
            />
          ) : null}
        >
          {trendError ? (
            <Alert
              type="error"
              showIcon
              title={trendError}
              action={
                <Button size="small" onClick={() => setTrendKey((k) => k + 1)}>
                  重试
                </Button>
              }
            />
          ) : (
            <Spin spinning={trendLoading}>
              <TrendChart items={trend.items} currency={trend.currency} height={200} />
            </Spin>
          )}
        </Card>
      </div>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={10}>
          <div className="dash-section">
            <Card className="dashboard-desktop-lower-card" title="今日待办" size="small" variant="outlined">
              {todosError ? (
                <Alert
                  type="error"
                  showIcon
                  title={todosError}
                  action={
                    <Button size="small" onClick={() => setTodosKey((k) => k + 1)}>
                      重试
                    </Button>
                  }
                />
              ) : todosLoading && todos.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 24 }}>
                  <Spin />
                </div>
              ) : todos.length === 0 ? (
                <Empty description="暂无待办" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <div className="dashboard-list dashboard-list-compact" role="list">
                  {todos.map((item) => (
                    <div
                      key={item.recordType === 'custom' ? `custom-${item.occurrenceId}` : `${item.cardId}-${item.period}`}
                      className={`dashboard-list-item ${todoBandClass(item)}`}
                      role="listitem"
                    >
                      <div className="dashboard-list-main">
                        <div className="dashboard-list-title">
                          <span>
                            {todoTitle(item)}
                            {todoStatus(item)}
                          </span>
                        </div>
                        <div className="dashboard-list-description">
                          <span>
                            {item.amount != null ? (
                              <Typography.Text type="danger" className="amount-strong">
                                {formatMoney(item.amount, item.currency ?? 'CNY')}
                              </Typography.Text>
                            ) : (
                              <Typography.Text type={item.daysOverdue != null ? 'danger' : 'secondary'}>
                                {item.recordType === 'custom' ? (item.action === 'complete' ? item.note || '' : '金额待填写') : '账单金额未取得'}
                              </Typography.Text>
                            )}
                            {item.paidStatus === 'partial' && item.amount != null && (
                              <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                                已还 {formatMoney(item.paidAmount ?? 0, item.currency ?? 'CNY')}，剩{' '}
                                {formatMoney(Math.max(0, item.amount - (item.paidAmount ?? 0)), item.currency ?? 'CNY')}
                              </Typography.Text>
                            )}
                            <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                              {item.action === 'complete'
                                ? dayjs(item.dueDate).format('M月D日')
                                : item.daysOverdue != null
                                  ? `还款日 ${dayjs(item.dueDate).format('M月D日')}`
                                  : `${dayjs(item.dueDate).format('M月D日')} 还款`}
                            </Typography.Text>
                          </span>
                        </div>
                      </div>
                      {item.paidStatus !== 'paid' && (
                        <Button size="small" type="primary" ghost onClick={() => handleTodo(item)}>
                          {item.action === 'complete' ? '完成' : item.action === 'custom_payment' ? '还款' : '标记已还'}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </Col>
        <Col xs={24} xl={14}>
          <div className="dash-section">
            <Card
              className="dashboard-desktop-lower-card"
              title="未来 14 天"
              extra={
                upcoming.length > 8 ? (
                  <Button type="link" onClick={() => navigate('/reminders')}>查看全部 {upcoming.length}</Button>
                ) : undefined
              }
              size="small"
              variant="outlined"
            >
              {upcomingError ? (
                <Alert
                  type="error"
                  showIcon
                  title={upcomingError}
                  action={
                    <Button size="small" onClick={() => setUpcomingKey((k) => k + 1)}>
                      重试
                    </Button>
                  }
                />
              ) : (
              <Table<UpcomingItem>
                rowKey="sourceKey"
                dataSource={upcoming.slice(0, 8)}
                loading={upcomingLoading}
                pagination={false}
                size="small"
                locale={{ emptyText: <Empty description="14 天内暂无事项" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                columns={[
                  {
                    title: '日期',
                    dataIndex: 'date',
                    width: 110,
                    render: (v: string, r) => (
                      <div>
                        <div>{dayjs(v).format('MM-DD ddd')}</div>
                        {r.daysLeft === 0 ? <Tag color="red">今天</Tag> : <Tag>{r.daysLeft} 天后</Tag>}
                      </div>
                    ),
                  },
                  {
                    title: '类型',
                    dataIndex: 'type',
                    width: 80,
                    render: (_: UpcomingItem['type'], row) => upcomingTag(row),
                  },
                  {
                    title: '事项',
                    dataIndex: 'title',
                    render: (v: string, r) => (
                      <span>
                        {v}
                        {r.linkedCount != null && r.linkedCount > 1 && (
                          <Tag style={{ marginLeft: 6 }}>{r.linkedCount} 张卡</Tag>
                        )}
                        {r.amount != null && (
                          <Typography.Text type="danger" className="amount-strong" style={{ marginLeft: 8 }}>
                            {formatMoney(r.amount, r.currency ?? 'CNY')}
                          </Typography.Text>
                        )}
                        {r.detail && (
                          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                            {r.detail}
                          </Typography.Text>
                        )}
                      </span>
                    ),
                  },
                  {
                    title: '状态',
                    dataIndex: 'paidStatus',
                    width: 90,
                    render: (v: string | null) =>
                      v === 'paid' ? (
                        <Tag color="green">已还清</Tag>
                      ) : v === 'partial' ? (
                        <Tag color="orange">部分已还</Tag>
                      ) : v === 'unpaid' ? (
                        <Tag>待还</Tag>
                      ) : (
                        '-'
                      ),
                  },
                  {
                    title: '操作',
                    key: 'action',
                    width: 80,
                    render: (_, row) => row.type === 'custom' && row.actionable ? (
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        onClick={(event) => {
                          event.stopPropagation();
                          handleUpcoming(row);
                        }}
                      >
                        {row.customAction === 'complete' ? '完成' : '还款'}
                      </Button>
                    ) : null,
                  },
                ]}
                onRow={(r) => ({
                  onClick: () => r.cardId && handleUpcoming(r),
                  onKeyDown: (event) => {
                    if (!r.cardId || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    navigate(`/bills?cardId=${r.cardId}`);
                  },
                  role: r.cardId ? 'link' : undefined,
                  tabIndex: r.cardId ? 0 : undefined,
                  'aria-label': r.cardId ? `查看 ${r.title} 的账单` : undefined,
                  style: { cursor: r.cardId ? 'pointer' : 'default' },
                })}
              />
              )}
            </Card>
          </div>
        </Col>
      </Row>

    </Page>
    <MarkPaidModal target={markTarget} onClose={() => setMarkTarget(null)} onDone={reloadPaid} />
    <Modal
      open={annualFeeSnapshot != null}
      onCancel={closeAnnualFeePanel}
      footer={null}
      width={760}
      title={annualFeeSnapshot && annualFeeDetailItem ? (
        <Space size={6}>
          {annualFeeSnapshot.items.length > 1 && (
            <Button type="text" size="small" icon={<LeftOutlined />} onClick={backFromAnnualFeeDetail}>
              返回
            </Button>
          )}
          <span>
            {annualFeeDetailItem.bankName}（{billCardTailsText(annualFeeDetailItem.cardTails)}）
            {annualFeeDetailItem.period}期账单明细
          </span>
        </Space>
      ) : `年费账单（${annualFeeSnapshot?.items.length ?? 0} 笔）`}
    >
      {annualFeeSnapshot && annualFeeDetailItem ? (
        <DesktopBillDetailsContent
          details={annualFeeDetails}
          loading={annualFeeDetailLoading}
          error={annualFeeDetailError}
          blocked={blocked}
          onRetry={() => void openAnnualFeeDetail(
            annualFeeSnapshot,
            annualFeeDetailItem,
            annualFeeSnapshot.items.length === 1,
          )}
          onViewHistory={() => navigate('/email', { state: { showHistoryProgress: true } })}
        />
      ) : annualFeeSnapshot ? (
        <AnnualFeeNoticeList
          notice={annualFeeSnapshot}
          onSelect={(item) => void openAnnualFeeDetail(annualFeeSnapshot, item, false)}
        />
      ) : null}
    </Modal>
    </>
  );
}
