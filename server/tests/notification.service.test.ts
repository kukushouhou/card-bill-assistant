import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  notificationChannel: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  appSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock('../src/lib/prisma', () => ({ prisma }));

import {
  getNotificationSettings,
  NOTIFICATION_CHANNELS_INITIALIZED_KEY,
  resolveNotificationChannels,
  saveNotificationChannel,
} from '../src/notify/notification.service';
import { barkProvider } from '../src/notify/providers/bark.provider';

describe('notification.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.notificationChannel.findMany.mockResolvedValue([]);
    prisma.appSetting.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma));
  });

  it('没有新渠道记录时兼容旧 AppSetting Bark 地址', async () => {
    prisma.appSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === 'barkUrl') return { key: 'barkUrl', value: 'https://api.day.app/legacy-key' };
      return null;
    });

    await expect(resolveNotificationChannels()).resolves.toEqual([
      expect.objectContaining({
        type: 'bark',
        source: 'legacy-setting',
        config: { url: 'https://api.day.app/legacy-key' },
      }),
    ]);
  });

  it('用户已在安装向导选择暂不配置时不回退旧渠道', async () => {
    prisma.appSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === NOTIFICATION_CHANNELS_INITIALIZED_KEY
        ? { key: NOTIFICATION_CHANNELS_INITIALIZED_KEY, value: 'true' }
        : null,
    );

    await expect(resolveNotificationChannels()).resolves.toEqual([]);
  });

  it('提供方列表与渠道配置通过通用结构返回', async () => {
    prisma.notificationChannel.findMany.mockResolvedValue([
      {
        id: 1,
        type: 'bark',
        name: 'Bark',
        enabled: true,
        config: { url: 'https://api.day.app/key' },
      },
    ]);

    const settings = await getNotificationSettings();
    expect(settings.providers).toEqual([
      expect.objectContaining({ type: 'bark', fields: [expect.objectContaining({ key: 'url' })] }),
    ]);
    expect(settings.channels).toEqual([
      expect.objectContaining({ type: 'bark', configured: true, source: 'database' }),
    ]);
  });

  it('保存渠道时由提供方校验配置并写入初始化标记', async () => {
    prisma.notificationChannel.upsert.mockResolvedValue({});
    prisma.appSetting.upsert.mockResolvedValue({});
    prisma.appSetting.deleteMany.mockResolvedValue({ count: 0 });

    await saveNotificationChannel('bark', {
      enabled: true,
      config: { url: 'https://api.day.app/new-key' },
    });

    expect(prisma.notificationChannel.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { type: 'bark' },
      create: expect.objectContaining({ type: 'bark', config: { url: 'https://api.day.app/new-key' } }),
    }));
    expect(prisma.appSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: NOTIFICATION_CHANNELS_INITIALIZED_KEY },
    }));
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
