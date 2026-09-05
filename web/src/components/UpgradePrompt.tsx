import { useResponsive } from '../responsive';
import { App, Button, List, Modal, Progress, Space, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { UpgradeMigrationMode, UpgradePlan, UpgradeTask } from '../api/types';

export function migrationModeText(mode: UpgradeMigrationMode): string {
  if (mode === 'required') return '必选迁移';
  if (mode === 'optional') return '可选迁移';
  return '静默迁移';
}
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
  const [plan, setPlan] = useState<UpgradePlan | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const hadExecution = useRef(false);

  const load = async () => {
    const next = await api.get<UpgradePlan | null>('/api/upgrades');
    if (!next && hadExecution.current) {
      hadExecution.current = false;
      message.success('系统升级已完成');
    }
    if (next?.status === 'executing') hadExecution.current = true;
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

  if (!plan) return null;
  const executing = plan.status === 'executing';
  const activeTask = plan.tasks.find((task) => task.status === 'running');
  const total = plan.tasks.reduce((sum, task) => sum + task.total, 0);
  const processed = plan.tasks.reduce((sum, task) => sum + task.processed, 0);
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  const decide = async (task: UpgradeTask, action: 'approve' | 'ignore') => {
    setBusyKey(task.key);
    try {
      const next = await api.post<UpgradePlan>(`/api/upgrades/${encodeURIComponent(task.key)}/${action}`);
      if (next.status === 'executing') hadExecution.current = true;
      setPlan(next);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '升级操作失败，请重试');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Modal open width={isMobile ? '100vw' : 'min(820px, 94vw)'} className={isMobile ? 'mobile-upgrade-flow' : undefined} style={isMobile ? { top: 0, maxWidth: '100vw', paddingBottom: 0 } : undefined} title={`系统升级 ${plan.fromVersion ?? '旧版本'} → ${plan.toVersion}`}
      closable={false} maskClosable={false} keyboard={false} footer={null}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {plan.hasRequired && (
          <Typography.Text type="warning">
            本次升级包含必选迁移。全部迁移完成前，邮件同步、业务更新和提醒推送已暂停。
          </Typography.Text>
        )}
        {!plan.hasRequired && plan.status === 'awaiting_decision' && (
          <Typography.Text type="secondary">
            迁移尚未开始；等待决定期间，邮件同步和提醒推送保持正常。
          </Typography.Text>
        )}
        {plan.error && <Typography.Text type="danger">{plan.error}</Typography.Text>}
        {executing && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text>{activeTask ? `正在执行：${activeTask.title}` : '正在执行升级迁移'}</Typography.Text>
            <Progress percent={percent} status="active" />
          </Space>
        )}
        <List bordered dataSource={plan.migrations} renderItem={(migration) => {
          const task = plan.tasks.find((candidate) => candidate.key === migration.key);
          const statusText = task ? taskStatusText(task) : null;
          const actionable = task && ['awaiting_decision', 'failed'].includes(task.status) && !executing;
          const actions = actionable ? [
            ...(task.mode === 'optional' ? [(
              <Button key="ignore" danger disabled={busyKey != null} onClick={() => void decide(task, 'ignore')}>
                {task.ignoreLabel ?? '忽略迁移'}
              </Button>
            )] : []),
            <Button key="approve" type="primary" loading={busyKey === task.key}
              disabled={busyKey != null && busyKey !== task.key} onClick={() => void decide(task, 'approve')}>
              {task.status === 'failed' ? '重新执行' : task.executeLabel}
            </Button>,
          ] : undefined;
          return (
            <List.Item actions={actions}>
              <List.Item.Meta
                title={<Space wrap><span>{migration.title}</span>
                  <Tag color={migration.mode === 'required' ? 'red' : migration.mode === 'optional' ? 'blue' : 'default'}>
                    {migrationModeText(migration.mode)}
                  </Tag>{statusText && <Tag>{statusText}</Tag>}</Space>}
                description={<Space direction="vertical" size={4}>
                  <Typography.Text type="secondary">{migration.description}</Typography.Text>
                  {task?.status === 'failed' && task.error && <Typography.Text type="danger">{task.error}</Typography.Text>}
                </Space>}
              />
            </List.Item>
          );
        }} />
        {plan.tasks.some((task) => task.mode === 'optional' && task.status === 'awaiting_decision') && (
          <Typography.Text type="secondary">
            忽略后，本次数据更新将不再提供执行入口。
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
}
