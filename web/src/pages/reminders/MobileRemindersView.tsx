import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Empty, Spin, Tag, Typography } from 'antd';
import {
  BellOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  CreditCardOutlined,
  PlusOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { Virtuoso } from 'react-virtuoso';
import type { CustomReminderBusinessType, ReminderEvent, TodoItem, UpcomingItem } from '../../api/types';
import { MobileEmpty, MobilePullToRefresh } from '../../components/MobilePrimitives';
import { overdueText } from '../../lib/overdue';
import { formatMoney } from '../../lib/money';
import './reminders.css';

export interface ReminderRunResult {
  pushed: number;
  skipped: number;
  failed: number;
}

interface VirtualizedReminderListProps<T> {
  items: T[];
  scrollParent: HTMLElement | null;
  computeItemKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
}

function VirtualizedReminderList<T>({
  items,
  scrollParent,
  computeItemKey,
  renderItem,
}: VirtualizedReminderListProps<T>) {
  if (!scrollParent) {
    return (
      <div className="mobile-reminder-list mobile-reminder-list-fallback">
        {items.map((item, index) => (
          <div
            className={`mobile-reminder-list-item${index === items.length - 1 ? ' mobile-reminder-list-item-last' : ''}`}
            key={computeItemKey(item, index)}
          >
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Virtuoso
      className="mobile-reminder-list mobile-reminder-virtual-list"
      customScrollParent={scrollParent}
      data={items}
      computeItemKey={(index, item) => computeItemKey(item, index)}
      increaseViewportBy={{ top: 240, bottom: 520 }}
      itemContent={(index, item) => (
        <div className={`mobile-reminder-list-item${index === items.length - 1 ? ' mobile-reminder-list-item-last' : ''}`}>
          {renderItem(item, index)}
        </div>
      )}
    />
  );
}

function customTypeTag(type: CustomReminderBusinessType) {
  if (type === 'fixed_bill') return <Tag color="blue">固定账单</Tag>;
  if (type === 'dynamic_bill') return <Tag color="gold">动态账单</Tag>;
  return <Tag color="purple">常规提醒</Tag>;
}

function typeTag(item: UpcomingItem) {
  if (item.type === 'due') return <Tag color="red">还款日</Tag>;
  if (item.type === 'statement') return <Tag color="blue">出账日</Tag>;
  if (item.type === 'fee') return <Tag color="gold">年费</Tag>;
  return customTypeTag(item.customBusinessType ?? 'general');
}

function eventTypeTag(type: ReminderEvent['type']) {
  if (type === 'card_due') return <Tag color="red">还款提醒</Tag>;
  if (type === 'card_statement') return <Tag color="blue">出账提醒</Tag>;
  if (type === 'card_fee') return <Tag color="gold">年费提醒</Tag>;
  return <Tag color="purple">自定义提醒</Tag>;
}

function ExpandableSummary({
  children,
  secondary = false,
}: {
  children: string;
  secondary?: boolean;
}) {
  const contentId = useId();
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [children]);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      if (!Number.isFinite(lineHeight)) return;
      setCanExpand(element.scrollHeight > lineHeight * 2 + 1);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div className="mobile-reminder-summary-wrap">
      <p
        id={contentId}
        ref={contentRef}
        className={`mobile-reminder-summary${expanded ? ' mobile-reminder-summary-expanded' : ''}${secondary ? ' mobile-reminder-summary-secondary' : ''}`}
      >
        {children}
      </p>
      {canExpand && (
        <Button
          type="link"
          className="mobile-reminder-summary-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '展开全文'}
        </Button>
      )}
    </div>
  );
}

export function MobileRemindersView({
  today,
  overdueTodos,
  upcoming,
  loading,
  loadError,
  running,
  runResult,
  runError,
  blocked,
  blockedReason,
  onRunNow,
  onCreate,
  onManage,
  onMarkToday,
  onMarkTodo,
  onUpcoming,
  onRefresh,
  onViewHistory,
}: {
  today: ReminderEvent[];
  overdueTodos: TodoItem[];
  upcoming: UpcomingItem[];
  loading: boolean;
  loadError: string | null;
  running: boolean;
  runResult: ReminderRunResult | null;
  runError: string | null;
  blocked: boolean;
  blockedReason: string;
  onRunNow: () => void;
  onCreate: () => void;
  onManage: () => void;
  onMarkToday: (item: ReminderEvent) => void;
  onMarkTodo: (item: TodoItem) => void;
  onUpcoming: (item: UpcomingItem) => void;
  onRefresh: () => Promise<unknown>;
  onViewHistory: () => void;
}) {
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(() => (
    typeof document === 'undefined' ? null : document.getElementById('root')
  ));

  useEffect(() => {
    if (!scrollParent) setScrollParent(document.getElementById('root'));
  }, [scrollParent]);

  return (
    <MobilePullToRefresh onRefresh={onRefresh} disabled={running}>
      <div className="mobile-reminders">
        <Card size="small" className="mobile-reminders-actions" title="快捷操作">
          <div className="mobile-reminders-action-grid">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={onCreate}
            >
              新增提醒
            </Button>
            <Button icon={<SettingOutlined />} onClick={onManage}>
              提醒设置
            </Button>
            <Button
              icon={<ThunderboltOutlined />}
              disabled={blocked}
              loading={running}
              onClick={onRunNow}
            >
              立即推送
            </Button>
          </div>
        </Card>

        {blocked && (
          <Alert
            type="warning"
            showIcon
            title={blockedReason}
            description="立即推送需等待历史拉取结束；提醒查看、编辑和还款仍可继续。"
            action={<Button onClick={onViewHistory}>查看进度</Button>}
          />
        )}

        {runResult && (
          <Alert
            type={runResult.failed > 0 ? 'warning' : 'success'}
            showIcon
            title="本次推送结果"
            description={
              <span>
                已推送 {runResult.pushed} 条，已跳过 {runResult.skipped} 条，失败 {runResult.failed} 条。
                {runResult.failed > 0 ? ' 请检查已启用的通知渠道配置。' : ''}
              </span>
            }
          />
        )}

        {runError && (
          <Alert type="error" showIcon title="立即推送失败" description={runError} />
        )}

        {loadError && (
          <Alert
            type="error"
            showIcon
            title="提醒数据刷新失败"
            description={loadError}
            action={<Button onClick={() => void onRefresh().catch(() => undefined)}>重试</Button>}
          />
        )}

        <Spin spinning={loading}>
          <div className="mobile-reminders-sections">
            {overdueTodos.length > 0 && (
              <Card
                size="small"
                className="mobile-reminders-section mobile-reminders-section-danger"
                title={<span className="mobile-reminders-section-title">逾期未处理 <b>{overdueTodos.length}</b></span>}
              >
                <VirtualizedReminderList
                  items={overdueTodos}
                  scrollParent={scrollParent}
                  computeItemKey={(item, index) => item.recordType === 'custom'
                    ? `custom-${item.occurrenceId}-${index}`
                    : `${item.billId ?? `missing-${item.cardId}`}-${item.dueDate}-${index}`}
                  renderItem={(item) => (
                      <article className="mobile-reminder-row">
                        <div className="mobile-reminder-heading">
                          <Typography.Text strong className="mobile-reminder-title">
                            {item.recordType === 'custom'
                              ? item.name
                              : `${item.bankName}（${(item.cardTails?.length ?? 0) > 1
                                ? `${item.cardTails?.[0]} 等${item.cardTails?.length}张卡`
                                : item.cardTails?.[0]}）${item.period}期`}
                          </Typography.Text>
                          <Tag color="red">{overdueText(item.daysOverdue!)}</Tag>
                        </div>
                        <div className="mobile-reminder-core-line">
                          {item.recordType === 'custom' && item.businessType === 'general' ? (
                            <Typography.Text>{item.note || ''}</Typography.Text>
                          ) : item.amount == null ? (
                            <Typography.Text>{item.recordType === 'custom' ? '金额待填写' : '账单金额未取得'}</Typography.Text>
                          ) : (
                            <Typography.Text type="danger" className="amount-strong mobile-reminder-amount">
                              {formatMoney(item.amount, item.currency ?? 'CNY')}
                            </Typography.Text>
                          )}
                          <span className="mobile-reminder-meta-item">
                            <CalendarOutlined /> {item.action === 'complete' ? '日期' : '还款日'} {dayjs(item.dueDate).format('YYYY-MM-DD')}
                          </span>
                        </div>
                        {item.recordType === 'card' && (
                          <Typography.Text type="secondary" className="mobile-reminder-secondary-line">
                            最低还款 {item.minAmount == null ? '-' : formatMoney(item.minAmount, item.currency ?? 'CNY')}
                            <span aria-hidden="true"> · </span>
                            已还 {item.paidAmount == null ? '-' : formatMoney(item.paidAmount, item.currency ?? 'CNY')}
                          </Typography.Text>
                        )}
                        {item.paidStatus !== 'paid' && (
                          <Button className="mobile-reminder-primary-action" type="primary" ghost onClick={() => onMarkTodo(item)}>
                            {item.action === 'complete' ? '完成' : item.action === 'custom_payment' ? '还款' : '标记已还'}
                          </Button>
                        )}
                      </article>
                  )}
                />
              </Card>
            )}

            <Card
              size="small"
              className="mobile-reminders-section mobile-reminders-section-today"
              title={<span className="mobile-reminders-section-title">今日应提醒 <b>{today.length}</b></span>}
            >
              {today.length === 0 ? (
                <div className="mobile-reminder-empty"><MobileEmpty title="今日暂无提醒事项" /></div>
              ) : (
                <VirtualizedReminderList
                  items={today}
                  scrollParent={scrollParent}
                  computeItemKey={(item, index) => `${item.type}-${item.refId ?? item.cardId ?? index}-${item.fireDate}`}
                  renderItem={(item) => (
                      <article className="mobile-reminder-row">
                        <div className="mobile-reminder-heading">
                          <Typography.Text strong className="mobile-reminder-title">
                            <BellOutlined className="mobile-reminder-title-icon" />
                            {item.title}
                          </Typography.Text>
                          {item.type === 'custom'
                            ? customTypeTag(item.businessType ?? 'general')
                            : eventTypeTag(item.type)}
                        </div>
                        <ExpandableSummary>{item.body}</ExpandableSummary>
                        <div className="mobile-reminder-meta-line">
                          <span className="mobile-reminder-meta-item">
                            <CalendarOutlined /> {dayjs(item.fireDate).format('YYYY-MM-DD')}
                          </span>
                          {item.bankName && (
                            <span className="mobile-reminder-meta-item">
                              <CreditCardOutlined /> {item.bankName}（{item.cardLast4 || '尾号未提供'}）
                            </span>
                          )}
                          {item.linkedCount != null && item.linkedCount > 1 && (
                            <Tag>{item.linkedCount} 张卡</Tag>
                          )}
                        </div>
                        {(item.amount != null || item.dueDate) && (
                          <div className="mobile-reminder-core-line mobile-reminder-core-line-compact">
                            {item.amount != null && (
                              <Typography.Text type="danger" className="amount-strong">
                                应还 {formatMoney(item.amount, item.currency ?? 'CNY')}
                              </Typography.Text>
                            )}
                            {item.dueDate && (
                              <Typography.Text type="secondary">
                                还款日 {dayjs(item.dueDate).format('YYYY-MM-DD')}
                              </Typography.Text>
                            )}
                          </div>
                        )}
                        {item.type === 'card_due' && item.paidStatus !== 'paid' && (
                          <Button className="mobile-reminder-primary-action" type="primary" ghost onClick={() => onMarkToday(item)}>
                            标记已还
                          </Button>
                        )}
                        {item.type === 'custom' && item.occurrenceId && (
                          <Button className="mobile-reminder-primary-action" type="primary" ghost onClick={() => onMarkToday(item)}>
                            {item.businessType === 'general' ? '完成' : '还款'}
                          </Button>
                        )}
                      </article>
                  )}
                />
              )}
            </Card>

            <Card
              size="small"
              className="mobile-reminders-section"
              title={<span className="mobile-reminders-section-title">未来 30 天 <b>{upcoming.length}</b></span>}
            >
              {upcoming.length === 0 ? (
                <div className="mobile-reminder-empty">
                  <Empty description="30 天内暂无事项" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                </div>
              ) : (
                <VirtualizedReminderList
                  items={upcoming}
                  scrollParent={scrollParent}
                  computeItemKey={(item) => item.sourceKey}
                  renderItem={(item) => (
                      <article className="mobile-reminder-row">
                        <div className="mobile-reminder-heading">
                          <div className="mobile-reminder-date-lockup">
                            <strong>{dayjs(item.date).format('MM-DD')}</strong>
                            <span>{dayjs(item.date).format('ddd')}</span>
                          </div>
                          <Typography.Text strong className="mobile-reminder-title mobile-reminder-title-grow">
                            {item.title}
                          </Typography.Text>
                          {typeTag(item)}
                        </div>
                        <div className="mobile-reminder-meta-line">
                          <span className="mobile-reminder-meta-item">
                            <ClockCircleOutlined /> {item.daysLeft} 天后
                          </span>
                          {item.linkedCount != null && item.linkedCount > 1 && <Tag>{item.linkedCount} 张卡</Tag>}
                          {item.amount != null && (
                            <Typography.Text type="danger" className="amount-strong">{formatMoney(item.amount, item.currency ?? 'CNY')}</Typography.Text>
                          )}
                        </div>
                        {item.detail && (
                          <ExpandableSummary secondary>{item.detail}</ExpandableSummary>
                        )}
                        {item.cardId && (
                          <Button className="mobile-reminder-link-action" type="link" onClick={() => onUpcoming(item)}>
                            查看该卡账单
                          </Button>
                        )}
                        {!item.cardId && item.type === 'custom' && item.actionable && (
                          <Button className="mobile-reminder-primary-action" type="primary" ghost onClick={() => onUpcoming(item)}>
                            {item.customAction === 'complete' ? '完成' : '还款'}
                          </Button>
                        )}
                      </article>
                  )}
                />
              )}
            </Card>
          </div>
        </Spin>
      </div>
    </MobilePullToRefresh>
  );
}
