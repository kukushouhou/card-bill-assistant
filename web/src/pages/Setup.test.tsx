import { App } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Setup from './Setup';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  api: apiMocks,
}));

vi.mock('../skins/SkinProvider', () => ({ useSkin: () => ({ refresh: async () => undefined }), SkinDecorations: () => null, ColorModeSwitch: () => null }));
vi.mock('../skins/BuiltinSkinPicker', () => ({ default: () => null }));

vi.mock('../appName', () => ({ useAppName: () => '守候信用卡小管家' }));
vi.mock('../responsive', () => ({ useResponsive: () => ({ isMobile: false }) }));

describe('安装向导', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.get.mockResolvedValue({
      installed: false,
      dbOk: true,
      installedAt: null,
      notificationProviders: [],
    });
    apiMocks.post.mockResolvedValue({ ok: true });
  });

  it('跨步骤完成安装时保留已校验的密码和 PIN', async () => {
    const user = userEvent.setup();
    render(
      <App>
        <Setup onDone={() => undefined} />
      </App>,
    );

    await screen.findByText('正常');
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await user.type(screen.getByLabelText('登录密码'), 'password123');
    await user.type(screen.getByLabelText('确认密码'), 'password123');
    await user.type(screen.getByLabelText('PIN 码'), '123456');
    await user.type(screen.getByLabelText('确认 PIN'), '123456');
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await screen.findByText('选择通知渠道');
    expect(screen.queryByRole('button', { name: '完成安装' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('region', { name: '外观主题' });
    await user.click(screen.getByRole('button', { name: '完成安装' }));

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith('/api/setup/install', {
        skinId: 'modern',
        password: 'password123',
        pin: '123456',
        notifications: [],
      });
    });
  });

  it('通知配置跨外观步骤、返回修改和失败重试后仍完整提交', async () => {
    apiMocks.get.mockResolvedValue({ installed: false, dbOk: true, notificationProviders: [{
      type: 'webhook', name: 'Webhook', description: '测试渠道',
      fields: [{ key: 'url', label: '推送地址', type: 'url', required: true }],
    }] });
    apiMocks.post.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue({ ok: true });
    const user = userEvent.setup(); render(<App><Setup onDone={() => undefined} /></App>);
    await screen.findByText('正常'); await user.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'password123' } });
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(await screen.findByRole('button', { name: '添加渠道' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Webhook' }));
    fireEvent.change(await screen.findByLabelText('推送地址'), { target: { value: 'https://example.test/first' } });
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByRole('region', { name: '外观主题' });
    expect(apiMocks.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '上一步' }));
    expect((await screen.findByLabelText('推送地址') as HTMLInputElement).value).toBe('https://example.test/first');
    fireEvent.change(screen.getByLabelText('推送地址'), { target: { value: 'https://example.test/updated' } });
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '完成安装' }));
    await screen.findByText('安装失败，请重试');
    await user.click(screen.getByRole('button', { name: '上一步' }));
    expect((await screen.findByLabelText('推送地址') as HTMLInputElement).value).toBe('https://example.test/updated');
    await user.click(screen.getByRole('button', { name: '上一步' }));
    expect((await screen.findByLabelText('登录密码') as HTMLInputElement).value).toBe('password123');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '完成安装' }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(2));
    for (const [url, payload] of apiMocks.post.mock.calls) {
      expect(url).toBe('/api/setup/install');
      expect(payload).toEqual({ skinId: 'modern', password: 'password123', pin: undefined, notifications: [{ type: 'webhook', name: 'Webhook', enabled: true, config: { url: 'https://example.test/updated' } }] });
    }
  }, 30_000);
});
