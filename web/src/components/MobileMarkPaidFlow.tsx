import { displayPeriod } from '../lib/displayDate';
import { useEffect, useRef, useState } from 'react';
import { useUnsavedExit } from '../lib/draftGuard';
import {
  CheckCircleOutlined,
  EditOutlined,
  MinusCircleOutlined,
  UndoOutlined,
  WalletOutlined,
} from '../skins/icons';
import { App, Button, InputNumber, Tag, Typography } from 'antd';
import { List as MobileList } from 'antd-mobile';
import { api, ApiError } from '../api/client';
import { currencyPrefix, formatMoney } from '../lib/money';
import type { MarkPaidTarget } from './MarkPaidModal';
import { MobileFlow } from './MobilePrimitives';
import './mobile-action-flows.css';

type MobilePaymentAction = 'full' | 'partial' | 'unpaid' | 'none';
type MobilePaymentStep = 'choose' | 'amount' | 'confirm';

function money(value: number | null | undefined, currency = 'CNY') {
  return value == null ? '金额未知' : formatMoney(value, currency);
}

function currentPaid(target: MarkPaidTarget) {
  if (target.paidStatus === 'paid') return target.paidAmount ?? target.amount ?? 0;
  if (target.paidStatus === 'partial') return target.paidAmount ?? 0;
  return 0;
}

function statusPreview(total: number | null, paid: number, minAmount: number | null | undefined) {
  if (total != null && paid >= total) return { label: '已还清', color: 'green' };
  if (minAmount != null && paid >= minAmount) return { label: '已还最低', color: 'blue' };
  if (paid > 0) return { label: '部分已还', color: 'orange' };
  return { label: '待还', color: undefined };
}

