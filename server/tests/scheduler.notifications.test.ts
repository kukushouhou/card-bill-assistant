import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  notifyLog: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
const syncAllEnabledAccounts = vi.hoisted(() => vi.fn());
const collectTodayEvents = vi.hoisted(() => vi.fn());
const resolveNotificationChannels = vi.hoisted(() => vi.fn());
const sendNotificationChannelBatch = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/prisma', () => ({ prisma }));
vi.mock('../src/modules/email/email.service', () => ({ syncAllEnabledAccounts }));
vi.mock('../src/modules/reminders/reminder.engine', () => ({ collectTodayEvents }));
vi.mock('../src/notify/notification.service', () => ({
  resolveNotificationChannels,
  sendNotificationChannelBatch,
}));

import { runDailyReminderJob } from '../src/jobs/scheduler';

describe('runDailyReminderJob 通用通知渠道', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncAllEnabledAccounts.mockResolvedValue(undefined);
    collectTodayEvents.mockResolvedValue({
      now: new Date('2026-08-24T00:00:00.000Z'),
      cardEvents: [{ type: 'card_due', refId: -7, cardId: 7, title: '还款提醒', body: '今天还款' }],
      customEvents: [],
    });
    resolveNotificationChannels.mockResolvedValue([
      { type: 'bark', name: 'Bark', enabled: true, source: 'database', config: { url: 'https://example.test/a' } },
      { type: 'future-channel', name: '未来渠道', enabled: true, source: 'database', config: { token: 'x' } },
    ]);
    let id = 0;
    prisma.notifyLog.create.mockImplementation(async () => ({ id: ++id }));
    prisma.notifyLog.findUnique.mockResolvedValue({ id: 99 });
    prisma.notifyLog.updateMany.mockResolvedValue({ count: 1 });
    prisma.notifyLog.deleteMany.mockResolvedValue({ count: 0 });
    sendNotificationChannelBatch.mockResolvedValue({ ok: true });
  });

  it('每个已启用渠道独立去重并发送', async () => {
    const result = await runDailyReminderJob();

    expect(result).toEqual({ pushed: 2, skipped: 0, failed: 0 });
    expect(prisma.notifyLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.notifyLog.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({ channel: 'bark', status: 'pending' }),
    }));
    expect(prisma.notifyLog.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({ channel: 'future-channel', status: 'pending' }),
    }));
    expect(sendNotificationChannelBatch).toHaveBeenCalledTimes(2);
  });

  it('某个渠道失败只回滚该渠道的预占日志', async () => {
    resolveNotificationChannels.mockResolvedValue([
      { type: 'bark', name: 'Bark', enabled: true, source: 'database', config: { url: 'https://example.test/a' } },
    ]);
    sendNotificationChannelBatch.mockResolvedValue({ ok: false, error: '网络不可用' });

    const result = await runDailyReminderJob();

    expect(result).toEqual({ pushed: 0, skipped: 0, failed: 1 });
    expect(prisma.notifyLog.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [1] }, status: 'pending', sentAt: expect.any(Date) },
    });
    expect(prisma.notifyLog.updateMany).not.toHaveBeenCalled();
  });

  it('新鲜 pending 被视为其他并发任务持有，不重复发送', async () => {
    resolveNotificationChannels.mockResolvedValue([
      { type: 'bark', name: 'Bark', enabled: true, source: 'database', config: { url: 'https://example.test/a' } },
    ]);
    prisma.notifyLog.create.mockRejectedValue({ code: 'P2002' });
    prisma.notifyLog.updateMany.mockResolvedValue({ count: 0 });

    const result = await runDailyReminderJob();

    expect(result).toEqual({ pushed: 0, skipped: 1, failed: 0 });
    expect(sendNotificationChannelBatch).not.toHaveBeenCalled();
    expect(prisma.notifyLog.findUnique).not.toHaveBeenCalled();
  });

  it('过期 pending 可被原子接管并重新发送', async () => {
    resolveNotificationChannels.mockResolvedValue([
      { type: 'bark', name: 'Bark', enabled: true, source: 'database', config: { url: 'https://example.test/a' } },
    ]);
    prisma.notifyLog.create.mockRejectedValue({ code: 'P2002' });
    prisma.notifyLog.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.notifyLog.findUnique.mockResolvedValue({ id: 77 });

    const result = await runDailyReminderJob();

    expect(result).toEqual({ pushed: 1, skipped: 0, failed: 0 });
    expect(prisma.notifyLog.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        type: 'card_due',
        refId: -7,
        fireDate: new Date('2026-08-24T00:00:00.000Z'),
        channel: 'bark',
        status: 'pending',
        sentAt: { lte: expect.any(Date) },
      },
      data: { sentAt: expect.any(Date), detail: null },
    });
    expect(sendNotificationChannelBatch).toHaveBeenCalledTimes(1);
    expect(prisma.notifyLog.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: [77] }, status: 'pending', sentAt: expect.any(Date) },
      data: { status: 'sent', detail: null, sentAt: expect.any(Date) },
    });
  });

  it('非唯一键数据库异常会上抛且绝不发送', async () => {
    resolveNotificationChannels.mockResolvedValue([
      { type: 'bark', name: 'Bark', enabled: true, source: 'database', config: { url: 'https://example.test/a' } },
    ]);
    const databaseError = Object.assign(new Error('连接已断开'), { code: 'P1001' });
    prisma.notifyLog.create.mockRejectedValue(databaseError);

    await expect(runDailyReminderJob()).rejects.toBe(databaseError);
    expect(prisma.notifyLog.updateMany).not.toHaveBeenCalled();
    expect(sendNotificationChannelBatch).not.toHaveBeenCalled();
  });
});
