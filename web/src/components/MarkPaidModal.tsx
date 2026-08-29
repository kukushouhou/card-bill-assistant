import { useEffect, useState } from 'react';
import { App, Button, InputNumber, Modal, Radio, Typography } from 'antd';
import { api, ApiError } from '../api/client';
import { currencyPrefix, formatMoney } from '../lib/money';
import { useResetOnModeChange, useResponsive } from '../responsive';
import MobileMarkPaidFlow from './MobileMarkPaidFlow';

/**
 * 标记还款目标（任何入口：首页今日提醒 / 未来 14 天 / 账单记录行 / 提醒中心）。
 * billId 缺省 = 场景 A（该期缺账单补录）；传入 = 场景 B（已有账单改标记）。
 */
export interface MarkPaidTarget {
  targetType?: 'card' | 'custom';
  occurrenceId?: number;
  businessType?: 'fixed_bill' | 'dynamic_bill';
  name?: string;
  cardId: number;
  bankName: string;
  cardLast4: string;
  period: string;
  currency?: string;
  /** 已有账单时传入（场景 B） */
  billId?: number;
  /** 该期应还金额（场景 B 展示用） */
  amount?: number | null;
  /** 最低还款额（场景 B 部分已还提示用） */
  minAmount?: number | null;
  paidStatus?: string | null;
  paidAmount?: number | null;
}

type Choice = 'none' | 'full' | 'partial' | 'unpaid';

function PaymentChoiceCard({
  value,
  title,
  desc,
  selected,
  disabled,
}: {
  value: Choice;
  title: string;
  desc: string;
  selected: boolean;
  disabled: boolean;
}) {
  return (
    <Radio.Button value={value} disabled={disabled}>
      <Typography.Text strong={selected} style={{ fontSize: 15 }}>
        {title}
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0, marginTop: 6 }}>
        {desc}
      </Typography.Paragraph>
    </Radio.Button>
  );
}

/**
 * 统一标记弹窗：
 * - 场景 A 缺账单：本期无需还款（金额为零）/ 全部已还清（填应还金额）/ 部分已还（填应还 + 已还金额）
 * - 场景 B 已有账单：全部还清 / 部分已还（填已还金额）/ 恢复未还（清除标记）
 * 手机端由 MobileMarkPaidFlow 提供独立的触控步骤，桌面端保留本弹窗结构。
 */
