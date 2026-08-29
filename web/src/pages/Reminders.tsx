import { useCallback, useEffect, useRef, useState, type Key, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  App,
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { BellOutlined, CalendarOutlined, PlusOutlined, ReloadOutlined, SettingOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { api, ApiError } from '../api/client';
import type {
  CustomReminder,
  CustomReminderBusinessType,
  CustomReminderInput,
  CustomReminderScheduleType,
  ReminderEvent,
  TodoItem,
  UpcomingItem,
} from '../api/types';
import { overdueText } from '../lib/overdue';
import { formatMoney } from '../lib/money';
import { Page } from '../components/Layout';
import MarkPaidModal, { type MarkPaidTarget } from '../components/MarkPaidModal';
import { InlineConfirm, MobileFlow, useCoalescedRefresh } from '../components/MobilePrimitives';
import { useResetOnModeChange, useResponsive } from '../responsive';
import { useHistoryGate } from '../historyGate';
import { MobileRemindersView, type ReminderRunResult } from './reminders/MobileRemindersView';

interface CustomFormValues {
  name: string;
  businessType: CustomReminderBusinessType;
  type: CustomReminderScheduleType;
  interval: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  monthOfYear?: number;
  specificDate?: Dayjs;
  daysBefore: number[];
  fixedAmount?: number;
  note?: string;
  enabled: boolean;
  disableMode?: 'keep_open' | 'suspend_open';
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function monthDayLabel(value: number | null | undefined): string {
  if (value === 29) return '月末前 2 天';
  if (value === 30) return '月末前 1 天';
  if (value === 31) return '月末当天';
  return value ? `${value} 日` : '-';
}

function scheduleLabel(reminder: CustomReminder): string {
  const interval = reminder.interval;
  if (reminder.type === 'once') return reminder.specificDate ?? '-';
  if (reminder.type === 'daily') return interval === 1 ? '每天' : `每 ${interval} 天`;
  if (reminder.type === 'weekly') {
    return `${interval === 1 ? '每周' : `每 ${interval} 周`} · ${WEEKDAY_LABELS[(reminder.dayOfWeek ?? 1) - 1]}`;
  }
  if (reminder.type === 'monthly') {
    return `${interval === 1 ? '每月' : `每 ${interval} 月`} · ${monthDayLabel(reminder.dayOfMonth)}`;
  }
  return `${interval === 1 ? '每年' : `每 ${interval} 年`} · ${reminder.monthOfYear} 月 ${reminder.dayOfMonth} 日`;
}

function businessTypeTag(type: CustomReminderBusinessType) {
  if (type === 'fixed_bill') return <Tag color="blue">固定账单</Tag>;
  if (type === 'dynamic_bill') return <Tag color="gold">动态账单</Tag>;
  return <Tag color="purple">常规提醒</Tag>;
}

function PaginatedReminderList<T>({
  items,
  itemKey,
  renderItem,
  pageSize = 5,
}: {
  items: T[];
  itemKey: (item: T) => Key;
  renderItem: (item: T) => ReactNode;
  pageSize?: number;
}) {
  const [page, setPage] = useState(1);
  const lastPage = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, lastPage);

  useEffect(() => {
    if (page > lastPage) setPage(lastPage);
  }, [lastPage, page]);

  const visibleItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="desktop-reminder-list">
      <div role="list">
        {visibleItems.map((item) => (
          <div key={itemKey(item)} className="desktop-reminder-list-item" role="listitem">
            {renderItem(item)}
          </div>
        ))}
      </div>
      {items.length > pageSize && (
        <Pagination
          className="desktop-reminder-pagination"
          current={currentPage}
          pageSize={pageSize}
          total={items.length}
          showSizeChanger={false}
          size="small"
          onChange={setPage}
        />
      )}
    </div>
  );
}

function CustomForm({
  initial,
  onOk,
  onCancel,
  confirmLoading,
}: {
  initial?: CustomReminder | null;
  onOk: (values: CustomReminderInput) => void;
  onCancel: () => void;
  confirmLoading: boolean;
}) {
  const [form] = Form.useForm<CustomFormValues>();
  const type = Form.useWatch('type', form);
  const businessType = Form.useWatch('businessType', form);
  const enabled = Form.useWatch('enabled', form);
  const interval = Form.useWatch('interval', form);
  const dayOfWeek = Form.useWatch('dayOfWeek', form);
  const dayOfMonth = Form.useWatch('dayOfMonth', form);
  const monthOfYear = Form.useWatch('monthOfYear', form);
  const specificDate = Form.useWatch('specificDate', form);
  const daysBefore = Form.useWatch('daysBefore', form);
  const fixedAmount = Form.useWatch('fixedAmount', form);
  const { isMobile } = useResponsive();
  const [dirty, setDirty] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [previewDates, setPreviewDates] = useState<string[]>(initial?.nextDates ?? []);

  useResetOnModeChange(() => setConfirmLeave(false));

  useEffect(() => {
    if (initial) {
      form.setFieldsValue({
        name: initial.name,
        businessType: initial.businessType,
        type: initial.type,
        interval: initial.interval,
        dayOfWeek: initial.dayOfWeek ?? undefined,
        dayOfMonth: initial.dayOfMonth ?? undefined,
        monthOfYear: initial.monthOfYear ?? undefined,
        specificDate: initial.specificDate ? dayjs(initial.specificDate) : undefined,
        daysBefore: initial.daysBefore,
        fixedAmount: initial.fixedAmount ?? undefined,
        note: initial.note ?? undefined,
        enabled: initial.enabled,
      });
      setPreviewDates(initial.nextDates);
    } else {
      form.resetFields();
      form.setFieldsValue({
        businessType: 'general',
        type: 'monthly',
        interval: 1,
        daysBefore: [3, 0],
        enabled: true,
        dayOfMonth: 1,
      });
      setPreviewDates([]);
    }
    setDirty(false);
    setConfirmLeave(false);
  }, [initial, form]);

  const toInput = (values: CustomFormValues): CustomReminderInput => ({
    name: values.name?.trim() ?? '',
    businessType: values.businessType,
    type: values.type,
    interval: values.type === 'once' ? 1 : values.interval ?? 1,
    dayOfWeek: values.type === 'weekly' ? values.dayOfWeek ?? null : null,
    dayOfMonth: values.type === 'monthly' || values.type === 'yearly' ? values.dayOfMonth ?? null : null,
    monthOfYear: values.type === 'yearly' ? values.monthOfYear ?? null : null,
    specificDate: values.type === 'once' && values.specificDate ? values.specificDate.format('YYYY-MM-DD') : null,
    daysBefore: values.daysBefore ?? [],
    fixedAmount: values.businessType === 'fixed_bill' ? values.fixedAmount ?? null : null,
    note: values.note?.trim() || null,
    enabled: values.enabled,
    ...(values.disableMode ? { disableMode: values.disableMode } : {}),
  });

  useEffect(() => {
    const values = form.getFieldsValue();
    const complete = !!values.businessType && !!values.type
      && (values.type === 'once' || (values.interval != null && values.interval > 0))
      && (values.type === 'once' ? !!values.specificDate : true)
      && (values.type === 'weekly' ? !!values.dayOfWeek : true)
      && (values.type === 'monthly' ? !!values.dayOfMonth : true)
      && (values.type === 'yearly' ? !!values.monthOfYear && !!values.dayOfMonth : true);
    if (!complete) {
      setPreviewDates([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void api.post<{ dates: string[] }>('/api/reminders/custom/preview', toInput(values))
        .then((result) => setPreviewDates(result.dates))
        .catch(() => setPreviewDates([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [businessType, dayOfMonth, dayOfWeek, daysBefore, fixedAmount, form, interval, monthOfYear, specificDate, type]);

  const requestCancel = () => {
    if (confirmLoading) return;
    if (isMobile && dirty) {
      setConfirmLeave(true);
      return;
    }
    onCancel();
  };

  const businessTypeOptions = [
    { value: 'general', label: '常规提醒' },
    { value: 'fixed_bill', label: '固定账单' },
    { value: 'dynamic_bill', label: '动态账单' },
  ];
  const scheduleTypeOptions = [
    { value: 'once', label: '单次' },
    { value: 'daily', label: '按天' },
    { value: 'weekly', label: '按周' },
    { value: 'monthly', label: '按月' },
    { value: 'yearly', label: '按年' },
  ];
  const intervalUnit = type === 'daily' ? '天' : type === 'weekly' ? '周' : type === 'monthly' ? '月' : '年';
  const previewContent = previewDates.length > 0 ? (
    <div className="custom-reminder-date-preview" aria-live="polite">
      <CalendarOutlined className="custom-reminder-date-preview-icon" />
      <div className="custom-reminder-date-preview-content">
        <Typography.Text type="secondary">
          {businessType === 'general' ? '接下来提醒' : '接下来还款'}
        </Typography.Text>
        <div className="custom-reminder-date-preview-list">
          {previewDates.map((date) => (
            <span key={date} className="custom-reminder-date-chip">
              <strong>{dayjs(date).format('M 月 D 日')}</strong>
              <small>{dayjs(date).format('ddd')}</small>
            </span>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  const formContent = (
    <Form
      form={form}
      layout="vertical"
      className="custom-reminder-form"
      onValuesChange={() => setDirty(true)}
      onFinish={(values) => onOk(toInput(values))}
    >
      <div className="custom-reminder-form-layout">
        <section className="custom-reminder-form-section">
          <div className="custom-reminder-form-section-title">提醒内容</div>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="请输入名称" maxLength={64} />
          </Form.Item>
          <Form.Item name="businessType" label="提醒类型" rules={[{ required: true }]}>
            {isMobile
              ? <Select options={businessTypeOptions} />
              : <Segmented block options={businessTypeOptions} />}
          </Form.Item>
          {businessType === 'fixed_bill' && (
            <Form.Item name="fixedAmount" label="固定金额" rules={[{ required: true, message: '请输入固定金额' }]}>
              <InputNumber min={0.01} max={99_999_999} precision={2} prefix="CNY ¥" style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Form.Item name="note" label="备注（可选）">
            <Input.TextArea maxLength={255} autoSize={{ minRows: 2, maxRows: 3 }} />
          </Form.Item>
          <div className="custom-reminder-enabled-row">
            <Typography.Text strong>启用提醒</Typography.Text>
            <Form.Item name="enabled" valuePropName="checked" noStyle>
              <Switch />
            </Form.Item>
          </div>
          {initial?.enabled && enabled === false && (
            <Form.Item
              name="disableMode"
              label="当前未处理项"
              rules={[{ required: true, message: '请选择处理方式' }]}
              className="custom-reminder-disable-mode"
            >
              <Select options={[
                { value: 'keep_open', label: '保留当前未处理项' },
                { value: 'suspend_open', label: '同时隐藏未处理项' },
              ]} />
            </Form.Item>
          )}
        </section>

        <section className="custom-reminder-form-section custom-reminder-schedule-section">
          <div className="custom-reminder-form-section-title">周期与通知</div>
          <Form.Item name="type" label="周期" rules={[{ required: true }]}>
            {isMobile
              ? <Select options={scheduleTypeOptions} />
              : <Segmented block options={scheduleTypeOptions} />}
          </Form.Item>
          <div className={`custom-reminder-schedule-grid custom-reminder-schedule-grid-${type ?? 'monthly'}`}>
            {type !== 'once' && (
              <Form.Item name="interval" label={`间隔（${intervalUnit}）`} rules={[{ required: true, message: '请输入周期数' }]}>
                <InputNumber min={1} max={999} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            )}
            {type === 'once' && (
              <Form.Item name="specificDate" label={businessType === 'general' ? '提醒日期' : '还款日期'} rules={[{ required: true, message: '请选择日期' }]}>
                <DatePicker style={{ width: '100%' }} disabledDate={(date) => date.startOf('day').isBefore(dayjs().startOf('day'))} />
              </Form.Item>
            )}
            {type === 'weekly' && (
              <Form.Item name="dayOfWeek" label="星期" rules={[{ required: true, message: '请选择星期' }]}>
                <Select options={WEEKDAY_LABELS.map((label, index) => ({ value: index + 1, label }))} />
              </Form.Item>
            )}
            {type === 'monthly' && (
              <Form.Item name="dayOfMonth" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
                <Select options={[
                  ...Array.from({ length: 28 }, (_, index) => ({ value: index + 1, label: `${index + 1} 日` })),
                  { value: 31, label: '月末当天' },
                  { value: 30, label: '月末前 1 天' },
                  { value: 29, label: '月末前 2 天' },
                ]} />
              </Form.Item>
            )}
            {type === 'yearly' && (
              <>
                <Form.Item name="monthOfYear" label="月份" rules={[{ required: true, message: '请选择月份' }]}>
                  <Select options={Array.from({ length: 12 }, (_, index) => ({ value: index + 1, label: `${index + 1} 月` }))} />
                </Form.Item>
                <Form.Item name="dayOfMonth" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
                  <Select options={Array.from({ length: 31 }, (_, index) => ({ value: index + 1, label: `${index + 1} 日` }))} />
                </Form.Item>
              </>
            )}
          </div>
          <Form.Item name="daysBefore" label="提前提醒">
            <Select
              mode="multiple"
              options={[7, 5, 3, 2, 1, 0].map((n) => ({ value: n, label: n === 0 ? '当天' : `${n} 天前` }))}
            />
          </Form.Item>
          {previewContent}
        </section>
      </div>
    </Form>
  );

  if (isMobile) {
    return (
      <MobileFlow
        title={initial ? '编辑提醒' : '新增提醒'}
        onBack={requestCancel}
        footer={!confirmLeave ? (
          <div className="mobile-flow-action-row">
            <Button block disabled={confirmLoading} onClick={requestCancel}>
              取消
            </Button>
            <Button type="primary" block loading={confirmLoading} onClick={() => form.submit()}>
              保存
            </Button>
          </div>
        ) : undefined}
      >
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {initial ? initial.name : '创建一条新的提醒'}
        </Typography.Title>
        {formContent}
        {confirmLeave && (
          <InlineConfirm
            title="放弃未保存的修改？"
            description="返回后，本次尚未保存的内容将被清除。"
            confirmText="放弃修改"
            onConfirm={onCancel}
            onCancel={() => setConfirmLeave(false)}
            loading={confirmLoading}
          />
        )}
      </MobileFlow>
    );
  }

  return (
    <Modal
      className="custom-reminder-form-modal"
      title={initial ? `编辑提醒 - ${initial.name}` : '新增提醒'}
      open
      onOk={() => form.submit()}
      onCancel={requestCancel}
      confirmLoading={confirmLoading}
      destroyOnHidden
      width="min(1080px, calc(100vw - 48px))"
      styles={{ body: { paddingTop: 20 } }}
    >
      {formContent}
    </Modal>
  );
}

function CustomReminderManager({
  open,
  items,
  deleteTarget,
  deleting,
  onClose,
  onCreate,
  onEdit,
  onDelete,
  onDeleteStart,
  onDeleteCancel,
  onDeleteConfirm,
}: {
  open: boolean;
  items: CustomReminder[];
  deleteTarget: CustomReminder | null;
  deleting: boolean;
  onClose: () => void;
  onCreate: () => void;
  onEdit: (item: CustomReminder) => void;
  onDelete: (item: CustomReminder) => void;
  onDeleteStart: (item: CustomReminder) => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
}) {
  const { isMobile } = useResponsive();
  if (!open) return null;

  if (isMobile) {
    return (
      <MobileFlow
        title="提醒设置"
        onBack={onClose}
        footer={(
          <Button type="primary" block icon={<PlusOutlined />} onClick={onCreate}>
            新增提醒
          </Button>
        )}
      >
        {items.length === 0 ? (
          <Empty description="暂无提醒设置" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div className="custom-reminder-manager-mobile-list">
            {items.map((item) => {
              const confirming = deleteTarget?.id === item.id;
              return (
                <Card key={item.id} size="small" className="custom-reminder-manager-mobile-card">
                  <div className="custom-reminder-manager-heading">
                    <Typography.Text strong>{item.name}</Typography.Text>
                    <Space size={4} wrap>
                      {businessTypeTag(item.businessType)}
                      <Tag color={item.enabled ? 'green' : undefined}>{item.enabled ? '启用' : '停用'}</Tag>
                    </Space>
                  </div>
                  <div className="custom-reminder-manager-meta">{scheduleLabel(item)}</div>
                  {item.businessType === 'fixed_bill' && item.fixedAmount != null && (
                    <Typography.Text type="danger" className="amount-strong">
                      {formatMoney(item.fixedAmount, 'CNY')}
                    </Typography.Text>
                  )}
                  {item.note && <div className="custom-reminder-manager-note">{item.note}</div>}
                  {!confirming ? (
                    <div className="custom-reminder-manager-actions">
                      <Button onClick={() => onEdit(item)}>编辑</Button>
                      <Button danger onClick={() => onDeleteStart(item)}>删除</Button>
                    </div>
                  ) : (
                    <InlineConfirm
                      title="删除该提醒？"
                      description={`将永久删除“${item.name}”。`}
                      confirmText="删除提醒"
                      loading={deleting}
                      onConfirm={onDeleteConfirm}
                      onCancel={onDeleteCancel}
                    />
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </MobileFlow>
    );
  }

  return (
    <Modal
      className="custom-reminder-manager-modal"
      title="提醒设置"
      open
      width="min(1080px, calc(100vw - 48px))"
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>关闭</Button>,
        <Button key="create" type="primary" icon={<PlusOutlined />} onClick={onCreate}>新增提醒</Button>,
      ]}
    >
      <Table<CustomReminder>
        rowKey="id"
        dataSource={items}
        pagination={items.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
        size="middle"
        locale={{ emptyText: <Empty description="暂无提醒设置" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '类型',
            dataIndex: 'businessType',
            width: 110,
            render: (value: CustomReminderBusinessType) => businessTypeTag(value),
          },
          {
            title: '周期',
            key: 'schedule',
            width: 190,
            render: (_, reminder) => scheduleLabel(reminder),
          },
          {
            title: '金额',
            key: 'amount',
            width: 120,
            render: (_, reminder) => reminder.businessType === 'fixed_bill'
              ? formatMoney(reminder.fixedAmount ?? 0, 'CNY')
              : reminder.businessType === 'dynamic_bill' ? '每期填写' : '-',
          },
          {
            title: '提前提醒',
            dataIndex: 'daysBefore',
            width: 150,
            render: (value: number[]) => value.length === 0
              ? '不提前'
              : value.map((day) => (day === 0 ? '当天' : `${day} 天前`)).join('、'),
          },
          {
            title: '状态',
            dataIndex: 'enabled',
            width: 80,
            render: (value: boolean) => <Tag color={value ? 'green' : undefined}>{value ? '启用' : '停用'}</Tag>,
          },
          {
            title: '操作',
            width: 128,
            render: (_, reminder) => (
              <Space size="small">
                <Button size="small" onClick={() => onEdit(reminder)}>编辑</Button>
                <Popconfirm title="确定删除该提醒？" onConfirm={() => onDelete(reminder)}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Modal>
  );
}

export default function Reminders() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  const { blocked, blockedReason, mayRunRestrictedAction } = useHistoryGate();
  const [customs, setCustoms] = useState<CustomReminder[]>([]);
  const [today, setToday] = useState<ReminderEvent[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [editing, setEditing] = useState<CustomReminder | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [markTarget, setMarkTarget] = useState<MarkPaidTarget | null>(null);
  const [managingCustoms, setManagingCustoms] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomReminder | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [runResult, setRunResult] = useState<ReminderRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const runningRef = useRef(false);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [c, t, d, u] = await Promise.all([
        api.get<CustomReminder[]>('/api/reminders/custom'),
        api.get<{ items: ReminderEvent[] }>('/api/reminders/today'),
        api.get<{ items: TodoItem[] }>('/api/reminders/todos'),
        api.get<{ items: UpcomingItem[] }>('/api/reminders/upcoming?days=30'),
      ]);
      if (generation !== loadGeneration.current) return;
      setCustoms(c);
      setToday(t.items);
      setTodos(d.items);
      setUpcoming(u.items);
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      setLoadError(err instanceof ApiError ? err.message : '提醒数据加载失败');
      throw err;
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  const refresh = useCoalescedRefresh(load);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(
    () => () => {
      loadGeneration.current += 1;
    },
    [],
  );

  useResetOnModeChange(() => {
    setDeleteTarget(null);
    setManagingCustoms(false);
  });

  const submit = async (values: CustomReminderInput) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/api/reminders/custom/${editing.id}`, values);
        message.success('已保存');
      } else {
        await api.post('/api/reminders/custom', values);
        message.success('已创建');
      }
      setEditing(undefined);
      await load().catch(() => undefined);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const completeOccurrence = async (occurrenceId: number) => {
    try {
      await api.post(`/api/reminders/occurrences/${occurrenceId}/complete`);
      message.success('已完成');
      await load().catch(() => undefined);
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '操作失败');
    }
  };

  const markCustomBill = (input: {
    occurrenceId: number;
    businessType: 'fixed_bill' | 'dynamic_bill';
    name: string;
    amount?: number | null;
    paidStatus?: string | null;
  }) => {
    setMarkTarget({
      targetType: 'custom',
      occurrenceId: input.occurrenceId,
      businessType: input.businessType,
      name: input.name,
      cardId: 0,
      bankName: input.name,
      cardLast4: '',
      period: '',
      currency: 'CNY',
      amount: input.amount ?? null,
      paidStatus: input.paidStatus ?? 'unpaid',
    });
  };

  const remove = async (id: number) => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await api.delete(`/api/reminders/custom/${id}`);
      message.success('已删除');
      setDeleteTarget(null);
      await load().catch(() => undefined);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const runNow = async () => {
    if (runningRef.current) return;
    if (!mayRunRestrictedAction()) {
      message.warning(blockedReason);
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setRunResult(null);
    setRunError(null);
    try {
      const r = await api.post<{ pushed: number; skipped: number; failed: number }>('/api/jobs/reminders/run');
      setRunResult(r);
      if (r.failed > 0) message.warning(`推送失败 ${r.failed} 条，请检查已启用的通知渠道配置`);
      else if (r.pushed > 0) message.success(`已推送 ${r.pushed} 条提醒`);
      else message.info('今日已推送过或无待提醒事项');
      await load().catch(() => undefined);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : '执行失败';
      setRunError(text);
      message.error(text);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  // 还款提醒：统一弹窗标记（有账单三选一 / 缺账单补录三选一）
  const markPaid = (item: ReminderEvent) => {
    if (item.type === 'custom' && item.occurrenceId && item.businessType === 'general') {
      void completeOccurrence(item.occurrenceId);
      return;
    }
    if (item.type === 'custom' && item.occurrenceId && item.businessType && item.businessType !== 'general') {
      markCustomBill({
        occurrenceId: item.occurrenceId,
        businessType: item.businessType,
        name: item.title,
        amount: item.amount,
        paidStatus: item.paidStatus,
      });
      return;
    }
    if (item.cardId == null) {
      message.error('该提醒缺少卡片信息，暂时无法标记还款');
      return;
    }
    setMarkTarget({
      cardId: item.cardId,
      bankName: item.bankName ?? '',
      cardLast4: item.cardLast4 ?? '',
      period: item.period ?? '',
      currency: item.currency ?? 'CNY',
      billId: item.billId ?? undefined,
      amount: item.amount ?? null,
      minAmount: item.minAmount ?? null,
      paidStatus: item.paidStatus ?? null,
      paidAmount: item.paidAmount ?? null,
    });
  };

  // 逾期未还账单：统一弹窗标记
  const markPaidTodo = (item: TodoItem) => {
    if (item.recordType === 'custom' && item.occurrenceId) {
      if (item.action === 'complete') {
        void completeOccurrence(item.occurrenceId);
      } else if (item.businessType && item.businessType !== 'general') {
        markCustomBill({
          occurrenceId: item.occurrenceId,
          businessType: item.businessType,
          name: item.name ?? '',
          amount: item.amount,
          paidStatus: item.paidStatus,
        });
      }
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

  const overdueTodos = todos.filter((t) => t.daysOverdue != null);

  return (
    <>
      {!(isMobile && (editing !== undefined || markTarget != null || managingCustoms)) && (
        <Page
          title="提醒中心"
          extra={
            <Space>
              <Button
                icon={<ThunderboltOutlined />}
                onClick={() => void runNow()}
                loading={running}
                disabled={blocked}
                title={blocked ? blockedReason : undefined}
              >
                立即推送今日提醒
              </Button>
              <Button
                icon={<ReloadOutlined />}
                onClick={() => void refresh().catch(() => undefined)}
                loading={loading}
                disabled={running || deleting || saving}
              >
                刷新
              </Button>
              <Button icon={<SettingOutlined />} onClick={() => setManagingCustoms(true)}>
                提醒设置
              </Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(null)}>
                新增提醒
              </Button>
            </Space>
          }
        >
          {isMobile ? (
            <MobileRemindersView
              today={today}
              overdueTodos={overdueTodos}
              upcoming={upcoming}
              loading={loading}
              loadError={loadError}
              running={running}
              runResult={runResult}
              runError={runError}
              blocked={blocked}
              blockedReason={blockedReason}
              onRunNow={() => void runNow()}
              onCreate={() => setEditing(null)}
              onManage={() => setManagingCustoms(true)}
              onMarkToday={markPaid}
              onMarkTodo={markPaidTodo}
              onUpcoming={(item) => {
                if (item.cardId) {
                  navigate(`/bills?cardId=${item.cardId}`);
                } else if (item.customOccurrenceId && item.customAction === 'complete') {
                  void completeOccurrence(item.customOccurrenceId);
                } else if (item.customOccurrenceId && item.customBusinessType && item.customBusinessType !== 'general') {
                  markCustomBill({
                    occurrenceId: item.customOccurrenceId,
                    businessType: item.customBusinessType,
                    name: item.title,
                    amount: item.amount,
                    paidStatus: item.paidStatus,
                  });
                }
              }}
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
          description="立即推送需等待历史拉取结束；提醒查看、编辑和还款仍可继续。"
          action={<Button onClick={() => navigate('/email', { state: { showHistoryProgress: true } })}>查看进度</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      {runResult && (
        <Alert
          type={runResult.failed > 0 ? 'warning' : 'success'}
          showIcon
          title="本次推送结果"
          description={`已推送 ${runResult.pushed} 条，已跳过 ${runResult.skipped} 条，失败 ${runResult.failed} 条。${
            runResult.failed > 0 ? ' 请检查已启用的通知渠道配置。' : ''
          }`}
          style={{ marginBottom: 16 }}
        />
      )}
      {runError && (
        <Alert
          type="error"
          showIcon
          title="立即推送失败"
          description={runError}
          style={{ marginBottom: 16 }}
        />
      )}
      {loadError && (
        <Alert
          type="error"
          showIcon
          title="提醒数据刷新失败"
          description={loadError}
          action={<Button onClick={() => void refresh().catch(() => undefined)}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      <div className={`desktop-reminder-overview-grid${overdueTodos.length === 0 ? ' desktop-reminder-overview-grid-single' : ''}`}>
      {overdueTodos.length > 0 && (
        <Card title={`逾期未处理 · ${overdueTodos.length}`} size="small" className="desktop-reminder-overview-card" variant="outlined">
          <PaginatedReminderList
            items={overdueTodos}
            itemKey={(t) => t.recordType === 'custom' ? `custom-${t.occurrenceId}` : `${t.cardId}-${t.period}`}
            renderItem={(t) => (
              <div className="desktop-reminder-row">
                <BellOutlined className="desktop-reminder-icon desktop-reminder-icon-danger" />
                <div className="desktop-reminder-content">
                  <div className="desktop-reminder-title">
                    <span>
                      {t.recordType === 'custom'
                        ? t.name
                        : `${t.bankName}（${(t.cardTails?.length ?? 0) > 1 ? `${t.cardTails?.[0]} 等${t.cardTails?.length}张卡` : t.cardTails?.[0]}）${t.period}期`}
                      {' '}<Tag color="red">{overdueText(t.daysOverdue!)}</Tag>
                    </span>
                  </div>
                  <div className="desktop-reminder-description">
                    <span>
                      {t.recordType === 'custom' && t.businessType === 'general'
                        ? (t.note || '')
                        : t.amount != null ? (
                        <Typography.Text type="danger" className="amount-strong">
                          {formatMoney(t.amount, t.currency ?? 'CNY')}
                        </Typography.Text>
                      ) : (
                        t.recordType === 'custom' ? '金额待填写' : '账单金额未取得'
                      )}
                      <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                        {t.action === 'complete' ? '日期' : '还款日'} {dayjs(t.dueDate).format('YYYY-MM-DD')}
                      </Typography.Text>
                    </span>
                  </div>
                </div>
                {t.paidStatus !== 'paid' && (
                  <Button size="small" type="primary" ghost onClick={() => markPaidTodo(t)}>
                    {t.action === 'complete' ? '完成' : t.action === 'custom_payment' ? '还款' : '标记已还'}
                  </Button>
                )}
              </div>
            )}
          />
        </Card>
      )}

      <Card title={`今日应提醒 · ${today.length}`} size="small" className="desktop-reminder-overview-card" variant="outlined">
        {today.length === 0 ? (
          <Empty description="今日暂无提醒事项" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <PaginatedReminderList
            items={today}
            itemKey={(t) => `${t.type}-${t.refId ?? t.cardId ?? 'none'}-${t.fireDate}-${t.title}`}
            renderItem={(t) => (
              <div className="desktop-reminder-row">
                <BellOutlined className="desktop-reminder-icon desktop-reminder-icon-warning" />
                <div className="desktop-reminder-content">
                  <div className="desktop-reminder-title">{t.title}</div>
                  <div className="desktop-reminder-description">{t.body}</div>
                </div>
                {t.type === 'card_due' && t.paidStatus !== 'paid' && (
                  <Button size="small" type="primary" ghost onClick={() => markPaid(t)}>
                    标记已还
                  </Button>
                )}
                {t.type === 'custom' && t.occurrenceId && t.businessType === 'general' && (
                  <Button size="small" type="primary" ghost onClick={() => void completeOccurrence(t.occurrenceId!)}>
                    完成
                  </Button>
                )}
                {t.type === 'custom' && t.occurrenceId && t.businessType !== 'general' && (
                  <Button size="small" type="primary" ghost onClick={() => markPaid(t)}>
                    还款
                  </Button>
                )}
              </div>
            )}
          />
        )}
      </Card>
      </div>

      <Card title={`未来 30 天日历视图 · ${upcoming.length}`} size="small" className="desktop-reminder-upcoming-card" variant="outlined">
        <Table<UpcomingItem>
          rowKey="sourceKey"
          dataSource={upcoming}
          pagination={upcoming.length > 12 ? { pageSize: 12, showSizeChanger: false } : false}
          size="small"
          locale={{ emptyText: <Empty description="30 天内暂无事项" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          columns={[
            {
              title: '日期',
              dataIndex: 'date',
              width: 120,
              render: (v) => (
                <span>
                  {dayjs(v).format('MM-DD ddd')}
                  <Tag style={{ marginLeft: 6 }}>{dayjs(v).diff(dayjs(), 'day')} 天后</Tag>
                </span>
              ),
            },
            {
              title: '类型',
              dataIndex: 'type',
              width: 90,
              render: (v, row) =>
                v === 'due' ? (
                  <Tag color="red">还款日</Tag>
                ) : v === 'statement' ? (
                  <Tag color="blue">出账日</Tag>
                ) : v === 'fee' ? (
                  <Tag color="gold">年费</Tag>
                ) : (
                  businessTypeTag(row.customBusinessType ?? 'general')
                ),
            },
            {
              title: '事项',
              key: 'title',
              render: (_, r) => (
                <span>
                  {r.title}
                  {r.linkedCount != null && r.linkedCount > 1 && (
                        <Tag style={{ marginLeft: 6 }}>{r.linkedCount} 张卡</Tag>
                  )}
                  {r.amount != null && (
                    <Typography.Text type="danger" className="amount-strong" style={{ marginLeft: 8 }}>
                      {formatMoney(r.amount, r.currency ?? 'CNY')}
                    </Typography.Text>
                  )}
                </span>
              ),
            },
            { title: '说明', dataIndex: 'detail', render: (v) => v || '-' },
            {
              title: '操作',
              key: 'action',
              width: 80,
              render: (_, row) => row.type === 'custom' && row.actionable && row.customOccurrenceId ? (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  onClick={(event) => {
                    event.stopPropagation();
                    if (row.customAction === 'complete') {
                      void completeOccurrence(row.customOccurrenceId!);
                    } else if (row.customBusinessType && row.customBusinessType !== 'general') {
                      markCustomBill({
                        occurrenceId: row.customOccurrenceId!,
                        businessType: row.customBusinessType,
                        name: row.title,
                        amount: row.amount,
                        paidStatus: row.paidStatus,
                      });
                    }
                  }}
                >
                  {row.customAction === 'complete' ? '完成' : '还款'}
                </Button>
              ) : null,
            },
          ]}
          onRow={(r) => ({
            // 点击卡片相关事项 → 账单记录按该卡筛选
            onClick: () => r.cardId && navigate(`/bills?cardId=${r.cardId}`),
            style: { cursor: r.cardId ? 'pointer' : 'default' },
          })}
        />
      </Card>

            </>
          )}
        </Page>
      )}

      <CustomReminderManager
        open={managingCustoms}
        items={customs}
        deleteTarget={deleteTarget}
        deleting={deleting}
        onClose={() => {
          setDeleteTarget(null);
          setManagingCustoms(false);
        }}
        onCreate={() => {
          setManagingCustoms(false);
          setEditing(null);
        }}
        onEdit={(item) => {
          setManagingCustoms(false);
          setEditing(item);
        }}
        onDelete={(item) => void remove(item.id)}
        onDeleteStart={setDeleteTarget}
        onDeleteCancel={() => setDeleteTarget(null)}
        onDeleteConfirm={() => {
          if (deleteTarget) void remove(deleteTarget.id);
        }}
      />

      {editing !== undefined && (
        <CustomForm
          initial={editing}
          onOk={(values) => void submit(values)}
          onCancel={() => setEditing(undefined)}
          confirmLoading={saving}
        />
      )}

      <MarkPaidModal
        target={markTarget}
        onClose={() => setMarkTarget(null)}
        onDone={() => void load().catch(() => undefined)}
      />
    </>
  );
}
