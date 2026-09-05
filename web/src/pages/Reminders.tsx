import { displayDate } from '../lib/displayDate';
import './reminders/reminders.css';
import { useDraftGuard } from '../lib/draftGuard';
import { useEffect, useState } from 'react';
import {
  Segmented,
  Button,
  Card,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, CalendarOutlined } from '../skins/icons';
import SettingSwitch from '../components/SettingSwitch';
import dayjs, { type Dayjs } from 'dayjs';
import { api } from '../api/client';
import type {
  CustomReminder,
  CustomReminderBusinessType,
  CustomReminderInput,
  CustomReminderScheduleType,
} from '../api/types';
import { formatMoney } from '../lib/money';
import { InlineConfirm, MobileFlow } from '../components/MobilePrimitives';
import { useResetOnModeChange, useResponsive } from '../responsive';

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

export function CustomForm({
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
  useDraftGuard(Boolean(dirty));
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
    if (dirty) {
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
              <strong>{displayDate(date)}</strong>
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
              <SettingSwitch aria-label="启用提醒" />
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
      {confirmLeave && <InlineConfirm title="放弃未保存的修改？" description="退出后本次修改不会保存。" confirmText="放弃修改" onConfirm={onCancel} onCancel={() => setConfirmLeave(false)} />}
      {formContent}
    </Modal>
  );
}

export function CustomReminderManager({
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
