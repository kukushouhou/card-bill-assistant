import { displayDate } from '../lib/displayDate';
import { useDraftGuard } from '../lib/draftGuard';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  SortAscendingOutlined,
  StarOutlined,
  WarningOutlined,
} from '../skins/icons';
import { Popup, SearchBar } from 'antd-mobile';
import dayjs from 'dayjs';
import { useLocation, useNavigate } from 'react-router';
import { formatMoney } from '../lib/money';
import {
  businessCoverOf,
  businessPrimaryFirst,
  businessRelationshipPrimaryOf,
  cardGroupTitle,
  shouldShowBusinessRole,
} from '../lib/business-cards';
import { Virtuoso } from 'react-virtuoso';
import { api, ApiError } from '../api/client';
import type { CardInput, CardRow } from '../api/types';
import { Page } from '../components/Layout';
import BusinessRoleRibbon from '../components/BusinessRoleRibbon';
import MarkAbnormalModal, { type MarkAbnormalTarget } from '../components/MarkAbnormalModal';
import MarkPaidModal, { type MarkPaidTarget } from '../components/MarkPaidModal';
import {
  InlineConfirm,
  MobileFlow,
  MobilePullToRefresh,
  useCoalescedRefresh,
} from '../components/MobilePrimitives';
import { useResetOnModeChange, useResponsive, type ResponsiveMode } from '../responsive';
import MobileCardDetail from './cards/MobileCardDetail';
import CardBillSection from '../components/CardBillSection';
import { useSourceSnapshot } from '../lib/billNavigation';
import { useViewState } from '../lib/viewState';
import './cards/cards.css';

/** 卡敏感信息明文（PIN 验证后临时持有，仅存前端内存，弹窗关闭/收起即清除） */
interface SecretValues {
  cardNoFull: string | null;
  expDate: string | null;
  cvv: string | null;
}

interface SecretFormValues {
  cardNoFull?: string;
  expDate?: string;
  cvv?: string;
}

