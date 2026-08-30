import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  notificationChannel: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../src/lib/prisma', () => ({ prisma }));

import {
  getNotificationSettings,
  resolveNotificationChannels,
  saveNotificationChannel,
} from '../src/notify/notification.service';
import { barkProvider } from '../src/notify/providers/bark.provider';
import { sealNotificationConfig, unsealNotificationConfig } from '../src/notify/notification-config';

describe('notification.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.notificationChannel.findMany.mockResolvedValue([]);
  });

  it('提供方列表与加密渠道配置通过通用结构返回', async () => {
    prisma.notificationChannel.findMany.mockResolvedValue([
      {
        id: 1,
        type: 'bark',
        name: 'Bark',
        enabled: true,
        config: sealNotificationConfig({ url: 'https://api.day.app/key' }),
      },
    ]);

    const settings = await getNotificationSettings();
    expect(settings.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'bark', fields: [expect.objectContaining({ key: 'url' })] }),
      expect.objectContaining({ type: 'custom-http', configMode: 'custom-http' }),
    ]));
    expect(settings.channels).toEqual([
      expect.objectContaining({
        type: 'bark',
        configured: true,
        config: { url: 'https://api.day.app/key' },
      }),
    ]);
  });

  it('保存渠道时由提供方校验并加密配置', async () => {
    prisma.notificationChannel.upsert.mockResolvedValue({});

    await saveNotificationChannel('bark', {
      enabled: true,
      config: { url: 'https://api.day.app/new-key' },
    });

    expect(prisma.notificationChannel.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { type: 'bark' },
      create: expect.objectContaining({ type: 'bark' }),
    }));
    const call = prisma.notificationChannel.upsert.mock.calls[0][0];
    expect(unsealNotificationConfig(call.create.config)).toEqual({ url: 'https://api.day.app/new-key' });
    expect(JSON.stringify(call.create.config)).not.toContain('new-key');
  });

  it('拒绝读取未加密的渠道配置', async () => {
    prisma.notificationChannel.findMany.mockResolvedValue([{
      id: 7,
      type: 'bark',
      name: 'Bark',
      enabled: true,
      config: { url: 'https://api.day.app/plain-key' },
    }]);

    await expect(resolveNotificationChannels()).rejects.toThrow('通知渠道配置格式无效');
  });

  it('渠道连接错误使用通用通知文案', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await barkProvider.sendBatch(
        { url: 'https://api.day.app/key' },
        [{ title: '测试', body: '内容' }],
      );
      expect(result).toEqual({ ok: false, error: '通知服务返回 HTTP 503' });
      expect(result.error).not.toContain('Bark');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
