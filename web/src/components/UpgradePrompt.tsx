import { useResponsive } from '../responsive';
import { App, Button, Modal, Progress, Segmented, theme } from 'antd';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api/client';
import type { OverdueBasis, UpgradePlan, UpgradeTask, StatementRepairResult } from '../api/types';
import OverdueBasisRadio from './OverdueBasisRadio';
import UpgradeResultSummary from './UpgradeResultSummary';
import UpgradeMailboxSettings from './UpgradeMailboxSettings';
import { ExclamationCircleFilled, LockOutlined } from '../skins/icons';
import { notifyDataChanged } from '../lib/dataChanged';
import './upgrade-prompt.css';

function taskStatusText(task: UpgradeTask): string | null {
  if (task.status === 'approved') return '已确认';
  if (task.status === 'ignored') return '已忽略';
  if (task.status === 'completed') return '已完成';
  if (task.status === 'running') return '执行中';
  return null;
}

export default function UpgradePrompt() {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const { token } = theme.useToken();
  const [plan, setPlan] = useState<UpgradePlan | null>(null);
  const [result, setResult] = useState<StatementRepairResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [choices, setChoices] = useState<Record<string, 'approve' | 'ignore'>>({});
  const [noticeBasis, setNoticeBasis] = useState<Record<string, OverdueBasis>>({});
  const [mailboxSettingsOpen, setMailboxSettingsOpen] = useState(false);
  const hadExecution = useRef(false);

  const showResult = async () => {
    // 升级迁移可能改写了账单、卡片等业务数据，挂载中的页面必须重新加载。
    notifyDataChanged();
    const report = await api.get<StatementRepairResult | null>('/api/upgrades/latest-result').catch(() => null);
    if (report?.counts) setResult(report);
    else message.success('系统升级已完成');
  };

  const load = async () => {
    const next = await api.get<UpgradePlan | null>('/api/upgrades');
    if (!next && hadExecution.current) {
      hadExecution.current = false;
      await showResult();
    }
    if (next?.status === 'executing' && next.migrations.some((migration) => migration.mode !== 'silent')) {
      hadExecution.current = true;
    }
    setPlan(next);
  };

  useEffect(() => {
    void load().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (plan?.status !== 'executing') return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 1500);
    return () => window.clearInterval(timer);
  }, [plan?.status]);

  // 明确邮箱不可用时直接在原迁移流程内修复；取消只返回迁移选择，不另设常驻重试入口。
  useEffect(() => {
    if (plan?.status === 'failed' && plan.mailboxFailures?.length) {
      setMailboxSettingsOpen(true);
    }
  }, [plan]);

  // 静默项目只参与后台协调，不展示项目、进度弹窗或完成提示。
  const visibleMigrations = plan?.migrations.filter((migration) => migration.mode !== 'silent') ?? [];
  if (!plan || visibleMigrations.length === 0) return result ? <Modal key="upgrade-result" open title="系统升级结果" onCancel={() => setResult(null)}
    footer={<Button type="primary" onClick={() => setResult(null)}>完成</Button>}><UpgradeResultSummary result={result} /></Modal> : null;
  const executing = plan.status === 'executing';
  const failed = plan.status === 'failed';
  const pendingTasks = plan.tasks.filter((task) => ['awaiting_decision', 'failed'].includes(task.status));
  const hasIgnoredChoices = pendingTasks.some((task) => task.mode === 'optional' && choices[task.key] === 'ignore');
  const activeTask = plan.tasks.find((task) => task.status === 'running');
  const total = plan.tasks.reduce((sum, task) => sum + task.total, 0);
  const processed = plan.tasks.reduce((sum, task) => sum + task.processed, 0);
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const standaloneError = plan.error && !plan.tasks.some((task) => task.error === plan.error);

  const confirm = async () => {
    setSubmitting(true);
    try {
      // notice 项不迁移数据：确认前先把弹窗内选择的新选项值保存为系统设置。
      for (const task of pendingTasks) {
        if (task.mode !== 'notice') continue;
        await api.put('/api/settings/overdue-basis', { basis: noticeBasis[task.key] ?? 'all' });
      }
      const next = await api.post<UpgradePlan | null>('/api/upgrades/decisions', {
        planId: plan.id,
        decisions: pendingTasks.map((task) => ({
          key: task.key,
          action: task.mode === 'required' ? 'approve' : choices[task.key] ?? 'approve',
        })),
      });
      if (!next) await showResult();
      hadExecution.current = next?.status === 'executing';
      setChoices({});
      setNoticeBasis({});
      setPlan(next);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '升级操作失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  if (mailboxSettingsOpen && plan.mailboxFailures?.length) return <UpgradeMailboxSettings key={plan.id}
    accounts={plan.mailboxFailures} onClose={() => setMailboxSettingsOpen(false)} />;

  return (
    <Modal key="upgrade-plan" open width={isMobile ? '100vw' : 'min(860px, 94vw)'}
      className={`upgrade-flow${isMobile ? ' mobile-upgrade-flow' : ''}`}
      style={isMobile ? { top: 0, maxWidth: '100vw', paddingBottom: 0 } : { top: 64 }}
      title={<div className="upgrade-heading"><span>系统升级</span><span className="upgrade-version">{plan.fromVersion ?? '旧版本'} → {plan.toVersion}</span></div>}
      closable={false} maskClosable={false} keyboard={false}
      footer={!executing && pendingTasks.length > 0 ? (<>
        {failed && !!plan.mailboxFailures?.length && <Button disabled={submitting} onClick={() => setMailboxSettingsOpen(true)}>设置邮箱</Button>}
        <Button type="primary" block={isMobile} loading={submitting} onClick={() => void confirm()}>
          {failed && !hasIgnoredChoices ? '重试' : '确认并继续'}
        </Button>
      </>) : null}>
      <div className="upgrade-plan">
        {plan.hasRequired && !failed && (
          <div className="upgrade-gate-notice" role="status">
            <LockOutlined aria-hidden />
            <span>编辑、邮件同步和日常提醒已暂停，完成更新后恢复。</span>
          </div>
        )}
        {standaloneError && <div className="upgrade-error" role="alert"><ExclamationCircleFilled aria-hidden /><span>{plan.error}</span></div>}
        {executing && (
          <div className="upgrade-progress">
            <span>{activeTask ? `正在更新：${activeTask.title}` : '正在更新'}</span>
            <Progress percent={percent} status="active" />
          </div>
        )}
        <div className="upgrade-items" role="list">{visibleMigrations.map((migration) => {
          const task = plan.tasks.find((candidate) => candidate.key === migration.key);
          const statusText = task ? taskStatusText(task) : null;
          const actionable = task && ['awaiting_decision', 'failed'].includes(task.status) && !executing;
          const ignoring = actionable && task.mode === 'optional' && choices[task.key] === 'ignore';
          const warningId = `upgrade-ignore-${plan.id}-${migration.key}`;
          return (
            <section key={migration.key} className="upgrade-item" role="listitem" aria-labelledby={`upgrade-title-${migration.key}`}>
              <h3 className="upgrade-item-title" id={`upgrade-title-${migration.key}`}>{migration.title}</h3>
              <p className="upgrade-item-description">{migration.description}</p>
              <div className="upgrade-item-scope">
                {migration.mode === 'optional' && <span className="upgrade-optional">可选更新</span>}
                {migration.mode === 'notice' && <span className="upgrade-optional">新选项</span>}
                {migration.summary && <span>{migration.summary}</span>}
              </div>
              {actionable && task.mode === 'notice' && (
                <div className="upgrade-item-notice-option">
                  <OverdueBasisRadio
                    value={noticeBasis[task.key] ?? 'all'}
                    disabled={submitting}
                    onChange={(value) => setNoticeBasis((current) => ({ ...current, [task.key]: value }))}
                    name={`upgrade-overdue-${plan.id}-${task.key}`}
                  />
                </div>
              )}
              <div className="upgrade-item-action">
              {actionable && task.mode === 'optional' && (
                <Segmented<'approve' | 'ignore'> block motionName=""
                  className={`upgrade-decision${choices[task.key] === 'ignore' ? '' : ' upgrade-decision-recommended'}`}
                  style={{ '--upgrade-primary-ink': token.colorTextLightSolid } as CSSProperties}
                  name={`upgrade-choice-${plan.id}-${task.key}`}
                  aria-label={migration.title} value={choices[task.key] ?? 'approve'} disabled={submitting}
                  aria-describedby={ignoring ? warningId : undefined}
                  options={[
                    { value: 'ignore', label: '忽略' },
                    { value: 'approve', label: '执行' },
                  ]}
                  onChange={(value) => setChoices((current) => ({ ...current, [task.key]: value }))} />
              )}
              {statusText && <span className="upgrade-status">{statusText}</span>}
              {!statusText && migration.mode === 'required' && <span className="upgrade-fixed-action"><LockOutlined aria-hidden />必须更新</span>}
              </div>
              {task?.status === 'failed' && task.error && <div className="upgrade-error" role="alert"><ExclamationCircleFilled aria-hidden /><span>{task.error}</span></div>}
              {ignoring && (
                <div id={warningId} className="upgrade-ignore-warning" role="alert">
                  <ExclamationCircleFilled aria-hidden />
                  <span>{task.status === 'failed' && task.succeeded > 0 && '已经完成的修改会保留。'}{task.ignoreWarning
                    ?? '系统将不再提供本次迁移服务。'}</span>
                </div>
              )}
            </section>
          );
        })}</div>
      </div>
    </Modal>
  );
}