function MobileCustomBillFlow({
  target,
  onClose,
  onDone,
}: {
  target: MarkPaidTarget;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const currency = target.currency ?? 'CNY';
  const [amount, setAmount] = useState<number | null>(target.amount ?? null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { requestExit, confirmation } = useUnsavedExit(amount !== (target.amount ?? null), onClose, saving);

  useEffect(() => setAmount(target.amount ?? null), [target]);

  const submit = async () => {
    if (!target.occurrenceId || savingRef.current) return;
    if (target.paidStatus !== 'paid' && target.businessType === 'dynamic_bill'
      && (amount == null || !Number.isFinite(amount) || amount < 0)) {
      message.warning('请输入本期账单金额');
      return;
    }
    savingRef.current = true; setSaving(true);
    try {
      await api.put(`/api/reminders/occurrences/${target.occurrenceId}/paid`, target.paidStatus === 'paid'
        ? { action: 'unpaid' }
        : { action: 'paid', ...(target.businessType === 'dynamic_bill' ? { amount } : {}) });
      message.success(target.paidStatus === 'paid' ? '已恢复待还' : '已标记还款');
      onDone();
      onClose();
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '操作失败');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <MobileFlow
      title={target.paidStatus === 'paid' ? '恢复待还' : '还款'}
      onBack={requestExit}
      className="mobile-payment-flow"
      footer={(
        <div className="mobile-flow-action-row">
          <Button block disabled={saving} onClick={requestExit}>取消</Button>
          <Button type="primary" block loading={saving} onClick={submit}>
            {target.paidStatus === 'paid' ? '确认恢复' : '确认还款'}
          </Button>
        </div>
      )}
    >
      {confirmation}
      <section className="mobile-action-identity">
        <span className="mobile-action-identity-icon"><WalletOutlined /></span>
        <div className="mobile-action-identity-copy">
          <span>{target.businessType === 'fixed_bill' ? '固定账单' : '动态账单'}</span>
          <strong>{target.name}</strong>
        </div>
        <Tag color={target.paidStatus === 'paid' ? 'green' : undefined}>
          {target.paidStatus === 'paid' ? '已还清' : '待还'}
        </Tag>
      </section>

      <section className="mobile-action-surface mobile-payment-entry">
        {target.paidStatus === 'paid' ? (
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            恢复后会重新进入待还账单。
          </Typography.Paragraph>
        ) : target.businessType === 'dynamic_bill' ? (
          <>
            <label htmlFor="mobile-custom-bill-amount">本期账单金额</label>
            <InputNumber
              id="mobile-custom-bill-amount"
              size="large"
              min={0}
              max={99_999_999}
              precision={2}
              controls={false}
              inputMode="decimal"
              prefix={currencyPrefix(currency)}
              value={amount}
              onChange={setAmount}
            />
          </>
        ) : (
          <div className="mobile-payment-summary">
            <div><span>本期金额</span><strong>{money(target.amount, currency)}</strong></div>
          </div>
        )}
      </section>
    </MobileFlow>
  );
}

/** 手机专用信用卡还款流程：使用纵向触控操作与逐步录入。 */
function MobileCardMarkPaidFlow({
  target,
  onClose,
  onDone,
}: {
  target: MarkPaidTarget;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const hasBill = target.billId != null;
  const currency = target.currency ?? 'CNY';
  const [step, setStep] = useState<MobilePaymentStep>('choose');
  const [action, setAction] = useState<MobilePaymentAction | null>(null);
  const [totalAmount, setTotalAmount] = useState<number | null>(hasBill ? target.amount ?? null : null);
  const [paidAmount, setPaidAmount] = useState<number | null>(hasBill ? currentPaid(target) : null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { requestExit, confirmation } = useUnsavedExit(totalAmount !== (hasBill ? target.amount ?? null : null)
    || paidAmount !== (hasBill ? currentPaid(target) : null), onClose, saving);

  useEffect(() => {
    setStep('choose');
    setAction(null);
    setTotalAmount(target.billId != null ? target.amount ?? null : null);
    setPaidAmount(target.billId != null ? currentPaid(target) : null);
  }, [target]);

  const existingPaid = currentPaid(target);
  const existingRemaining = target.amount == null
    ? null
    : Math.max(0, target.amount - existingPaid);

  const goBack = () => {
    if (saving) return;
    if (step !== 'choose') {
      setStep('choose');
      setAction(null);
      return;
    }
    requestExit();
  };

  const choose = (next: MobilePaymentAction) => {
    if (saving) return;
    setAction(next);
    if (next === 'partial' || (!hasBill && next === 'full')) {
      setStep('amount');
    } else {
      setStep('confirm');
    }
  };

  const validate = () => {
    if (action === 'partial') {
      if (paidAmount == null || !Number.isFinite(paidAmount) || paidAmount <= 0) {
        message.warning('请输入大于 0 的累计已还金额');
        return false;
      }
      if (!hasBill) {
        if (totalAmount == null || !Number.isFinite(totalAmount) || totalAmount <= 0) {
          message.warning('请输入大于 0 的账单总额');
          return false;
        }
        if (paidAmount >= totalAmount) {
          message.warning('累计已还金额应小于账单总额；已结清请返回选择“已全部还清”');
          return false;
        }
      }
    }
    if (!hasBill && action === 'full'
      && (totalAmount == null || !Number.isFinite(totalAmount) || totalAmount < 0)) {
      message.warning('请输入账单总额');
      return false;
    }
    return true;
  };

  const submit = async () => {
    if (!action || savingRef.current || !validate()) return;
    savingRef.current = true; setSaving(true);
    try {
      if (hasBill) {
        if (action === 'full') {
          await api.put(`/api/bills/${target.billId}/paid`, { action: 'full' });
          message.success('已登记全部还清');
        } else if (action === 'unpaid') {
          await api.put(`/api/bills/${target.billId}/paid`, { action: 'unpaid' });
          message.success('已恢复待还');
        } else {
          const paid = paidAmount ?? 0;
          if (target.amount != null && paid >= target.amount) {
            await api.put(`/api/bills/${target.billId}/paid`, { action: 'full' });
            message.success('已登记全部还清');
          } else {
            await api.put(`/api/bills/${target.billId}/paid`, { action: 'partial', paidAmount: paid });
            message.success(
              target.minAmount != null && paid >= target.minAmount
                ? '已登记最低还款'
                : '已更新累计已还金额',
            );
          }
        }
      } else if (action === 'none') {
        await api.post('/api/bills/mark', {
          cardId: target.cardId,
          period: target.period,
          currency,
          mode: 'none',
        });
        message.success('已登记本期无需还款');
      } else if (action === 'full') {
        await api.post('/api/bills/mark', {
          cardId: target.cardId,
          period: target.period,
          currency,
          mode: 'full',
          amount: totalAmount,
        });
        message.success('已登记全部还清');
      } else {
        await api.post('/api/bills/mark', {
          cardId: target.cardId,
          period: target.period,
          currency,
          mode: 'partial',
          amount: totalAmount,
          paidAmount,
        });
        message.success('已登记部分还款');
      }
      onDone();
      onClose();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const currentStatus = target.paidStatus === 'paid'
    ? { label: '已还清', color: 'green' }
    : statusPreview(
        hasBill ? target.amount ?? null : null,
        hasBill ? existingPaid : 0,
        target.minAmount,
      );
  const entryTotal = hasBill ? target.amount ?? null : totalAmount;
  const entryPaid = action === 'full' && !hasBill ? totalAmount ?? 0 : paidAmount ?? 0;
  const entryRemaining = entryTotal == null ? null : Math.max(0, entryTotal - entryPaid);
  const entryStatus = statusPreview(entryTotal, entryPaid, target.minAmount);

  const fullTitle = hasBill && existingRemaining != null && existingPaid > 0
    ? `还清剩余 ${money(existingRemaining, currency)}`
    : '全部还清';

  const confirmCopy = action === 'full'
    ? (hasBill
      ? `确认将本期剩余 ${money(existingRemaining, currency)} 登记为已还清。`
      : `确认本期账单总额为 ${money(totalAmount, currency)}，并登记为已还清。`)
    : action === 'unpaid'
      ? '确认清除本期已还记录，并恢复为待还状态。'
      : `确认本期无需还款，账单金额将记为 ${formatMoney(0, currency)}。`;

  const footer = step === 'choose' ? undefined : (
    <div className="mobile-flow-action-row">
      <Button block disabled={saving} onClick={goBack}>上一步</Button>
      <Button
        type="primary"
        block
        disabled={saving}
        loading={saving}
        onClick={submit}
      >
        {step === 'amount' ? '保存还款' : action === 'unpaid' ? '确认恢复' : '确认登记'}
      </Button>
    </div>
  );

  return (
    <MobileFlow
      title={step === 'choose' ? '登记还款' : step === 'amount' ? '填写还款金额' : '确认还款'}
      onBack={goBack}
      className="mobile-payment-flow"
      footer={footer}
    >
      {confirmation}
      <section className="mobile-action-identity">
        <span className="mobile-action-identity-icon"><WalletOutlined /></span>
        <div className="mobile-action-identity-copy">
          <span>{displayPeriod(target.period)} · {currency} · 尾号 {target.cardLast4}</span>
          <strong>{target.bankName}</strong>
        </div>
        <Tag color={hasBill ? currentStatus.color : undefined}>
          {hasBill ? currentStatus.label : '未取得账单'}
        </Tag>
      </section>

      {hasBill && (
        <section className="mobile-payment-summary" aria-label="本期还款概览">
          <div><span>本期还需</span><strong>{money(existingRemaining, currency)}</strong></div>
          <div><span>最低还款</span><strong>{target.minAmount == null ? '—' : money(target.minAmount, currency)}</strong></div>
        </section>
      )}

      {step === 'choose' ? (
        <section className="mobile-payment-actions" aria-label="选择还款操作">
          <div className="mobile-action-section-heading">
            <div>
              <strong>还款情况</strong>
            </div>
          </div>
          <MobileList mode="card" className="mobile-payment-action-list">
            {hasBill ? (
              <>
                {target.paidStatus !== 'paid' && (
                  <MobileList.Item
                    clickable
                    arrowIcon
                    prefix={<span className="mobile-payment-action-icon is-full"><CheckCircleOutlined /></span>}
                    description={existingRemaining == null ? '将本期账单登记为已结清' : `登记本期剩余 ${money(existingRemaining, currency)}`}
                    onClick={() => choose('full')}
                  >
                    {fullTitle}
                  </MobileList.Item>
                )}
                <MobileList.Item
                  clickable
                  arrowIcon
                  prefix={<span className="mobile-payment-action-icon is-partial"><EditOutlined /></span>}
                  description="填写截至目前的累计已还金额"
                  onClick={() => choose('partial')}
                >
                  {target.paidStatus === 'partial' || target.paidStatus === 'paid'
                    ? '更正累计已还金额'
                    : '记录部分还款'}
                </MobileList.Item>
                {(target.paidStatus === 'partial' || target.paidStatus === 'paid' || existingPaid > 0) && (
                  <MobileList.Item
                    clickable
                    arrowIcon
                    prefix={<span className="mobile-payment-action-icon is-unpaid"><UndoOutlined /></span>}
                    description="清除已还记录，恢复为待还"
                    onClick={() => choose('unpaid')}
                  >
                    恢复待还
                  </MobileList.Item>
                )}
              </>
            ) : (
              <>
                <MobileList.Item
                  clickable
                  arrowIcon
                  prefix={<span className="mobile-payment-action-icon is-none"><MinusCircleOutlined /></span>}
                  description="本期没有需要归还的金额"
                  onClick={() => choose('none')}
                >
                  本期无需还款
                </MobileList.Item>
                <MobileList.Item
                  clickable
                  arrowIcon
                  prefix={<span className="mobile-payment-action-icon is-full"><CheckCircleOutlined /></span>}
                  description="填写账单总额并登记为已结清"
                  onClick={() => choose('full')}
                >
                  已全部还清
                </MobileList.Item>
                <MobileList.Item
                  clickable
                  arrowIcon
                  prefix={<span className="mobile-payment-action-icon is-partial"><EditOutlined /></span>}
                  description="填写账单总额与累计已还金额"
                  onClick={() => choose('partial')}
                >
                  已还一部分
                </MobileList.Item>
              </>
            )}
          </MobileList>
        </section>
      ) : step === 'amount' ? (
        <section className="mobile-action-surface mobile-payment-entry">
          <div className="mobile-action-section-heading">
            <div>
              <strong>{hasBill ? '更新累计已还金额' : action === 'full' ? '补充账单总额' : '补充本期金额'}</strong>
              <span>{hasBill ? '填写截至目前已经归还的总金额' : '金额应与银行实际账单和还款记录一致'}</span>
            </div>
          </div>

          {!hasBill && (
            <>
              <label htmlFor="mobile-total-amount">账单总额</label>
              <InputNumber
                id="mobile-total-amount"
                aria-label="账单总额"
                size="large"
                min={0}
                max={99_999_999}
                precision={2}
                controls={false}
                inputMode="decimal"
                prefix={currencyPrefix(currency)}
                value={totalAmount}
                onChange={setTotalAmount}
              />
            </>
          )}

          {action === 'partial' && (
            <>
              <label htmlFor="mobile-paid-amount">累计已还金额</label>
              <InputNumber
                id="mobile-paid-amount"
                aria-label="累计已还金额"
                size="large"
                min={0}
                max={99_999_999}
                precision={2}
                controls={false}
                inputMode="decimal"
                prefix={currencyPrefix(currency)}
                value={paidAmount}
                onChange={setPaidAmount}
              />
              {target.minAmount != null && (entryTotal == null || target.minAmount < entryTotal) && (
                <div className="mobile-payment-quick-actions mobile-payment-quick-actions-single">
                  <Button disabled={saving} onClick={() => setPaidAmount(target.minAmount ?? 0)}>
                    填入最低还款 {money(target.minAmount, currency)}
                  </Button>
                </div>
              )}
            </>
          )}

          <section className="mobile-payment-preview" aria-live="polite">
            <div><span>保存后待还</span><strong>{entryRemaining == null ? '金额未知' : money(entryRemaining, currency)}</strong></div>
            <Tag color={entryStatus.color}>{entryStatus.label}</Tag>
          </section>
        </section>
      ) : (
        <section className={`mobile-payment-confirm is-${action ?? 'none'}`}>
          <div className="mobile-payment-confirm-icon">
            {action === 'unpaid' ? <UndoOutlined /> : action === 'none' ? <MinusCircleOutlined /> : <CheckCircleOutlined />}
          </div>
          <Typography.Title level={4}>
            {action === 'unpaid' ? '恢复待还' : action === 'none' ? '本期无需还款' : '登记全部还清'}
          </Typography.Title>
          <Typography.Paragraph>{confirmCopy}</Typography.Paragraph>
        </section>
      )}
    </MobileFlow>
  );
}

export default function MobileMarkPaidFlow(props: {
  target: MarkPaidTarget;
  onClose: () => void;
  onDone: () => void;
}) {
  return props.target.targetType === 'custom'
    ? <MobileCustomBillFlow {...props} />
    : <MobileCardMarkPaidFlow {...props} />;
}
