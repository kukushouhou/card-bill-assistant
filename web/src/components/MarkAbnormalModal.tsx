import { useEffect, useRef, useState } from 'react';
import {
  CheckCircleOutlined,
  CreditCardOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  UndoOutlined,
} from '../skins/icons';
import { App, Button, Modal, Radio, Tag, Typography } from 'antd';
import { List as MobileList } from 'antd-mobile';
import { api, ApiError } from '../api/client';
import { useResponsive, useResetOnModeChange } from '../responsive';
import { MobileFlow } from './MobilePrimitives';
import './mobile-action-flows.css';

export type CardStatus = 'active' | 'frozen' | 'closed';

/** 标记异常目标：账单页和卡片页共用，手机与电脑各自渲染独立交互。 */
export interface MarkAbnormalTarget {
  cardId: number;
  bankName: string;
  cardLast4: string;
  status: CardStatus;
}

type Choice = CardStatus;
type MobileStep = 'choose' | 'confirm';

const STATUS_LABEL: Record<CardStatus, string> = {
  active: '正常使用',
  frozen: '已冻结',
  closed: '已注销',
};

const ACTION_COPY: Record<Choice, {
  title: string;
  shortDescription: string;
  reversibility: string;
  confirmation: string;
  confirmText: string;
}> = {
  active: {
    title: '恢复正常使用',
    shortDescription: '结束暂停，恢复账期管理和提醒',
    reversibility: '恢复使用',
    confirmation: '恢复后，重新启用账期管理和到期提醒。',
    confirmText: '确认恢复',
  },
  frozen: {
    title: '冻结卡片',
    shortDescription: '暂停使用',
    reversibility: '可恢复',
    confirmation: '冻结后暂停生成“未取得账单”和未来提醒；已有账单与还款记录继续保留。之后可从“标记异常”恢复正常使用。',
    confirmText: '确认冻结',
  },
  closed: {
    title: '注销卡片',
    shortDescription: '停止账期管理和提醒',
    reversibility: '永久停止',
    confirmation: '注销后停止生成“未取得账单”和未来提醒；已有账单与还款记录继续保留。误标时可从“标记异常”撤销注销。',
    confirmText: '确认注销',
  },
};

const RESTORE_CLOSED_COPY = {
  title: '撤销注销',
  shortDescription: '误标时恢复为正常使用',
  reversibility: '恢复使用',
  confirmation: '撤销注销后，卡片恢复为正常使用，并重新启用账期管理和到期提醒。',
  confirmText: '确认撤销',
};

function actionCopy(choice: Choice, currentStatus: CardStatus) {
  if (choice === 'active' && currentStatus === 'closed') return RESTORE_CLOSED_COPY;
  return ACTION_COPY[choice];
}

function availableChoices(status: CardStatus): Choice[] {
  if (status === 'frozen') return ['active', 'closed'];
  if (status === 'closed') return ['active'];
  return ['frozen', 'closed'];
}

function actionIcon(choice: Choice) {
  if (choice === 'active') return <UndoOutlined />;
  if (choice === 'frozen') return <PauseCircleOutlined />;
  return <DeleteOutlined />;
}

/**
 * 标记异常流程：桌面端保留弹窗，手机端使用独立的全屏“选择操作 → 页内确认”流程。
 */
