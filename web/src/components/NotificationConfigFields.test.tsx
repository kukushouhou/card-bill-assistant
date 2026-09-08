import { App, Button, Form } from 'antd';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationProviderDefinition } from '../api/types';
import { NotificationConfigFields } from './NotificationConfigFields';
const provider: NotificationProviderDefinition = {
  type: 'bark', name: 'Bark', description: '',
  fields: [
    { key: 'url', label: '推送地址', type: 'url', required: true },
    { key: 'sound', label: '通知铃声', type: 'bark-sound', required: false, advanced: true, options: [{ value: 'minuet', label: '小步舞曲 · minuet' }] },
  ],
};
describe('Bark 高级配置', () => {
  it('未展开高级设置也会提交已有铃声，不因字段未挂载而丢失', async () => {
    const submit = vi.fn(); const user = userEvent.setup();
    render(<App><Form onFinish={submit} initialValues={{ config: { url: 'https://example.test/key', sound: 'minuet' } }}>
      <NotificationConfigFields provider={provider} prefix={['config']} /><Button htmlType="submit" aria-label="保存">保存</Button>
    </Form></App>);
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ config: { url: 'https://example.test/key', sound: 'minuet' } }));
  });
  it('历史非内置铃声显示为手机已导入，并保留原名称', async () => {
    const user = userEvent.setup();
    render(<App><Form initialValues={{ config: { sound: 'my_audio' } }}>
      <NotificationConfigFields provider={provider} prefix={['config']} />
    </Form></App>);
    await user.click(screen.getByText('高级设置'));
    expect((await screen.findByLabelText('已导入铃声名称') as HTMLInputElement).value).toBe('my_audio');
    expect(screen.getByText('先在目标手机的 Bark 中导入音频，再复制名称。')).not.toBeNull();
  });
});
