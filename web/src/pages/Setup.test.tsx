import { App } from 'antd';
import { render, screen, waitFor } from '@testing-library/react';
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
    await user.click(screen.getByRole('button', { name: '完成安装' }));

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith('/api/setup/install', {
        password: 'password123',
        pin: '123456',
        notifications: [],
      });
    });
  });
});