export default function MarkAbnormalModal({
  target,
  onClose,
  onDone,
}: {
  target: MarkAbnormalTarget | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [mobileStep, setMobileStep] = useState<MobileStep>('choose');
  const [saving, setSaving] = useState(false);
  const reqGen = useRef(0);

  useResetOnModeChange(() => {
    // 未提交的危险操作在跨断点时清除；已经发出的写请求仍由当前组件接管结果。
    if (!saving) reqGen.current += 1;
    setChoice(null);
    setMobileStep('choose');
  });

  useEffect(() => {
    setChoice(null);
    setMobileStep('choose');
  }, [target]);

  if (!target) return null;

  const currentStatus = target.status;
  const choices = availableChoices(currentStatus);

  const dismiss = () => {
    if (saving) return;
    reqGen.current += 1;
    onClose();
  };

  const goBack = () => {
    if (saving) return;
    if (isMobile && mobileStep === 'confirm') {
      setChoice(null);
      setMobileStep('choose');
      return;
    }
    dismiss();
  };

  const chooseMobileAction = (next: Choice) => {
    if (saving) return;
    setChoice(next);
    setMobileStep('confirm');
  };

  const submit = async () => {
    if (!target || choice == null || saving) return;
    const gen = reqGen.current;
    setSaving(true);
    try {
      await api.put(`/api/cards/${target.cardId}`, { status: choice });
      if (gen !== reqGen.current) return;
      const action = choice === 'active'
        ? currentStatus === 'closed' ? '撤销注销并恢复正常使用' : '恢复正常使用'
        : choice === 'frozen' ? '冻结' : '注销';
      message.success(`已将该卡（${target.bankName} ${target.cardLast4}）${action}`);
      onDone();
      onClose();
    } catch (err) {
      if (gen !== reqGen.current) return;
      message.error(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      if (gen === reqGen.current) setSaving(false);
    }
  };

  if (isMobile) {
    const selectedCopy = choice == null ? null : actionCopy(choice, currentStatus);
    return (
      <MobileFlow
        title={mobileStep === 'choose' ? '标记异常' : selectedCopy?.title ?? '确认操作'}
        onBack={goBack}
        className="mobile-status-flow"
        footer={mobileStep === 'confirm' && selectedCopy ? (
          <div className="mobile-flow-action-row">
            <Button block disabled={saving} onClick={goBack}>上一步</Button>
            <Button
              type="primary"
              danger={choice === 'closed'}
              block
              disabled={saving}
              loading={saving}
              onClick={submit}
            >
              {selectedCopy.confirmText}
            </Button>
          </div>
        ) : undefined}
      >
        <section className="mobile-action-identity">
          <span className="mobile-action-identity-icon"><CreditCardOutlined /></span>
          <div className="mobile-action-identity-copy">
            <span>卡片尾号 {target.cardLast4}</span>
            <strong>{target.bankName}</strong>
          </div>
          <Tag color={currentStatus === 'active' ? 'green' : currentStatus === 'frozen' ? 'orange' : undefined}>
            {STATUS_LABEL[currentStatus]}
          </Tag>
        </section>

        {mobileStep === 'choose' ? (
          <section className="mobile-status-actions" aria-label="选择卡片操作">
            <div className="mobile-action-section-heading">
              <div>
                <strong>你想对这张卡做什么？</strong>
                <span>选择后会先展示影响范围，不会立即修改</span>
              </div>
            </div>
            {choices.length > 0 ? (
              <MobileList mode="card" className="mobile-status-action-list">
                {choices.map((item) => {
                  const copy = actionCopy(item, currentStatus);
                  return (
                    <MobileList.Item
                      key={item}
                      clickable
                      arrowIcon
                      prefix={<span className={`mobile-status-action-icon is-${item}`}>{actionIcon(item)}</span>}
                      description={copy.shortDescription}
                      onClick={() => chooseMobileAction(item)}
                    >
                      <span className="mobile-status-action-title">
                        <span className={item === 'closed' ? 'mobile-status-danger-text' : undefined}>
                          {copy.title}
                        </span>
                        <Tag color={item === 'active' ? 'green' : item === 'frozen' ? 'orange' : 'red'}>
                          {copy.reversibility}
                        </Tag>
                      </span>
                    </MobileList.Item>
                  );
                })}
              </MobileList>
            ) : (
              <div className="mobile-action-surface mobile-status-terminal">
                <CheckCircleOutlined />
                <div>
                  <strong>这张卡已注销</strong>
                  <span>误标时可撤销注销</span>
                </div>
              </div>
            )}
          </section>
        ) : selectedCopy && choice ? (
          <section className={`mobile-status-confirm is-${choice}`}>
            <div className="mobile-status-confirm-icon">{actionIcon(choice)}</div>
            <Typography.Title level={4}>{selectedCopy.title}</Typography.Title>
            <Tag
              className="mobile-status-reversibility"
              color={choice === 'active' ? 'green' : choice === 'frozen' ? 'orange' : 'red'}
            >
              {choice === 'frozen'
                ? '暂停使用 · 可恢复'
                : choice === 'closed'
                  ? '永久停止'
                  : currentStatus === 'closed'
                    ? '撤销注销 · 恢复使用'
                    : selectedCopy.reversibility}
            </Tag>
            <Typography.Paragraph>{selectedCopy.confirmation}</Typography.Paragraph>
            <div className="mobile-status-impact-list">
              <div><CheckCircleOutlined /><span>卡片档案继续保留</span></div>
              <div><CheckCircleOutlined /><span>历史账单与还款记录继续保留</span></div>
              {choice === 'active' && (
                <>
                  {currentStatus === 'closed' && (
                    <div><UndoOutlined /><span>撤销注销标记</span></div>
                  )}
                  <div><UndoOutlined /><span>恢复账期管理和未来提醒</span></div>
                </>
              )}
              {choice === 'frozen' && (
                <>
                  <div><PauseCircleOutlined /><span>暂时停止生成“未取得账单”和未来提醒</span></div>
                  <div><UndoOutlined /><span>可在“标记异常”流程恢复正常使用</span></div>
                </>
              )}
              {choice === 'closed' && (
                <>
                  <div><PauseCircleOutlined /><span>永久停止生成“未取得账单”和未来提醒</span></div>
                  <div><UndoOutlined /><span>误标时可从“标记异常”撤销注销</span></div>
                </>
              )}
            </div>
          </section>
        ) : null}
      </MobileFlow>
    );
  }

  const content = choices.length === 0 ? (
    <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
      该卡已注销；误标时可撤销注销。
    </Typography.Paragraph>
  ) : (
    <>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        当前状态：{STATUS_LABEL[currentStatus]}。请选择要执行的操作：
      </Typography.Paragraph>
      <Radio.Group
        className="choice-card-group"
        aria-label="选择异常处理方式"
        value={choice ?? undefined}
        disabled={saving}
        onChange={(event) => setChoice(event.target.value as Choice)}
      >
        {choices.map((item) => {
          const copy = actionCopy(item, currentStatus);
          return (
            <Radio.Button key={item} value={item} disabled={saving}>
              <span className="desktop-status-action-title">
                <Typography.Text strong={choice === item} style={{ fontSize: 15 }}>
                  {copy.title}
                </Typography.Text>
                <Tag color={item === 'active' ? 'green' : item === 'frozen' ? 'orange' : 'red'}>
                  {copy.reversibility}
                </Tag>
              </span>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0, marginTop: 6 }}>
                {copy.shortDescription}
              </Typography.Paragraph>
            </Radio.Button>
          );
        })}
      </Radio.Group>
      {choice && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
          {actionCopy(choice, currentStatus).confirmation}
        </Typography.Text>
      )}
    </>
  );

  return (
    <Modal
      title={`标记异常 — ${target.bankName}（${target.cardLast4}）`}
      open
      onCancel={dismiss}
      footer={(
        <>
          <Button disabled={saving} onClick={dismiss}>取消</Button>
          {choices.length > 0 && (
            <Button
              type="primary"
              danger={choice === 'closed'}
              disabled={choice == null}
              loading={saving}
              onClick={submit}
            >
              {choice == null ? '确定' : actionCopy(choice, currentStatus).confirmText}
            </Button>
          )}
        </>
      )}
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