export default function MarkPaidModal({
  target,
  onClose,
  onDone,
}: {
  target: MarkPaidTarget | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [paidAmount, setPaidAmount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useResetOnModeChange(() => {
    // 未提交的还款选择属于待执行确认；跨断点重置，已经发出的写请求则继续接管结果。
    if (!saving) setChoice(null);
  });

  useEffect(() => {
    setChoice(null);
    setAmount(target?.targetType === 'custom' ? target.amount ?? null : null);
    // 场景 B 部分已还：预填当前已还金额，便于追加
    setPaidAmount(
      target?.billId != null && target.paidStatus === 'partial' ? target.paidAmount ?? null : null,
    );
  }, [target]);

  if (!target) return null;
  const isCustom = target.targetType === 'custom';
  const hasBill = target.billId != null;
  const currency = target.currency ?? 'CNY';

  const submit = async () => {
    if (!target || saving) return;
    setSaving(true);
    try {
      if (isCustom) {
        if (!target.occurrenceId) throw new Error('账单期次不存在');
        if (target.paidStatus === 'paid') {
          await api.put(`/api/reminders/occurrences/${target.occurrenceId}/paid`, { action: 'unpaid' });
          message.success('已恢复待还');
        } else {
          if (target.businessType === 'dynamic_bill' && (amount == null || !Number.isFinite(amount) || amount < 0)) {
            message.warning('请输入本期账单金额');
            return;
          }
          await api.put(`/api/reminders/occurrences/${target.occurrenceId}/paid`, {
            action: 'paid',
            ...(target.businessType === 'dynamic_bill' ? { amount } : {}),
          });
          message.success('已标记还款');
        }
        onDone();
        onClose();
        return;
      }
      if (hasBill) {
        // 场景 B：已有账单，PUT 更新还款状态
        if (choice === 'unpaid') {
          await api.put(`/api/bills/${target.billId}/paid`, { action: 'unpaid' });
          message.success('已恢复待还');
        } else if (choice === 'full') {
          await api.put(`/api/bills/${target.billId}/paid`, { action: 'full' });
          message.success('已标记全部还清');
        } else {
          if (paidAmount == null || !Number.isFinite(paidAmount) || paidAmount < 0) {
            message.warning('请输入累计已还金额');
            return;
          }
          await api.put(`/api/bills/${target.billId}/paid`, { action: 'partial', paidAmount });
          message.success('已标记部分已还');
        }
      } else {
        // 场景 A：缺账单补录，POST 创建手动账单
        if (choice === 'none') {
          await api.post('/api/bills/mark', {
            cardId: target.cardId,
            period: target.period,
            currency,
            mode: 'none',
          });
          message.success('已标记本期无需还款');
        } else if (choice === 'full') {
          if (amount == null || !Number.isFinite(amount) || amount < 0) {
            message.warning('请输入应还金额');
            return;
          }
          await api.post('/api/bills/mark', {
            cardId: target.cardId,
            period: target.period,
            currency,
            mode: 'full',
            amount,
          });
          message.success('已标记全部还清');
        } else {
          if (amount == null || !Number.isFinite(amount) || amount < 0) {
            message.warning('请输入应还金额');
            return;
          }
          if (paidAmount == null || !Number.isFinite(paidAmount) || paidAmount < 0) {
            message.warning('请输入累计已还金额');
            return;
          }
          if (paidAmount >= amount) {
            message.warning('已还金额应小于应还金额，全部结清请选择「全部已还清」');
            return;
          }
          await api.post('/api/bills/mark', {
            cardId: target.cardId,
            period: target.period,
            currency,
            mode: 'partial',
            amount,
            paidAmount,
          });
          message.success('已标记部分已还');
        }
      }
      onDone();
      onClose();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      setSaving(false);
    }
  };

  // 写请求已经发出后由当前共享流程接管结果，避免遮罩、Esc 或手机返回让旧响应串到新目标。
  const dismiss = () => {
    if (saving) return;
    onClose();
  };

  const content = isCustom ? (
        <>
          {target.paidStatus === 'paid' ? (
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              该账单已还款，恢复后会重新进入待还账单。
            </Typography.Paragraph>
          ) : target.businessType === 'dynamic_bill' ? (
            <InputNumber
              autoFocus
              min={0}
              max={99_999_999}
              precision={2}
              style={{ width: '100%' }}
              placeholder="本期账单金额"
              prefix={currencyPrefix(currency)}
              value={amount}
              onChange={(value) => setAmount(value)}
            />
          ) : (
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              本期金额 {formatMoney(target.amount ?? 0, currency)}
            </Typography.Paragraph>
          )}
        </>
      ) : hasBill ? (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
            该期账单{target.amount != null ? `应还 ${formatMoney(target.amount, currency)}` : '金额未取得'}
            {target.minAmount != null ? `（最低还款 ${formatMoney(target.minAmount, currency)}）` : ''}，请选择还款情况：
          </Typography.Paragraph>
          <Radio.Group
            className="choice-card-group"
            aria-label="选择还款情况"
            value={choice ?? undefined}
            disabled={saving}
            onChange={(event) => setChoice(event.target.value as Choice)}
          >
            <PaymentChoiceCard
              value="full"
              title="全部还清"
              desc={target.amount != null
                ? `结清剩余 ${formatMoney(Math.max(
                    0,
                    target.amount - (target.paidStatus === 'paid' ? target.amount : target.paidAmount ?? 0),
                  ), currency)}`
                : '按已结清处理'}
              selected={choice === 'full'}
              disabled={saving}
            />
            <PaymentChoiceCard
              value="partial"
              title="部分已还"
              desc={
                target.minAmount != null
                  ? `已还 ≥ 最低还款 ${formatMoney(target.minAmount, currency)} 不视为逾期`
                  : '填写累计已还金额'
              }
              selected={choice === 'partial'}
              disabled={saving}
            />
            <PaymentChoiceCard
              value="unpaid"
              title="恢复未还"
              desc="清除还款标记"
              selected={choice === 'unpaid'}
              disabled={saving}
            />
          </Radio.Group>
          {choice === 'partial' && (
            <div style={{ marginTop: 16 }}>
              <InputNumber
                autoFocus
                min={0}
                max={99_999_999}
                precision={2}
                style={{ width: '100%' }}
                placeholder="累计已还金额"
                prefix={currencyPrefix(currency)}
                value={paidAmount}
                onChange={(v) => setPaidAmount(v)}
              />
            </div>
          )}
        </>
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
            该期未取得账单，请选择还款情况：
          </Typography.Paragraph>
          <Radio.Group
            className="choice-card-group"
            aria-label="选择还款情况"
            value={choice ?? undefined}
            disabled={saving}
            onChange={(event) => setChoice(event.target.value as Choice)}
          >
            <PaymentChoiceCard
              value="none"
              title="本期无需还款"
              desc={`金额记为 ${formatMoney(0, currency)}`}
              selected={choice === 'none'}
              disabled={saving}
            />
            <PaymentChoiceCard
              value="full"
              title="全部已还清"
              desc="输入应还金额"
              selected={choice === 'full'}
              disabled={saving}
            />
            <PaymentChoiceCard
              value="partial"
              title="部分已还"
              desc="输入应还金额与累计已还金额"
              selected={choice === 'partial'}
              disabled={saving}
            />
          </Radio.Group>
          {choice === 'full' && (
            <div style={{ marginTop: 16 }}>
              <InputNumber
                autoFocus
                min={0}
                max={99_999_999}
                precision={2}
                style={{ width: '100%' }}
                placeholder="应还金额"
                prefix={currencyPrefix(currency)}
                value={amount}
                onChange={(v) => setAmount(v)}
              />
            </div>
          )}
          {choice === 'partial' && (
            <div style={{ marginTop: 16, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <InputNumber
                autoFocus
                min={0}
                max={99_999_999}
                precision={2}
                style={{ flex: '1 1 180px' }}
                placeholder="应还金额"
                prefix={currencyPrefix(currency)}
                value={amount}
                onChange={(v) => setAmount(v)}
              />
              <InputNumber
                min={0}
                max={99_999_999}
                precision={2}
                style={{ flex: '1 1 180px' }}
                placeholder="累计已还金额"
                prefix={currencyPrefix(currency)}
                value={paidAmount}
                onChange={(v) => setPaidAmount(v)}
              />
            </div>
          )}
        </>
      );

  const title = isCustom
    ? `${target.paidStatus === 'paid' ? '恢复待还' : '还款'} - ${target.name ?? ''}`
    : `标记还款 - ${target.bankName}（${target.cardLast4}）${target.period}期`;

  if (isMobile) {
    return <MobileMarkPaidFlow target={target} onClose={dismiss} onDone={onDone} />;
  }

  const primaryAction = (
    <Button
      type="primary"
      disabled={!isCustom && choice == null}
      loading={saving}
      onClick={submit}
    >
      {isCustom && target.paidStatus !== 'paid' ? '确认还款' : '确定'}
    </Button>
  );
  const cancelAction = (
    <Button disabled={saving} onClick={dismiss}>
      取消
    </Button>
  );
  const footer = <>{cancelAction}{primaryAction}</>;

  return (
    <Modal
      title={title}
      open
      onCancel={dismiss}
      footer={footer}
      destroyOnHidden
      width={560}
      closable={!saving}
      mask={{ closable: !saving }}
      keyboard={!saving}
    >
      {content}
    </Modal>
  );
}