/** 完整卡号校验：13-19 位数字串且通过 Luhn 算法（非全数字直接判失败） */
function isValidCardNumber(value: string): boolean {
  if (!/^\d{13,19}$/.test(value)) return false;
  let sum = 0;
  let double = false;
  for (let i = value.length - 1; i >= 0; i--) {
    let digit = value.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** 卡片相关弹窗统一宽度：宽屏左右两栏，窄屏自动单栏 */
const WIDE_MODAL_WIDTH = 'min(760px, 94vw)';

const DELETE_CARD_DESCRIPTION =
  '删除后，此卡档案将永久移除。以此卡作为归属卡保存的账单会一并删除；若其中有合并账单，其他关联卡也会失去这些账单。仅与此卡关联、但归属其他卡的合并账单会保留，只移除这张卡的关联。此操作不可恢复。';

function deleteCardDescription(card: CardRow): string {
  if (card.businessRole === 'primary') {
    return '删除主卡后，该组主卡、副卡、附属卡的卡片档案和账单将一并删除。此操作不可恢复。';
  }
  if (card.businessRole === 'secondary' || card.businessRole === 'supplementary') {
    return '删除后，系统只移除这张卡的档案和关联，主卡账单会继续保留。此操作不可恢复。';
  }
  return DELETE_CARD_DESCRIPTION;
}

interface CardFormValues {
  bankName: string;
  cardLast4: string;
  holderName?: string;
  nickname?: string;
  statementDay: number;
  dueRule: 'fixed' | 'offset';
  dueDay?: number | null;
  dueOffsetDays?: number | null;
  remindDaysBefore: number[];
  annualFeeDate?: dayjs.Dayjs | null;
}

interface CardFormDraft {
  values: CardFormValues;
  dirty: boolean;
}

function cardFormInitialValues(initial?: CardRow | null): Partial<CardFormValues> {
  if (!initial) return { dueRule: 'offset', remindDaysBefore: [3, 1, 0] };
  return {
    bankName: initial.bankName,
    cardLast4: initial.displayLast4,
    holderName: initial.holderName ?? undefined,
    nickname: initial.nickname ?? undefined,
    statementDay: initial.statementDay,
    dueRule: initial.dueRule,
    dueDay: initial.dueDay,
    dueOffsetDays: initial.dueOffsetDays,
    remindDaysBefore: initial.remindDaysBefore,
    annualFeeDate: initial.annualFeeDate ? dayjs(initial.annualFeeDate) : null,
  };
}

function definedCardDraft(values?: Partial<CardFormValues>): Partial<CardFormValues> {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<CardFormValues>;
}

function normalizedCardFormValues(values: Partial<CardFormValues>) {
  return {
    bankName: values.bankName ?? '',
    cardLast4: values.cardLast4 ?? '',
    holderName: values.holderName ?? '',
    nickname: values.nickname ?? '',
    statementDay: values.statementDay ?? null,
    dueRule: values.dueRule ?? null,
    dueDay: values.dueRule === 'fixed' ? values.dueDay ?? null : null,
    dueOffsetDays: values.dueRule === 'offset' ? values.dueOffsetDays ?? null : null,
    remindDaysBefore: [...(values.remindDaysBefore ?? [])].sort((a, b) => a - b),
    annualFeeDate: values.annualFeeDate ? values.annualFeeDate.format('YYYY-MM-DD') : null,
  };
}

function cardFormChanged(values: Partial<CardFormValues>, baseline: Partial<CardFormValues>): boolean {
  return JSON.stringify(normalizedCardFormValues(values)) !== JSON.stringify(normalizedCardFormValues(baseline));
}

function CardForm({
  initial,
  restoreDraft,
  onDraftChange,
  onOk,
  onCancel,
  confirmLoading,
}: {
  initial?: CardRow | null;
  restoreDraft: CardFormDraft | null;
  onDraftChange: (draft: CardFormDraft) => void;
  onOk: (values: Partial<CardInput>) => void;
  onCancel: () => void;
  confirmLoading: boolean;
}) {
  const { isMobile } = useResponsive();
  const [form] = Form.useForm<CardFormValues>();
  const baseline = useRef(cardFormInitialValues(initial)).current;
  const formInitialValues = useRef({
    ...baseline,
    ...definedCardDraft(restoreDraft?.values),
  }).current;
  const dueRule = Form.useWatch('dueRule', form) ?? formInitialValues.dueRule;
  const billingEditable = initial?.billingEditable ?? true;
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  useDraftGuard(Boolean(restoreDraft?.dirty));

  useResetOnModeChange(() => setLeaveConfirm(false));

  const title = initial ? `编辑卡片 - ${initial.bankName}（${initial.displayLast4}）` : '新增卡片';
  const requestClose = () => {
    if (confirmLoading) return;
    if (restoreDraft?.dirty) {
      setLeaveConfirm(true);
      return;
    }
    onCancel();
  };

  const formContent = (
    <Form
      form={form}
      layout="vertical"
      initialValues={formInitialValues}
      onValuesChange={(_, values) =>
        onDraftChange({ values, dirty: cardFormChanged(values, baseline) })
      }
      onFinish={(v) => {
        const annualFeeDate = v.annualFeeDate ? v.annualFeeDate.format('YYYY-MM-DD') : null;
        if (initial && !billingEditable) {
          onOk({
            ...(initial.businessRole === 'supplementary' ? { holderName: v.holderName } : {}),
            nickname: v.nickname,
            annualFeeDate,
          });
          return;
        }
        onOk({
          ...v,
          ...(initial ? { cardLast4: undefined } : {}),
          dueDay: v.dueRule === 'fixed' ? v.dueDay ?? null : null,
          dueOffsetDays: v.dueRule === 'offset' ? v.dueOffsetDays ?? null : null,
          annualFeeDate,
        });
      }}
    >
      <Row gutter={[24, 20]} className="cards-edit-sections">
        {/* 左栏：基础信息 */}
        <Col xs={24} lg={isMobile ? 24 : 12}>
          <h3 className="cards-edit-section-title">基础信息</h3>
          <Form.Item name="bankName" label="银行名称" rules={[{ required: true, message: '请输入银行名称' }]}>
            <Input placeholder="如：招商银行" disabled={!!initial && !billingEditable} />
          </Form.Item>
          <Form.Item
            name="cardLast4"
            label="卡号后 4 位"
            rules={
              initial
                ? []
                : [
                    { required: true, message: '请输入卡号后 4 位' },
                    { pattern: /^\d{4}$/, message: '必须为 4 位数字' },
                  ]
            }
          >
            <Input placeholder="1234" maxLength={4} disabled={!!initial} inputMode="numeric" />
          </Form.Item>
          <Form.Item name="holderName" label="持卡人（可选）">
            <Input placeholder="姓名" disabled={initial?.businessRole === 'secondary'} />
          </Form.Item>
          <Form.Item name="nickname" label="别名（可选）" tooltip="卡片右上角显示的辨识名，如：银联钻石卡">
            <Input placeholder="如：银联钻石卡" maxLength={32} />
          </Form.Item>
        </Col>
        {/* 右栏：账单规则；副卡、附属卡仅保留身份与年费日 */}
        <Col xs={24} lg={isMobile ? 24 : 12}>
          <h3 className="cards-edit-section-title">账单与提醒</h3>
          {!billingEditable && initial ? (
            <>
              <Form.Item label="卡片身份">
                <Input
                  readOnly
                  value={initial.businessRole === 'secondary' ? '副卡' : '附属卡'}
                />
              </Form.Item>
              <Form.Item label="归属主卡">
                <Input readOnly value={`尾号 ${initial.businessPrimaryCardLast4 ?? '----'}`} />
              </Form.Item>
              <Form.Item
                name="annualFeeDate"
                label="年费收取日（可选）"
                tooltip="每年该日期收取年费，也可由历史账单自动识别"
              >
                <DatePicker style={{ width: '100%' }} placeholder="如 03-15" />
              </Form.Item>
            </>
          ) : (
          <>
          <Form.Item
            name="statementDay"
            label="每月出账日（几号）"
            rules={[{ required: true, message: '请输入出账日' }]}
          >
            <InputNumber
              min={1}
              max={31}
              style={{ width: '100%' }}
              placeholder="1-31，如 31 在小月自动取月末"
            />
          </Form.Item>
          <Form.Item name="dueRule" label="还款日规则" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'offset', label: '出账日 + N 天' },
                { value: 'fixed', label: '每月固定日期' },
              ]}
            />
          </Form.Item>
          {dueRule === 'offset' ? (
            <Form.Item
              name="dueOffsetDays"
              label="还款日距出账日天数"
              rules={[{ required: true, message: '请输入天数' }]}
            >
              <InputNumber min={0} max={40} style={{ width: '100%' }} placeholder="常见 18-25 天" />
            </Form.Item>
          ) : (
            <Form.Item name="dueDay" label="每月还款日（几号）" rules={[{ required: true, message: '请输入还款日' }]}>
              <InputNumber min={1} max={31} style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Form.Item name="remindDaysBefore" label="提前提醒（还款日前 N 天）">
            <Select
              mode="multiple"
              options={[5, 3, 2, 1, 0].map((n) => ({ value: n, label: n === 0 ? '当天' : `${n} 天前` }))}
            />
          </Form.Item>
          <Form.Item
            name="annualFeeDate"
            label="年费收取日（可选）"
            tooltip="每年该日期收取年费，将在年费出账前一期的还款日提醒；也可由历史账单自动识别"
          >
            <DatePicker style={{ width: '100%' }} placeholder="如 03-15" />
          </Form.Item>
          </>
          )}
        </Col>
      </Row>
    </Form>
  );

  if (isMobile) {
    const footer = leaveConfirm ? undefined : (
      <div className="mobile-flow-action-row">
        <Button block disabled={confirmLoading} onClick={requestClose}>
          取消
        </Button>
        <Button type="primary" block loading={confirmLoading} onClick={() => form.submit()}>
          保存
        </Button>
      </div>
    );
    return (
      <MobileFlow title={initial ? '编辑卡片' : '新增卡片'} onBack={requestClose} footer={footer}>
        <Card size="small" title={title} className="cards-mobile-flow-card">
          {formContent}
        </Card>
        {leaveConfirm && (
          <InlineConfirm
            title="放弃未保存的更改？"
            description="返回后，本次填写的卡片信息不会保存。"
            confirmText="放弃更改"
            danger={false}
            onCancel={() => setLeaveConfirm(false)}
            onConfirm={onCancel}
          />
        )}
      </MobileFlow>
    );
  }

  return (
    <Modal
      title={title}
      open
      onOk={() => form.submit()}
      onCancel={requestClose}
      confirmLoading={confirmLoading}
      destroyOnHidden
      width={WIDE_MODAL_WIDTH}
    >
      {leaveConfirm && <InlineConfirm title="放弃未保存的修改？" description="退出后本次修改不会保存。" confirmText="放弃修改" onConfirm={onCancel} onCancel={() => setLeaveConfirm(false)} />}
      {formContent}
    </Modal>
  );
}

/** 独立 PIN 验证框：录入前验证走 /auth/pin/verify；卡片展开验证直接调 /secret/view 一步完成 */
function PinVerifyModal({
  mode,
  card,
  onOk,
  onClose,
}: {
  mode: 'reveal' | 'enter';
  card: CardRow;
  onOk: (pin: string, secrets?: SecretValues) => void;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const requestGen = useRef(0);
  const loadingRef = useRef(false);

  useEffect(
    () => () => {
      requestGen.current += 1;
    },
    [],
  );

  const close = () => {
    requestGen.current += 1;
    loadingRef.current = false;
    setPin('');
    onClose();
  };

  const submit = async () => {
    if (loadingRef.current) return;
    if (!/^\d{6}$/.test(pin)) {
      message.warning('请输入 6 位 PIN');
      return;
    }
    const gen = ++requestGen.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      if (mode === 'reveal') {
        // 验证 + 解密一步完成
        const secrets = await api.post<SecretValues>(`/api/cards/${card.id}/secret/view`, { pin });
        if (gen !== requestGen.current) return;
        onOk(pin, secrets);
      } else {
        await api.post('/api/auth/pin/verify', { pin });
        if (gen !== requestGen.current) return;
        onOk(pin);
      }
    } catch (err) {
      if (gen !== requestGen.current) return;
      message.error(err instanceof ApiError ? err.message : 'PIN 校验失败');
    } finally {
      if (gen === requestGen.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };

  const content = (
    <>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        {mode === 'reveal'
          ? `验证 PIN 后在 ${card.bankName}（${card.displayLast4}）卡片上展开完整卡信息`
          : `验证 PIN 后进入 ${card.bankName}（${card.displayLast4}）的卡信息管理`}
      </Typography.Paragraph>
      <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="6 位数字 PIN"
          value={pin}
          autoFocus
          inputMode="numeric"
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onPressEnter={submit}
          maxLength={6}
        />
        {!isMobile && (
          <Button type="primary" onClick={submit} loading={loading}>
            验证
          </Button>
        )}
      </Space.Compact>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        连续 5 次失败将锁定 15 分钟；{isMobile ? '流程退出' : '弹窗关闭'}即清除。
      </Typography.Text>
    </>
  );

  if (isMobile) {
    return (
      <MobileFlow
        title="PIN 验证"
        onBack={close}
        footer={
          <div className="mobile-flow-action-row">
            <Button block disabled={loading} onClick={close}>
              取消
            </Button>
            <Button type="primary" block loading={loading} onClick={submit}>
              验证
            </Button>
          </div>
        }
      >
        <Card size="small" className="cards-mobile-flow-card">
          {content}
        </Card>
      </MobileFlow>
    );
  }

  return (
    <Modal title="PIN 验证" open onCancel={close} footer={null} destroyOnHidden width={380}>
      {content}
    </Modal>
  );
}

/** 卡信息管理弹窗（PIN 已前置验证）：左栏已存信息 + 安全说明，右栏录入/编辑表单 */
function SecretModal({
  card,
  pin: initialPin,
  onClose,
  onSave,
}: {
  card: CardRow;
  pin: string;
  onClose: (saved?: boolean) => void;
  onSave: (cardId: number, pin: string, values: SecretFormValues) => Promise<boolean>;
}) {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [secrets, setSecrets] = useState<SecretValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form] = Form.useForm();
  const requestGen = useRef(0);
  const savingRef = useRef(false);
  const pinRef = useRef(initialPin);

  useEffect(
    () => () => {
      requestGen.current += 1;
      savingRef.current = false;
      pinRef.current = '';
    },
    [],
  );

  // 已有信息：用已验证 PIN 即时解密（左栏展示 + 表单预填，避免误清空）
  useEffect(() => {
    if (!card.hasSecret) return;
    const gen = ++requestGen.current;
    setLoadError(null);
    api
      .post<SecretValues>(`/api/cards/${card.id}/secret/view`, { pin: pinRef.current })
      .then((data) => {
        if (gen !== requestGen.current) return;
        setSecrets(data);
        form.setFieldsValue({
          cardNoFull: data.cardNoFull ?? undefined,
          expDate: data.expDate ?? undefined,
          cvv: data.cvv ?? undefined,
        });
      })
      .catch((err) => {
        if (gen !== requestGen.current) return;
        const text = err instanceof ApiError ? err.message : '已存信息读取失败';
        setLoadError(text);
        message.warning(text);
      });
    return () => {
      if (requestGen.current === gen) requestGen.current += 1;
    };
  }, [card, form, message]);

  const closeAndClear = (saved?: boolean) => {
    requestGen.current += 1;
    savingRef.current = false;
    pinRef.current = '';
    onClose(saved);
  };

  const save = async (values: SecretFormValues) => {
    if (savingRef.current) return;
    const gen = ++requestGen.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await onSave(card.id, pinRef.current, values);
      if (!saved || gen !== requestGen.current) return;
      closeAndClear();
    } finally {
      if (gen === requestGen.current) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  const masked = (v: string | null | undefined) => (v == null ? '未录入' : v);
  const loadingView = card.hasSecret && !secrets && !loadError;
  const formDisabled = loadingView || loadError != null;
  const content = (
    <>
      {loadError && (
        <Alert
          type="error"
          showIcon
          title="已存信息读取失败"
          description={`${loadError}，请退出后重新验证 PIN。`}
          style={{ marginBottom: 16 }}
        />
      )}
      <Row gutter={24}>
        {/* 左栏：已存信息 + 安全说明 */}
        <Col xs={24} lg={11}>
          <Typography.Title level={5} style={{ fontSize: 14, marginTop: 0 }}>
            已存信息
          </Typography.Title>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="完整卡号">
              {loadingView ? '读取中…' : masked(secrets?.cardNoFull)}
            </Descriptions.Item>
            <Descriptions.Item label="有效期">
              {loadingView ? '读取中…' : masked(secrets?.expDate)}
            </Descriptions.Item>
            <Descriptions.Item label="CVV">{loadingView ? '读取中…' : masked(secrets?.cvv)}</Descriptions.Item>
          </Descriptions>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            卡号 / 有效期 / CVV 使用「环境密钥 + PIN」双密钥加密存储，PIN 不落库；忘记 PIN 将无法找回。
          </Typography.Paragraph>
        </Col>
        {/* 右栏：录入/编辑表单 */}
        <Col xs={24} lg={13}>
          <Typography.Title level={5} style={{ fontSize: 14, marginTop: 0 }}>
            {card.hasSecret ? '编辑（留空字段保存后清除）' : '录入'}
          </Typography.Title>
          <Form form={form} layout="vertical" onFinish={save}>
            <Form.Item
              name="cardNoFull"
              label="完整卡号"
              rules={[
                { pattern: /^\d{13,19}$/, message: '卡号格式错误' },
                {
                  validator: (_: unknown, value: string | undefined) =>
                    !value || isValidCardNumber(value)
                      ? Promise.resolve()
                      : Promise.reject(new Error('该卡号未通过卡号校验')),
                },
              ]}
            >
              <Input placeholder="13-19 位数字（可留空）" inputMode="numeric" />
            </Form.Item>
            <Form.Item name="expDate" label="有效期" rules={[{ pattern: /^(0[1-9]|1[0-2])\/?\d{2}$/, message: '格式 MM/YY' }]}>
              <Input placeholder="如 12/28" inputMode="numeric" />
            </Form.Item>
            <Form.Item name="cvv" label="CVV" rules={[{ pattern: /^\d{3,4}$/, message: '3-4 位数字' }]}>
              <Input.Password placeholder="卡背面 3 位" inputMode="numeric" />
            </Form.Item>
            {!isMobile && (
              <Button
                type="primary"
                htmlType="submit"
                loading={saving}
                disabled={formDisabled}
                icon={<LockOutlined />}
              >
                保存
              </Button>
            )}
          </Form>
        </Col>
      </Row>
    </>
  );

  if (isMobile) {
    return (
      <MobileFlow
        title="卡信息"
        onBack={() => closeAndClear()}
        footer={
          <div className="mobile-flow-action-row">
            <Button block disabled={saving} onClick={() => closeAndClear()}>
              取消
            </Button>
            <Button
              type="primary"
              block
              loading={saving}
              disabled={formDisabled}
              icon={<LockOutlined />}
              onClick={() => form.submit()}
            >
              保存
            </Button>
          </div>
        }
      >
        <Card
          size="small"
          title={`${card.bankName}（${card.displayLast4}）`}
          className="cards-mobile-flow-card"
        >
          {content}
        </Card>
      </MobileFlow>
    );
  }

  return (
    <Modal
      title={`卡信息 - ${card.bankName}（${card.displayLast4}）`}
      open
      onCancel={() => closeAndClear()}
      footer={null}
      destroyOnHidden
      width={WIDE_MODAL_WIDTH}
    >
      {content}
    </Modal>
  );
}

/** 套卡下一笔年费日：今年该月日已过则取下一年同一月日；未完善跳过 */
function nextFeeOfGroup(cards: CardRow[]): { label: string; lines: string[] } | null {
  const today = dayjs().startOf('day');
  const items: Array<{ line: string; next: dayjs.Dayjs }> = [];
  for (const c of cards) {
    if (!c.annualFeeDate) continue;
    const src = dayjs(c.annualFeeDate);
    let next = src.year(today.year()).startOf('day');
    if (next.isBefore(today, 'day')) next = next.add(1, 'year');
    items.push({
      line: `${c.bankName}（${c.displayLast4}）${src.format('M月D日')}`,
      next,
    });
  }
  if (items.length === 0) return null;
  items.sort((a, b) => a.next.valueOf() - b.next.valueOf() || a.line.localeCompare(b.line));
  return { label: displayDate(items[0]!.next.format('YYYY-MM-DD')), lines: items.map((i) => i.line) };
}

type SortKey = 'bank' | 'statement' | 'due' | 'fee';

const CARD_SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'bank', label: '银行名称排序' },
  { value: 'statement', label: '出账日排序' },
  { value: 'due', label: '还款日排序' },
  { value: 'fee', label: '年费日排序' },
];

/** 今天距下一个该月日的天数；今天即该日则为 0。缺日子返回 Infinity */
function daysToNextCycleDay(today: dayjs.Dayjs, day: number): number {
  if (day == null || !Number.isFinite(day)) return Infinity;
  const clamp = (base: dayjs.Dayjs) => base.date(Math.min(day, base.daysInMonth())).startOf('day');
  let next = clamp(today);
  if (next.isBefore(today, 'day')) {
    next = clamp(today.startOf('month').add(1, 'month'));
  }
  return next.diff(today, 'day');
}

/** 优先用本期还款日距今天数（可负，已过更靠前）；缺失再按固定还款日推算，否则 Infinity */
function daysToNextDueDate(
  today: dayjs.Dayjs,
  dueDate: string | null | undefined,
  dueRule: 'fixed' | 'offset',
  dueDay: number | null,
): number {
  if (dueDate) {
    const d = dayjs(dueDate).startOf('day');
    if (d.isValid()) return d.diff(today, 'day');
  }
  if (dueRule === 'fixed' && dueDay != null) return daysToNextCycleDay(today, dueDay);
  return Infinity;
}

/** 年费日循环：今年该月日已过则取下一年。缺失返回 Infinity */
function daysToNextAnnualFee(today: dayjs.Dayjs, annualFeeDate: string | null): number {
  if (!annualFeeDate) return Infinity;
  const src = dayjs(annualFeeDate);
  if (!src.isValid()) return Infinity;
  let next = src.year(today.year()).startOf('day');
  if (next.isBefore(today, 'day')) next = next.add(1, 'year');
  return next.diff(today, 'day');
}

/** 四字段不区分大小写子串匹配；空关键字不参与过滤 */
function matchCard(card: CardRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  const fields = [card.displayLast4, card.bankName, card.nickname, card.holderName];
  return fields.some((f) => (f ?? '').toLowerCase().includes(needle));
}

/** 单张银行卡卡片（套卡：优先显示卡带堆叠外阴影 + 角标，点击本体展开组弹窗） */
function BankCardItem({
  card,
  revealed,
  groupCards,
  onEye,
  onEdit,
  onSecret,
  onAbnormal,
  onMobileActions,
  onCardClick,
  allowSetPrimary,
  onRequestConfirm,
  primaryPending,
  secretPending,
  plain,
  showBilling = true,
  showBusinessRole = false,
}: {
  card: CardRow;
  /** PIN 验证后的明文（null=掩码态） */
  revealed: SecretValues | null;
  groupCards: CardRow[];
  onEye: () => void;
  onEdit: () => void;
  onSecret: () => void;
  /** 标记异常：冻结或注销 */
  onAbnormal: () => void;
  /** 手机端进入页内卡片操作面板；桌面端继续使用下拉菜单。 */
  onMobileActions: () => void;
  /** 点击卡片本体；手机端单卡/套卡均进入详情，桌面端仅套卡展开。 */
  onCardClick?: () => void;
  /** 设为优先展示入口是否可见，由组的当前一致性统一判定 */
  allowSetPrimary: boolean;
  /** 只请求确认：桌面打开确认层，手机进入页内确认态 */
  onRequestConfirm: (action: 'primary' | 'remove') => void;
  primaryPending?: boolean;
  /** 同一卡的卡信息写请求仍在途时禁用再次进入，锁由 Cards 页面持有。 */
  secretPending?: boolean;
  /** 组弹窗内渲染：无堆叠/角标/点击展开 */
  plain?: boolean;
  /** 业务副卡、附属卡不重复展示整组账单。 */
  showBilling?: boolean;
  /** 只在展开明确业务组后显示身份袖标；卡片中心永远为 false。 */
  showBusinessRole?: boolean;
}) {
  const groupSize = groupCards.length;
  const groupTails = groupCards.map((c) => c.displayLast4);
  const groupLabel = `${groupSize} 张卡`;
  const stacked = groupSize > 1 && !plain;
  const feeAgg = nextFeeOfGroup(stacked ? groupCards : [card]);
  const expanded = revealed != null;
  const fullNo = revealed?.cardNoFull ?? null;
  const cardNoText = fullNo ? fullNo.replace(/(\d{4})(?=\d)/g, '$1 ') : `**** **** **** ${card.displayLast4}`;
  const { isMobile } = useResponsive();
  const showCurrentCycle = card.status === 'active' || card.currentCycle.hasBill;

  /** 银行名前设置下拉：编辑 → 卡信息/录入卡信息 → 设为优先展示（仅普通套卡弹窗内非优先且正常使用） → 标记异常 → 删除 */
  const menuItems: MenuProps['items'] = [
    { key: 'edit', icon: <EditOutlined />, label: '编辑' },
    {
      key: 'secret',
      icon: card.hasSecret ? <EyeOutlined /> : <LockOutlined />,
      label: card.hasSecret ? '卡信息' : '录入卡信息',
      disabled: secretPending,
    },
    ...(allowSetPrimary
      ? [{ key: 'primary', icon: <StarOutlined />, label: '设为主卡', disabled: primaryPending }]
      : []),
    { key: 'abnormal', icon: <WarningOutlined />, label: '标记异常' },
    { key: 'remove', icon: <DeleteOutlined />, label: '删除', danger: true },
  ];

  const onMenuClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'edit') onEdit();
    else if (key === 'secret') onSecret();
    else if (key === 'primary') onRequestConfirm('primary');
    else if (key === 'abnormal') onAbnormal();
    else if (key === 'remove') onRequestConfirm('remove');
  };

  const settingsButton = (
    <button
      type="button"
      className="bank-card-settings"
      aria-label={`打开 ${card.bankName}（${card.displayLast4}）卡片设置`}
      onClick={(event) => {
        event.stopPropagation();
        if (isMobile) onMobileActions();
      }}
      style={{
        width: 44,
        minWidth: 44,
        height: 44,
        minHeight: 44,
        margin: -13,
        padding: 0,
        border: 0,
        background: 'transparent',
      }}
    >
      <SettingOutlined />
    </button>
  );

  const groupTrigger = stacked ? (
    <button
      type="button"
      className="bank-card-group-trigger"
      aria-label={`查看 ${card.bankName} ${groupLabel}`}
      onClick={(event) => {
        event.stopPropagation();
        onCardClick?.();
      }}
    >
      <Tag color="rgba(255,255,255,0.25)" style={{ color: '#fff', borderColor: 'transparent' }}>
        {groupSize} 卡
      </Tag>
    </button>
  ) : null;

  const annualFeeTag = feeAgg ? (
    <Tag color="rgba(255,255,255,0.25)" style={{ marginLeft: 6, color: '#fff', borderColor: 'transparent' }}>
      年费日 {feeAgg.label}
    </Tag>
  ) : null;

  const eyeButton = card.hasSecret ? (
    <button
      type="button"
      className="bank-card-eye"
      aria-label={
        expanded
          ? `收起 ${card.bankName}（${card.displayLast4}）完整卡信息`
          : `查看 ${card.bankName}（${card.displayLast4}）完整卡信息`
      }
      onClick={(event) => {
        event.stopPropagation();
        onEye();
      }}
      style={{
        width: 44,
        minWidth: 44,
        height: 44,
        minHeight: 44,
        margin: -11,
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'inherit',
      }}
    >
      {expanded ? <EyeInvisibleOutlined /> : <EyeOutlined />}
    </button>
  ) : null;

  return (
    <div className={stacked ? 'bank-card-stack-wrap' : undefined}>
      <div
        className={`bank-card bank-card-p${card.id % 5}${stacked ? ' bank-card-stack' : ''}${isMobile ? ' cards-mobile-bank-card' : ''}${showBusinessRole ? ' bank-card-with-role' : ''}`}
        onClick={onCardClick}
        onKeyDown={(event) => {
          if (!onCardClick || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          onCardClick();
        }}
        role={onCardClick ? 'button' : undefined}
        tabIndex={onCardClick ? 0 : undefined}
        aria-label={onCardClick ? `查看 ${card.bankName}（${card.displayLast4}）卡片详情` : undefined}
        style={onCardClick ? { cursor: 'pointer' } : undefined}
      >
        {showBusinessRole && <BusinessRoleRibbon role={card.businessRole} />}
        <div className="bank-card-head">
          <div>
            <span className="bank-card-title">
              {/* 桌面点设置打开下拉；手机进入页内操作面板，均拦住冒泡避免打开套卡。 */}
              <span className="bank-card-settings-wrap" onClick={(e) => e.stopPropagation()}>
                {isMobile ? (
                  settingsButton
                ) : (
                  <Dropdown
                    menu={{ items: menuItems, onClick: onMenuClick }}
                    trigger={['click']}
                    placement="bottomLeft"
                  >
                    {settingsButton}
                  </Dropdown>
                )}
              </span>
              <span className="bank-card-bank">{card.bankName}</span>
              {groupTrigger &&
                (isMobile ? (
                  groupTrigger
                ) : (
                  <Tooltip title={`${groupLabel}：${groupTails.join('、')}`}>
                    {groupTrigger}
                  </Tooltip>
                ))}
              {feeAgg &&
                (stacked && !isMobile ? (
                  <Tooltip
                    title={
                      <div>
                        {feeAgg.lines.map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                      </div>
                    }
                  >
                    {annualFeeTag}
                  </Tooltip>
                ) : (
                  annualFeeTag
                ))}
            </span>
          </div>
          {/* 右上角：别名 + 异常状态旗标 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {card.nickname && (
              <Typography.Text style={{ color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: 500 }}>
                {card.nickname}
              </Typography.Text>
            )}
            {card.status === 'frozen' && <Tag color="orange">已冻结</Tag>}
            {card.status === 'closed' && <Tag color="default">已注销</Tag>}
          </div>
        </div>

        <div>
          <div className="bank-card-no">
            <span className={fullNo ? 'bank-card-no-full' : undefined}>{cardNoText}</span>
            {/* 已录入卡信息才有眼睛图标：点击 → PIN 验证 → 原地展开/收起 */}
            {eyeButton &&
              (isMobile ? (
                eyeButton
              ) : (
                <Tooltip title={expanded ? '收起' : '验证 PIN 查看完整卡信息'}>
                  {eyeButton}
                </Tooltip>
              ))}
          </div>
            {/* 有效期/CVV 掩码行：所有卡统一展示（未录入显示占位掩码，保证高度一致），展开后显示明文。
                无前缀名称，仿实体卡排版：有效期左对齐、CVV 右对齐；持卡人在下方 */}
            <div className="bank-card-secret">
              <span className="bank-card-secret-value">{revealed?.expDate ?? '••/••'}</span>
              <span className="bank-card-secret-value">{revealed?.cvv ?? '•••'}</span>
            </div>
            {card.holderName && <div className="bank-card-holder">{card.holderName}</div>}
          </div>

        {showBilling && <div className="bank-card-foot">
          <div>
            <div className="bank-card-label">出账日 每月{card.statementDay}日</div>
            <div className="bank-card-value">
              {showCurrentCycle
                ? `下一还款 ${displayDate(card.currentCycle.dueDate)}`
                : card.status === 'frozen' ? '账期提醒已暂停' : '卡片已注销'}
            </div>
          </div>
          <div className="bank-card-amount">
            <div className="bank-card-label">{showCurrentCycle ? '本期应还' : '当前账单'}</div>
            {!showCurrentCycle ? (
              <div className="bank-card-value" style={{ fontWeight: 400, fontSize: 13, opacity: 0.85 }}>
                暂无待还账单
              </div>
            ) : card.currentCycle.unpaidBillCount > 1 ? (
              <div className="bank-card-value">{card.currentCycle.unpaidBillCount} 笔待还账单</div>
            ) : card.currentCycle.amount != null ? (
              <div className="bank-card-value">
                {formatMoney(card.currentCycle.amount, card.currentCycle.currency ?? card.currency)}
                {card.currentCycle.paidStatus === 'paid' && (
                  <span style={{ fontSize: 12, marginLeft: 4, opacity: 0.85 }}>已还清</span>
                )}
              </div>
            ) : card.currentCycle.billCount > 1 && card.currentCycle.unpaidBillCount === 0 ? (
              <div className="bank-card-value" style={{ fontWeight: 400, fontSize: 13, opacity: 0.85 }}>
                {card.currentCycle.billCount} 笔账单已还清
              </div>
            ) : card.currentCycle.hasBill || card.currentCycle.missing ? (
              <div className="bank-card-value" style={{ fontWeight: 400, fontSize: 13, opacity: 0.85 }}>
                未取得账单
              </div>
            ) : (
              <div className="bank-card-value" style={{ fontWeight: 400, fontSize: 13, opacity: 0.85 }}>
                —
              </div>
            )}
          </div>
        </div>}
      </div>
    </div>
  );
}

/** 套卡组：只看出账日与还款规则 */
interface CardGroup {
  key: string;
  cards: CardRow[];
  /** 优先显示卡：手动钉住 > priority 降序 > id 升序 */
  main: CardRow;
}

interface ViewItem {
  group: CardGroup;
  displayCard: CardRow;
}

/** 封面选卡：pinned > priority desc > id asc。日常封面与搜索顶替共用，不写回 isPrimary */
function pickCoverCard(candidates: CardRow[]): CardRow {
  const sorted = [...candidates].sort((a, b) => a.id - b.id);
  const pinned = sorted.find((c) => c.primaryManual && c.status === 'active');
  if (pinned) return pinned;
  let best = sorted[0]!;
  for (const c of sorted) {
    if ((c.priority ?? 0) > (best.priority ?? 0)) best = c;
  }
  return best;
}

/**
 * 持久 isPrimary 只用来判断入口是否已与当前普通代表一致，不参与选封面。
 * 零张/多张标记、非 active 标记或与普通代表不一致，都按缺失/陈旧处理。
 */
function currentConsistentPrimary(group: CardGroup): CardRow | null {
  if (group.cards.length <= 1) return null;
  const marked = group.cards.filter((card) => card.isPrimary);
  if (marked.length !== 1) return null;
  const current = marked[0]!;
  return current.status === 'active' && current.id === group.main.id ? current : null;
}

function canSetPrimary(group: CardGroup, card: CardRow): boolean {
  if (businessRelationshipPrimaryOf(group.cards)) return false;
  if (group.cards.length <= 1 || card.status !== 'active') return false;
  const current = currentConsistentPrimary(group);
  return current == null || current.id !== card.id;
}

interface MobileCardConfirm {
  action: 'primary' | 'remove';
  card: CardRow;
}

interface MobileCardActionTarget {
  cardId: number;
  groupKey: string;
  /** 仅普通套卡展开页里的非优先正常卡允许设为优先展示。 */
  allowSetPrimary: boolean;
}

type ResponsiveAbnormalTarget = MarkAbnormalTarget & { responsiveMode: ResponsiveMode };

type ResponsiveSecretTarget = {
  card: CardRow;
  pin: string;
  responsiveMode: ResponsiveMode;
  flowId: number;
};

type ResponsiveAbnormalFlowTarget = ResponsiveAbnormalTarget & { flowId: number };

function MobileCardSortSheet({
  open,
  value,
  onClose,
  onChange,
}: {
  open: boolean;
  value: SortKey;
  onClose: () => void;
  onChange: (value: SortKey) => void;
}) {
  return (
    <Popup
      visible={open}
      position="bottom"
      destroyOnClose
      showCloseButton
      closeOnMaskClick
      closeOnSwipe
      onClose={onClose}
      bodyClassName="cards-mobile-sort-sheet"
    >
      <section role="dialog" aria-modal="true" aria-labelledby="cards-mobile-sort-title">
        <div className="cards-mobile-sheet-handle" aria-hidden="true" />
        <Typography.Title id="cards-mobile-sort-title" level={4}>卡片排序</Typography.Title>
        <Radio.Group
          className="cards-mobile-sort-options"
          aria-label="卡片排序方式"
          value={value}
          onChange={(event) => {
            onChange(event.target.value as SortKey);
            onClose();
          }}
        >
          {CARD_SORT_OPTIONS.map((option) => (
            <Radio.Button key={option.value} value={option.value}>
              <span>{option.label}</span>
              {value === option.value && <CheckOutlined aria-hidden="true" />}
            </Radio.Button>
          ))}
        </Radio.Group>
      </section>
    </Popup>
  );
}

function MobileCardActionSheet({
  context,
  primaryPending,
  removePending,
  secretPending,
  onClose,
  onEdit,
  onSecret,
  onPrimary,
  onStatus,
  onRemove,
}: {
  context: { card: CardRow; allowSetPrimary: boolean } | null;
  primaryPending: boolean;
  removePending: boolean;
  secretPending: boolean;
  onClose: () => void;
  onEdit: () => void;
  onSecret: () => void;
  onPrimary: () => void;
  onStatus: () => void;
  onRemove: () => void;
}) {
  const card = context?.card ?? null;
  return (
    <Popup
      visible={context != null}
      position="bottom"
      destroyOnClose
      showCloseButton
      closeOnMaskClick
      closeOnSwipe
      onClose={onClose}
      bodyClassName="cards-mobile-action-sheet"
    >
      {card && (
        <section role="dialog" aria-modal="true" aria-labelledby="cards-mobile-action-title">
          <div className="cards-mobile-sheet-handle" aria-hidden="true" />
          <div className="cards-mobile-action-summary">
            <span className={`cards-mobile-action-emblem bank-card-p${card.id % 5}`}>
              <SettingOutlined />
            </span>
            <div>
              <Typography.Title id="cards-mobile-action-title" level={4}>卡片设置</Typography.Title>
              <Typography.Text type="secondary">
                {card.bankName} · {card.nickname ? `${card.nickname} · ` : ''}尾号 {card.displayLast4}
              </Typography.Text>
            </div>
          </div>
          <div className="cards-mobile-action-list" role="list" aria-label="卡片设置操作">
            <Button type="text" block icon={<EditOutlined />} onClick={onEdit}>编辑</Button>
            <Button
              type="text"
              block
              icon={card.hasSecret ? <EyeOutlined /> : <LockOutlined />}
              disabled={secretPending}
              onClick={onSecret}
            >
              {card.hasSecret ? '卡信息' : '录入卡信息'}
            </Button>
            {context?.allowSetPrimary && (
              <Button
                type="text"
                block
                icon={<StarOutlined />}
                disabled={primaryPending}
                onClick={onPrimary}
              >
                设为主卡
              </Button>
            )}
            <Button type="text" block icon={<WarningOutlined />} onClick={onStatus}>
              标记异常
            </Button>
            <Button
              type="text"
              block
              danger
              icon={<DeleteOutlined />}
              disabled={removePending}
              onClick={onRemove}
            >
              删除
            </Button>
          </div>
        </section>
      )}
    </Popup>
  );
}

function MobileCardConfirmSheet({
  target,
  loading,
  onClose,
  onConfirm,
}: {
  target: MobileCardConfirm | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isRemove = target?.action === 'remove';
  return (
    <Popup
      visible={target != null}
      position="bottom"
      destroyOnClose
      closeOnMaskClick={!loading}
      closeOnSwipe={!loading}
      onClose={onClose}
      bodyClassName="cards-mobile-confirm-sheet"
    >
      {target && (
        <section role="dialog" aria-modal="true">
          <div className="cards-mobile-sheet-handle" aria-hidden="true" />
          <InlineConfirm
            title={
              isRemove
                ? `删除 ${target.card.bankName}（${target.card.displayLast4}）？`
                : `将（${target.card.displayLast4}）设为主卡？`
            }
            description={isRemove ? deleteCardDescription(target.card) : '设置后，此卡将在卡片列表中优先展示。'}
            confirmText={isRemove ? '删除卡片' : '设为主卡'}
            danger={isRemove}
            loading={loading}
            onCancel={onClose}
            onConfirm={onConfirm}
          />
        </section>
      )}
    </Popup>
  );
}

export default function Cards() {
  const { message, modal } = App.useApp();
  const { isMobile, mode } = useResponsive();
  const location = useLocation();
  const navigate = useNavigate();
  const [rows, setRows] = useState<CardRow[]>([]);
  const [mobileScrollParent, setMobileScrollParent] = useState<HTMLElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CardRow | null | undefined>(undefined); // undefined=关闭, null=新增
  const [cardDraft, setCardDraft] = useState<CardFormDraft | null>(null);
  /** PIN 验证通过后进入卡信息完善流程（PIN 仅在 SecretModal 内存活） */
  const [secretCard, setSecretCard] = useState<ResponsiveSecretTarget | null>(null);
  /** 独立 PIN 验证框（mode=reveal 卡片展开 / mode=enter 录入前置） */
  const [pinModal, setPinModal] = useState<{
    mode: 'reveal' | 'enter';
    card: CardRow;
    responsiveMode: ResponsiveMode;
  } | null>(null);
  /** PIN 验证后原地展开的卡（单张） */
  const [revealed, setRevealed] = useState<{
    cardId: number;
    secrets: SecretValues;
    responsiveMode: ResponsiveMode;
  } | null>(null);
  /** 展开的账户组弹窗 key（多卡组点击卡片本体；数据随 rows 刷新） */
  const [groupModalKey, setGroupModalKey] = useState<string | null>(location.state?.sourceSnapshot?.groupModalKey ?? null);
  const [groupDetailCardId, setGroupDetailCardId] = useState<number | null>(location.state?.sourceSnapshot?.groupDetailCardId ?? null);
  const [markTarget, setMarkTarget] = useState<MarkPaidTarget | null>(null);
  const [cardDetailReloadKey, setCardDetailReloadKey] = useState(0);
  /** 设为优先展示请求中的卡 ID */
  const [primaryPendingId, setPrimaryPendingId] = useState<number | null>(null);
  const [removePendingId, setRemovePendingId] = useState<number | null>(null);
  const [mobileConfirm, setMobileConfirm] = useState<MobileCardConfirm | null>(null);
  const [mobileCardAction, setMobileCardAction] = useState<MobileCardActionTarget | null>(null);
  const [abnormalTarget, setAbnormalTarget] = useState<ResponsiveAbnormalFlowTarget | null>(null);
  const [secretPendingCardIds, setSecretPendingCardIds] = useState<Set<number>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useViewState('cards:query', '');
  const [sortKey, setSortKey] = useViewState<SortKey>('cards:sort', 'bank');
  const [mobileSortOpen, setMobileSortOpen] = useState(false);
  const [page, setPage] = useViewState('cards:page', 1);
  const lifecycleGen = useRef(0);
  const writeEpoch = useRef(0);
  const lastAppliedEpoch = useRef(-1);
  const savingRef = useRef(false);
  const primaryPendingRef = useRef<number | null>(null);
  const removePendingRef = useRef<number | null>(null);
  const secretPendingRef = useRef(new Map<number, number>());
  const secretWriteSeq = useRef(0);
  const secretFlowSeq = useRef(0);
  const abnormalFlowSeq = useRef(0);
  const desktopConfirmDestroy = useRef<(() => void) | null>(null);
  const confirmMode = useRef(mode);

  useEffect(
    () => () => {
      lifecycleGen.current += 1;
      desktopConfirmDestroy.current?.();
      desktopConfirmDestroy.current = null;
    },
    [],
  );

  /** 桌面确认层在断点改变后、浏览器绘制前即销毁，不短暂跨端残留。 */
  useLayoutEffect(() => {
    if (confirmMode.current === mode) return;
    confirmMode.current = mode;
    desktopConfirmDestroy.current?.();
    desktopConfirmDestroy.current = null;
  }, [mode]);

  /** `#root` 是手机壳层的真实滚动容器；布局阶段绑定，避免首次渲染拿到空节点。 */
  useLayoutEffect(() => {
    setMobileScrollParent(isMobile ? document.getElementById('root') : null);
  }, [isMobile]);

  /** 套卡分组：groupCardIds 一致（后端按出账日与还款规则分组） */
  const groups: CardGroup[] = useMemo(() => {
    const map = new Map<string, CardRow[]>();
    for (const r of rows) {
      const k = r.groupCardIds.join('-');
      const arr = map.get(k);
      if (arr) arr.push(r);
      else map.set(k, [r]);
    }
    return [...map.entries()].map(([key, cards]) => {
      const orderedCards = businessPrimaryFirst(cards);
      return {
        key,
        cards: orderedCards,
        main: businessCoverOf(orderedCards, () => pickCoverCard(orderedCards)),
      };
    });
  }, [rows]);

  const sortedGroups = useMemo(() => {
    const today = dayjs().startOf('day');
    const sortValue = (g: CardGroup): number | string => {
      if (sortKey === 'bank') return g.main.bankName;
      if (sortKey === 'statement') return daysToNextCycleDay(today, g.main.statementDay);
      if (sortKey === 'due') {
        return daysToNextDueDate(today, g.main.currentCycle.dueDate, g.main.dueRule, g.main.dueDay);
      }
      let best = Infinity;
      for (const c of g.cards) {
        const d = daysToNextAnnualFee(today, c.annualFeeDate);
        if (d < best) best = d;
      }
      return best;
    };
    return [...groups].sort((a, b) => {
      const va = sortValue(a);
      const vb = sortValue(b);
      if (typeof va === 'string' && typeof vb === 'string') {
        return va.localeCompare(vb, 'zh-Hans-CN');
      }
      return (va as number) - (vb as number);
    });
  }, [groups, sortKey]);

  const hitGroupMap = useMemo(() => {
    const map = new Map<string, CardRow[]>();
    const needle = q.trim();
    if (!needle) return map;
    for (const g of groups) {
      const hits = g.cards.filter((c) => matchCard(c, needle));
      if (hits.length > 0) map.set(g.key, hits);
    }
    return map;
  }, [groups, q]);

  const viewItems: ViewItem[] = useMemo(() => {
    const needle = q.trim();
    if (!needle) return sortedGroups.map((g) => ({ group: g, displayCard: g.main }));
    const items: ViewItem[] = [];
    for (const g of sortedGroups) {
      const hits = hitGroupMap.get(g.key) ?? [];
      if (hits.length === 0) continue;
      items.push({ group: g, displayCard: businessCoverOf(g.cards, () => pickCoverCard(hits)) });
    }
    return items;
  }, [sortedGroups, hitGroupMap, q]);

  /** 弹窗数据随 rows 刷新（设为优先展示/编辑后保持打开且状态最新） */
  const groupModal = useMemo(
    () => (groupModalKey ? (groups.find((g) => g.key === groupModalKey) ?? null) : null),
    [groupModalKey, groups],
  );

  /** 首页信用卡待办通过临时路由状态打开手机卡片详情，消费后立即清除，硬刷新不重放。 */
  useEffect(() => {
    if (!isMobile || rows.length === 0) return;
    const state = (location.state ?? {}) as { mobileCardId?: number; [key: string]: unknown };
    const cardId = state.mobileCardId;
    if (!Number.isInteger(cardId) || !cardId) return;
    const targetGroup = groups.find((group) => group.cards.some((card) => card.id === cardId));
    if (targetGroup) {
      setGroupDetailCardId(cardId);
      setGroupModalKey(targetGroup.key);
    }
    const nextState = { ...state };
    delete nextState.mobileCardId;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: nextState });
  }, [groups, isMobile, location.pathname, location.search, location.state, navigate, rows.length]);

  /** 单卡手机详情没有桌面对应物；跨到桌面时关闭。多卡仍映射到既有套卡弹窗。 */
  useEffect(() => {
    if (!isMobile && groupModal?.cards.length === 1) setGroupModalKey(null);
  }, [groupModal, isMobile]);
  const mobileCardActionContext = useMemo(() => {
    if (!mobileCardAction) return null;
    const group = groups.find((candidate) => candidate.key === mobileCardAction.groupKey);
    const card = group?.cards.find((candidate) => candidate.id === mobileCardAction.cardId);
    return group && card ? { group, card, allowSetPrimary: mobileCardAction.allowSetPrimary } : null;
  }, [groups, mobileCardAction]);
  /**
   * 手机接口一次返回全部卡片；虚拟列表按每行最多两张分组。
   * 390px 下 CSS 把同一虚拟行排成单列，720-1023px 排成双列；Virtuoso 仍可正确测量不等高行。
   */
  const mobileVirtualRows = useMemo(() => {
    const result: ViewItem[][] = [];
    for (let index = 0; index < viewItems.length; index += 2) {
      result.push(viewItems.slice(index, index + 2));
    }
    return result;
  }, [viewItems]);
  const desktopPageSize = 18;
  const pageCount = Math.max(1, Math.ceil(viewItems.length / desktopPageSize));
  const currentPage = Math.min(page, pageCount);
  const desktopViewItems = useMemo(
    () => viewItems.slice((currentPage - 1) * desktopPageSize, currentPage * desktopPageSize),
    [currentPage, viewItems],
  );
  const activePinModal = pinModal?.responsiveMode === mode ? pinModal : null;
  const activeSecretCard = secretCard?.responsiveMode === mode ? secretCard : null;
  const activeAbnormalTarget = abnormalTarget?.responsiveMode === mode ? abnormalTarget : null;

  /**
   * 读请求只能覆盖它发出时的数据版本。
   * 写开始与提交成功都会推进版本：写前/写中启动的 GET 即使更晚返回，也不能覆盖写后结果。
   */
  const loadCards = useCallback(async () => {
    const generation = lifecycleGen.current;
    const requestedEpoch = writeEpoch.current;
    setLoading(true);
    try {
      const data = await api.get<CardRow[]>('/api/cards');
      if (generation === lifecycleGen.current && requestedEpoch === writeEpoch.current) {
        setRows(data);
        setLoadError(null);
        lastAppliedEpoch.current = requestedEpoch;
      }
      return data;
    } catch (err) {
      if (generation === lifecycleGen.current && requestedEpoch === writeEpoch.current) {
        setLoadError(err instanceof ApiError ? err.message : '卡片列表加载失败');
      }
      throw err;
    } finally {
      if (generation === lifecycleGen.current) setLoading(false);
    }
  }, []);

  const load = useCoalescedRefresh(loadCards);

  const beginWrite = useCallback(() => {
    writeEpoch.current += 1;
  }, []);

  const commitWrite = useCallback(() => {
    writeEpoch.current += 1;
    return writeEpoch.current;
  }, []);

  /**
   * 写提交后不复用任何在途读取，必须排队发出一笔真正晚于提交时点的 GET。
   * 若它被更晚的写版本作废或读取失败，再补一次；已提交的写入不会被误报为失败。
   */
  const refreshAfterMutation = useCallback(
    async (mutationEpoch: number) => {
      try {
        await load({ freshAfterInFlight: true });
      } catch {
        // 失败会在页面上保留可见错误与重试入口。
      }
      if (lastAppliedEpoch.current < mutationEpoch) {
        try {
          await load({ freshAfterInFlight: true });
        } catch {
          // 二次读取仍失败时不将已提交成功的写入误报为失败。
        }
      }
    },
    [load],
  );

  /**
   * 卡信息写锁由页面持有：SecretModal 跨断点卸载只清 PIN/明文，不能释放已经发出的写请求。
   * requestId 只允许原请求在 finally 释放同一卡锁，避免旧请求误清后来请求的 pending。
   */
  const saveSecret = useCallback(
    async (cardId: number, pin: string, values: SecretFormValues): Promise<boolean> => {
      if (secretPendingRef.current.has(cardId)) {
        message.info('该卡的卡信息正在保存，请稍候');
        return false;
      }

      const requestId = ++secretWriteSeq.current;
      const lifecycleGeneration = lifecycleGen.current;
      beginWrite();
      secretPendingRef.current.set(cardId, requestId);
      setSecretPendingCardIds((current) => {
        if (current.has(cardId)) return current;
        const next = new Set(current);
        next.add(cardId);
        return next;
      });

      try {
        await api.post(`/api/cards/${cardId}/secret`, { pin, ...values });
        const mutationEpoch = commitWrite();
        await refreshAfterMutation(mutationEpoch);
        if (lifecycleGeneration === lifecycleGen.current) message.success('已保存');
        return true;
      } catch (err) {
        if (lifecycleGeneration === lifecycleGen.current) {
          message.error(err instanceof ApiError ? err.message : '保存失败');
        }
        return false;
      } finally {
        if (secretPendingRef.current.get(cardId) === requestId) {
          secretPendingRef.current.delete(cardId);
          if (lifecycleGeneration === lifecycleGen.current) {
            setSecretPendingCardIds((current) => {
              if (!current.has(cardId)) return current;
              const next = new Set(current);
              next.delete(cardId);
              return next;
            });
          }
        }
      }
    },
    [beginWrite, commitWrite, message, refreshAfterMutation],
  );

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  /** 设备模式变化后从第一页开始，数据减少时收敛到最后一个有效页。 */
  useEffect(() => {
    setPage(1);
  }, [mode]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  /** 跨断点只保留普通编辑草稿、搜索/排序与套卡上下文；凭证和危险确认立即清理。 */
  useResetOnModeChange(() => {
    desktopConfirmDestroy.current?.();
    desktopConfirmDestroy.current = null;
    setPinModal(null);
    setSecretCard(null);
    setRevealed(null);
    setMobileConfirm(null);
    setMobileCardAction(null);
    setMobileSortOpen(false);
    setAbnormalTarget(null);
    setMarkTarget(null);
  });

  /** 眼睛图标：已展开 → 收起恢复掩码；未展开 → 每次重新输入 PIN 后原地展开明文 */
  const onEye = (card: CardRow) => {
    if (revealed?.responsiveMode === mode && revealed.cardId === card.id) {
      setRevealed(null);
      return;
    }
    setRevealed(null);
    setPinModal({ mode: 'reveal', card, responsiveMode: mode });
  };

  /** 卡信息按钮：先验证 PIN，再进入完善流程 */
  const onSecretEntry = (card: CardRow) => {
    if (secretPendingRef.current.has(card.id)) {
      message.info('该卡的卡信息正在保存，请稍候');
      return;
    }
    setRevealed(null);
    setPinModal({ mode: 'enter', card, responsiveMode: mode });
  };

  const pinVerified = (pin: string, secrets?: SecretValues) => {
    if (!pinModal || pinModal.responsiveMode !== mode) return;
    const target = pinModal.card;
    setPinModal(null);
    if (secrets) {
      setRevealed({ cardId: target.id, secrets, responsiveMode: mode });
    } else {
      if (secretPendingRef.current.has(target.id)) {
        message.info('该卡的卡信息正在保存，请稍候');
        return;
      }
      setSecretCard({ card: target, pin, responsiveMode: mode, flowId: ++secretFlowSeq.current });
    }
  };

  /** 敏感信息弹窗关闭：PIN 随 SecretModal unmount 回收 */
  const closeSecret = (target: ResponsiveSecretTarget) => {
    setSecretCard((current) => (current?.flowId === target.flowId ? null : current));
  };

  const submit = async (values: Partial<CardInput>) => {
    if (savingRef.current || editing === undefined) return;
    savingRef.current = true;
    const target = editing;
    beginWrite();
    setSaving(true);
    try {
      if (target) {
        await api.put(`/api/cards/${target.id}`, values);
        message.success('已保存');
      } else {
        await api.post('/api/cards', values);
        message.success('已创建');
      }
      const mutationEpoch = commitWrite();
      await refreshAfterMutation(mutationEpoch);
      setEditing(undefined);
      setCardDraft(null);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const remove = async (card: CardRow) => {
    if (removePendingRef.current != null) return;
    removePendingRef.current = card.id;
    setRemovePendingId(card.id);
    beginWrite();
    try {
      await api.delete(`/api/cards/${card.id}`);
      const mutationEpoch = commitWrite();
      setRevealed(null);
      await refreshAfterMutation(mutationEpoch);
      message.success('已删除');
      setMobileConfirm((current) =>
        current?.action === 'remove' && current.card.id === card.id ? null : current,
      );
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
      throw err;
    } finally {
      if (removePendingRef.current === card.id) removePendingRef.current = null;
      setRemovePendingId((current) => (current === card.id ? null : current));
    }
  };

  /** 设为优先展示：仅控制普通套卡列表哪张卡居首 */
  const setPrimary = async (card: CardRow) => {
    if (primaryPendingRef.current != null) return;
    primaryPendingRef.current = card.id;
    setPrimaryPendingId(card.id);
    beginWrite();
    try {
      await api.post(`/api/cards/${card.id}/primary`);
      const mutationEpoch = commitWrite();
      setRevealed(null);
      await refreshAfterMutation(mutationEpoch);
      message.success(`已将（${card.displayLast4}）设为主卡，将在卡片列表中优先展示`);
      setMobileConfirm((current) =>
        current?.action === 'primary' && current.card.id === card.id ? null : current,
      );
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
      throw err;
    } finally {
      if (primaryPendingRef.current === card.id) primaryPendingRef.current = null;
      setPrimaryPendingId((current) => (current === card.id ? null : current));
    }
  };

  const onAbnormalDone = () => {
    // MarkAbnormalModal 在写请求提交后才回调；此处推进版本即可作废其写前/写中读取。
    const mutationEpoch = commitWrite();
    setRevealed(null);
    void refreshAfterMutation(mutationEpoch);
  };

  const closeAbnormal = (target: ResponsiveAbnormalFlowTarget) => {
    setAbnormalTarget((current) =>
      current?.flowId === target.flowId ? null : current,
    );
  };

  const openEditing = (card: CardRow | null) => {
    if (groupModalKey && card) setGroupDetailCardId(card.id);
    setRevealed(null);
    setCardDraft(null);
    setEditing(card);
  };

  const closeEditing = () => {
    setEditing(undefined);
    setCardDraft(null);
  };

  const requestConfirm = (action: MobileCardConfirm['action'], card: CardRow) => {
    if (action === 'primary' && primaryPendingRef.current != null) return;
    if (action === 'remove' && removePendingRef.current != null) return;
    setRevealed(null);
    if (isMobile) {
      setMobileConfirm({ action, card });
      return;
    }

    desktopConfirmDestroy.current?.();
    let destroy: (() => void) | null = null;
    const instance = modal.confirm({
      title:
        action === 'remove'
          ? `删除 ${card.bankName}（${card.displayLast4}）？`
          : `将（${card.displayLast4}）设为主卡？`,
      content:
        action === 'remove' ? deleteCardDescription(card) : '设置后，此卡将在卡片列表中优先展示。',
      okText: action === 'remove' ? '删除卡片' : '设为主卡',
      okButtonProps: action === 'remove' ? { danger: true } : undefined,
      onOk: () => (action === 'remove' ? remove(card) : setPrimary(card)),
      afterClose: () => {
        if (desktopConfirmDestroy.current === destroy) desktopConfirmDestroy.current = null;
      },
    });
    destroy = instance.destroy;
    desktopConfirmDestroy.current = destroy;
  };

  /** 渲染一张卡（组内单卡 or 组主显示卡 or 弹窗内每张卡） */
  const renderCard = (card: CardRow, group: CardGroup, plain = false) => (
    <BankCardItem
      card={card}
      revealed={revealed?.responsiveMode === mode && revealed.cardId === card.id ? revealed.secrets : null}
      groupCards={group.cards}
      onEye={() => { if (groupModalKey) setGroupDetailCardId(card.id); onEye(card); }}
      onEdit={() => openEditing(card)}
      onSecret={() => { if (groupModalKey) setGroupDetailCardId(card.id); onSecretEntry(card); }}
      onMobileActions={() =>
        setMobileCardAction({
          cardId: card.id,
          groupKey: group.key,
          allowSetPrimary: plain && canSetPrimary(group, card),
        })
      }
      onAbnormal={() => {
        setRevealed(null);
        setAbnormalTarget({
          cardId: card.id,
          bankName: card.bankName,
          cardLast4: card.displayLast4,
          status: card.status,
          responsiveMode: mode,
          flowId: ++abnormalFlowSeq.current,
        });
      }}
      onCardClick={!plain && (isMobile || group.cards.length > 1) ? () => {
        setGroupDetailCardId(card.id);
        setGroupModalKey(group.key);
      } : undefined}
      allowSetPrimary={plain && canSetPrimary(group, card)}
      onRequestConfirm={(action) => requestConfirm(action, card)}
      primaryPending={primaryPendingId != null}
      secretPending={secretPendingCardIds.has(card.id)}
      plain={plain}
      showBilling={card.businessRole !== 'secondary' && card.businessRole !== 'supplementary'}
      showBusinessRole={shouldShowBusinessRole(group.cards, plain)}
    />
  );

  const mobileConfirmLoading =
    mobileConfirm?.action === 'remove'
      ? removePendingId === mobileConfirm.card.id
      : mobileConfirm?.action === 'primary'
        ? primaryPendingId === mobileConfirm.card.id
        : false;
  const listWritePending =
    saving ||
    primaryPendingId != null ||
    removePendingId != null ||
    secretPendingCardIds.size > 0;

  const runFromMobileCardAction = (action: () => void) => {
    setMobileCardAction(null);
    action();
  };

  /**
   * MarkAbnormalModal 固定为所有响应式分支的同一个带 key 兄弟节点。
   * 因此断点切换可以清掉 target/选择态，但组件内已经开始的 saving 锁会一直存活到原请求 finally。
   */
  useSourceSnapshot({ groupModalKey, groupDetailCardId });

  const withAbnormalFlow = (content: React.ReactNode) => (
    <>
      {content}
      <MarkAbnormalModal
        key="cards-abnormal-flow"
        target={activeAbnormalTarget}
        onClose={() => activeAbnormalTarget && closeAbnormal(activeAbnormalTarget)}
        onDone={onAbnormalDone}
      />
      <MarkPaidModal
        target={markTarget}
        onClose={() => setMarkTarget(null)}
        onDone={() => {
          setCardDetailReloadKey((key) => key + 1);
          void load().catch(() => undefined);
        }}
      />
      {isMobile && (
        <>
          <MobileCardSortSheet
            open={mobileSortOpen}
            value={sortKey}
            onClose={() => setMobileSortOpen(false)}
            onChange={(value) => {
              setSortKey(value);
              setPage(1);
            }}
          />
          <MobileCardActionSheet
            context={mobileCardActionContext
              ? {
                  card: mobileCardActionContext.card,
                  allowSetPrimary: mobileCardActionContext.allowSetPrimary,
                }
              : null}
            primaryPending={primaryPendingId != null}
            removePending={removePendingId != null}
            secretPending={mobileCardActionContext
              ? secretPendingCardIds.has(mobileCardActionContext.card.id)
              : false}
            onClose={() => setMobileCardAction(null)}
            onEdit={() => {
              if (mobileCardActionContext) {
                runFromMobileCardAction(() => openEditing(mobileCardActionContext.card));
              }
            }}
            onSecret={() => {
              if (mobileCardActionContext) {
                runFromMobileCardAction(() => onSecretEntry(mobileCardActionContext.card));
              }
            }}
            onPrimary={() => {
              if (mobileCardActionContext) {
                runFromMobileCardAction(() => requestConfirm('primary', mobileCardActionContext.card));
              }
            }}
            onStatus={() => {
              if (!mobileCardActionContext) return;
              const card = mobileCardActionContext.card;
              runFromMobileCardAction(() => {
                setRevealed(null);
                setAbnormalTarget({
                  cardId: card.id,
                  bankName: card.bankName,
                  cardLast4: card.displayLast4,
                  status: card.status,
                  responsiveMode: mode,
                  flowId: ++abnormalFlowSeq.current,
                });
              });
            }}
            onRemove={() => {
              if (mobileCardActionContext) {
                runFromMobileCardAction(() => requestConfirm('remove', mobileCardActionContext.card));
              }
            }}
          />
          <MobileCardConfirmSheet
            target={mobileConfirm}
            loading={mobileConfirmLoading}
            onClose={() => {
              if (!mobileConfirmLoading) setMobileConfirm(null);
            }}
            onConfirm={() => {
              if (!mobileConfirm) return;
              const action = mobileConfirm.action === 'remove'
                ? remove(mobileConfirm.card)
                : setPrimary(mobileConfirm.card);
              void action.catch(() => undefined);
            }}
          />
        </>
      )}
    </>
  );

  if (isMobile && editing !== undefined) {
    return withAbnormalFlow(
      <CardForm
        key={editing?.id ?? 'new'}
        initial={editing}
        restoreDraft={cardDraft}
        onDraftChange={setCardDraft}
        onOk={submit}
        onCancel={closeEditing}
        confirmLoading={saving}
      />,
    );
  }

  if (isMobile && activePinModal) {
    return withAbnormalFlow(
      <PinVerifyModal
        mode={activePinModal.mode}
        card={activePinModal.card}
        onOk={pinVerified}
        onClose={() => setPinModal(null)}
      />,
    );
  }

  if (isMobile && activeSecretCard) {
    return withAbnormalFlow(
      <SecretModal
        card={activeSecretCard.card}
        pin={activeSecretCard.pin}
        onClose={() => closeSecret(activeSecretCard)}
        onSave={saveSecret}
      />,
    );
  }

  if (isMobile && groupModal) {
    return withAbnormalFlow(
      <MobileCardDetail
        cards={groupModal.cards}
        main={groupModal.main}
        focusCardId={groupDetailCardId}
        reloadKey={cardDetailReloadKey}
        renderCard={(card) => renderCard(card, groupModal, true)}
        onBack={() => {
          setRevealed(null);
          setMarkTarget(null);
          setGroupDetailCardId(null);
          setGroupModalKey(null);
        }}
        onChanged={() => { void load(); }}
      />,
    );
  }

  if (isMobile) {
    return withAbnormalFlow(
      <Page title="卡片管理">
        <MobilePullToRefresh onRefresh={load} disabled={listWritePending}>
          {rows.length > 0 && (
            <div className="cards-mobile-controls">
              <SearchBar
                placeholder="搜索银行、尾号或别名"
                value={q}
                onChange={(value) => {
                  setQ(value);
                  setPage(1);
                }}
              />
              <Button
                className={`cards-mobile-toolbar-button cards-mobile-sort-trigger${sortKey !== 'bank' ? ' is-active' : ''}`}
                icon={<SortAscendingOutlined />}
                aria-label={`卡片排序，当前${CARD_SORT_OPTIONS.find((option) => option.value === sortKey)?.label ?? ''}`}
                onClick={() => setMobileSortOpen(true)}
              />
              <Button
                className="cards-mobile-add-trigger"
                type="primary"
                icon={<PlusOutlined />}
                aria-label="新增卡片"
                onClick={() => openEditing(null)}
              >
                新增
              </Button>
            </div>
          )}

          {loadError && (
            <Alert
              type="error"
              showIcon
              title="卡片列表加载失败"
              description={loadError}
              action={
                <Button
                  size="small"
                  disabled={listWritePending}
                  onClick={() => void load().catch(() => undefined)}
                >
                  重试
                </Button>
              }
              className="cards-mobile-alert"
            />
          )}

          {loading && rows.length === 0 ? (
            <div className="cards-mobile-loading">
              <Spin />
            </div>
          ) : rows.length === 0 ? (
            <Empty description="暂无卡片，绑定邮箱同步账单或手动新增" className="cards-mobile-empty">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditing(null)}>
                新增卡片
              </Button>
            </Empty>
          ) : q.trim() !== '' && viewItems.length === 0 ? (
            <Empty description="未找到匹配的卡片" className="cards-mobile-empty" />
          ) : (
            mobileScrollParent ? (
                <Virtuoso
                  className="cards-mobile-virtuoso"
                  aria-label="卡片列表"
                  customScrollParent={mobileScrollParent}
                  data={mobileVirtualRows}
                  increaseViewportBy={{ top: 320, bottom: 640 }}
                  computeItemKey={(_, virtualRow) =>
                    virtualRow.map((item) => item.group.key).join(':')
                  }
                  itemContent={(_, virtualRow) => (
                    <div className="cards-mobile-virtual-row">
                      {virtualRow.map((item) => (
                        <div className="cards-mobile-virtual-card" key={item.group.key}>
                          {renderCard(item.displayCard, item.group)}
                        </div>
                      ))}
                    </div>
                  )}
                />
              ) : (
                <div className="cards-mobile-loading" aria-label="正在准备卡片列表">
                  <Spin size="small" />
                </div>
              )
          )}
        </MobilePullToRefresh>
      </Page>,
    );
  }

  return withAbnormalFlow(
    <Page
      title="卡片管理"
      extra={
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索尾号、银行、别名或持卡人"
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              setPage(1);
            }}
            style={{ width: 240 }}
          />
          <Select<SortKey>
            aria-label="卡片排序方式"
            value={sortKey}
            onChange={(value) => {
              setSortKey(value);
              setPage(1);
            }}
            style={{ width: 150 }}
            options={CARD_SORT_OPTIONS}
          />
          <Button
            icon={<ReloadOutlined />}
            disabled={listWritePending}
            onClick={() => void load().catch(() => undefined)}
            loading={loading}
          >
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditing(null)}>
            新增卡片
          </Button>
        </Space>
      }
    >
      {loadError && (
        <Alert
          type="error"
          showIcon
          title="卡片列表加载失败"
          description={loadError}
          action={
            <Button
              size="small"
              disabled={listWritePending}
              onClick={() => void load().catch(() => undefined)}
            >
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}
      {loading && rows.length === 0 ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: 240 }}>
          <Spin />
        </div>
      ) : rows.length === 0 ? (
        <Empty description="暂无卡片，绑定邮箱同步账单或手动新增" style={{ padding: '48px 0' }} />
      ) : rows.length > 0 && q.trim() !== '' && viewItems.length === 0 ? (
        <Empty description="未找到匹配的卡片" style={{ padding: '48px 0' }} />
      ) : (
        <Row gutter={[16, 16]}>
          {desktopViewItems.map((item) => (
            <Col xs={24} sm={12} md={12} lg={12} xl={8} key={item.group.key}>
              {renderCard(item.displayCard, item.group)}
            </Col>
          ))}
        </Row>
      )}
      {viewItems.length > desktopPageSize && (
        <div className="cards-desktop-pagination">
          <Pagination
            current={currentPage}
            pageSize={desktopPageSize}
            total={viewItems.length}
            showSizeChanger={false}
            showTotal={(total) => `共 ${total} 组卡片`}
            onChange={setPage}
          />
        </div>
      )}

      {editing !== undefined && (
        <CardForm
          key={editing?.id ?? 'new'}
          initial={editing}
          restoreDraft={cardDraft}
          onDraftChange={setCardDraft}
          onOk={submit}
          onCancel={closeEditing}
          confirmLoading={saving}
        />
      )}
      {activePinModal && (
        <PinVerifyModal
          mode={activePinModal.mode}
          card={activePinModal.card}
          onOk={pinVerified}
          onClose={() => setPinModal(null)}
        />
      )}
      {activeSecretCard && (
        <SecretModal
          card={activeSecretCard.card}
          pin={activeSecretCard.pin}
          onClose={() => closeSecret(activeSecretCard)}
          onSave={saveSecret}
        />
      )}
      {/* 套卡展开弹窗：组内全部卡（普通套卡可设为优先展示；明确业务组不可更换业务主卡） */}
      {groupModal && (
        <Modal
          title={cardGroupTitle(groupModal.main.bankName, groupModal.cards)}
          open
          footer={null}
          onCancel={() => {
            setRevealed(null);
            setGroupModalKey(null);
          }}
          destroyOnHidden
          width="min(1200px, 94vw)"
        >
          <Row gutter={[16, 16]}>
            {groupModal.cards.map((card) => (
              <Col xs={24} sm={24} md={24} lg={12} xl={8} key={card.id}>
                {renderCard(card, groupModal, true)}
              </Col>
            ))}
          </Row>
          <CardBillSection cardIds={groupModal.cards.map(card => card.id)} revision={cardDetailReloadKey} onChanged={() => { void load(); }} />
        </Modal>
      )}
    </Page>,
  );
}
