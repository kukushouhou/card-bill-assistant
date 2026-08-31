import { App, Button, Modal, Progress, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { UpgradeTask } from '../api/types';

export function bankText(banks: string[]): string {
  if (banks.length <= 1) return banks[0] ?? '';
  if (banks.length === 2) return `${banks[0]}和${banks[1]}`;
  return `${banks.slice(0, -1).join('、')}和${banks.at(-1)}`;
}

export function upgradePromptText(banks: string[]): string {
  return `系统检测到你已有${bankText(banks)}的历史账单。本次更新可以更准确地识别这些账单中的主卡、副卡、附属卡和手机信用卡，减少重复账单和还款提醒。你是否要现在更新这些历史账单？`;
}

export default function UpgradePrompt() {
  const { message } = App.useApp();
  const [task, setTask] = useState<UpgradeTask | null>(null);
  const [busy, setBusy] = useState(false);
  const hadRunning = useRef(false);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const next = await api.get<UpgradeTask | null>('/api/upgrades');
        if (stopped) return;
        if (!next && hadRunning.current) {
          hadRunning.current = false;
          message.success('系统已更新历史账单');
        }
        if (next?.status === 'running') hadRunning.current = true;
        setTask(next);
      } catch {
        // 启动读取失败不阻断用户进入系统；下次页面刷新会重新读取。
      }
    };
    void load();
    return () => {
      stopped = true;
    };
  }, [message]);

  useEffect(() => {
    if (task?.status !== 'running') return;
    const timer = window.setInterval(() => {
      void api.get<UpgradeTask | null>('/api/upgrades').then((next) => {
        if (!next && hadRunning.current) {
          hadRunning.current = false;
          message.success('系统已更新历史账单');
        }
        setTask(next);
      }).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [message, task?.status]);

  if (!task) return null;
  const running = task.status === 'running';
  const percent = task.total > 0 ? Math.min(100, Math.round((task.processed / task.total) * 100)) : 0;

  const run = async () => {
    setBusy(true);
    try {
      const next = await api.post<UpgradeTask>(`/api/upgrades/${encodeURIComponent(task.key)}/run`);
      hadRunning.current = true;
      setTask(next);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '系统未能更新历史账单，请重试');
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    setBusy(true);
    try {
      await api.post(`/api/upgrades/${encodeURIComponent(task.key)}/skip`);
      setTask(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="更新历史账单"
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={running ? null : (
        <Space>
          <Button onClick={() => void skip()} disabled={busy}>暂不更新</Button>
          <Button type="primary" onClick={() => void run()} loading={busy}>
            更新历史账单
          </Button>
        </Space>
      )}
    >
      {running ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Text>系统正在更新历史账单</Typography.Text>
          <Progress percent={percent} />
        </Space>
      ) : (
        <Space direction="vertical" size={12}>
          {task.status === 'failed' && (
            <Typography.Text type="danger">系统未能更新部分历史账单，请重试</Typography.Text>
          )}
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            {upgradePromptText(task.banks)}
          </Typography.Paragraph>
        </Space>
      )}
    </Modal>
  );
}
