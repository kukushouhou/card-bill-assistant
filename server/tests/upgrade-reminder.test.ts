import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedNotificationChannel } from '../src/notify/types';

const prisma = vi.hoisted(() => ({
  upgradePlan: { findFirst: vi.fn(), findUnique: vi.fn() },
  notifyLog: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
}));
const resolveNotificationChannels = vi.hoisted(() => vi.fn());
const sendNotificationChannelBatch = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/prisma', () => ({ prisma }));
vi.mock('../src/notify/notification.service', () => ({ resolveNotificationChannels, sendNotificationChannelBatch }));

import { runUpgradeReminderCheck } from '../src/modules/upgrades/upgrade-reminder';

const initialTime = new Date('2026-09-09T01:00:00Z');
type Task = { status: string; approvedAt: Date | null; ignoredAt: Date | null };
type Plan = { id: number; toVersion: string; status: string; hasRequired: boolean; createdAt: Date; updatedAt: Date; startedAt: Date | null; tasks: Task[] };
type Log = { id: number; type: string; refId: number; fireDate: Date; channel: string; status: string; sentAt: Date; detail?: string | null };
let plan: Plan | null;
let logs: Log[];
let nextId: number;
const channels: ResolvedNotificationChannel[] = [
  { id: 1, deliveryKey: null, type: 'bark', name: '旧手机', enabled: true, config: {} },
  { id: 2, deliveryKey: 'instance:2', type: 'bark', name: '备用手机', enabled: true, config: {} },
];

function matches(log: Log, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = log[key as keyof Log];
    if (value instanceof Date) return actual instanceof Date && actual.getTime() === value.getTime();
    if (value && typeof value === 'object' && 'lte' in value) return actual instanceof Date && actual <= (value.lte as Date);
    return actual === value;
  });
}

function tenMinutesLater(): void { vi.setSystemTime(new Date(initialTime.getTime() + 600_000)); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(initialTime);
  vi.stubEnv('APP_NAME', '我的账单助手');
  vi.stubEnv('REMINDER_HOUR', '8');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  plan = {
    id: 7, toVersion: '0.5.0', status: 'awaiting_decision', hasRequired: true,
    createdAt: initialTime, updatedAt: initialTime, startedAt: null,
    tasks: [{ status: 'awaiting_decision', approvedAt: null, ignoredAt: null }],
  };
  logs = [];
  nextId = 0;
  prisma.upgradePlan.findFirst.mockImplementation(async () => structuredClone(plan));
  prisma.upgradePlan.findUnique.mockImplementation(async () => structuredClone(plan));
  prisma.notifyLog.create.mockImplementation(async ({ data }: { data: Omit<Log, 'id'> }) => {
    if (logs.some(log => matches(log, { type: data.type, refId: data.refId, fireDate: data.fireDate, channel: data.channel }))) {
      throw { code: 'P2002' };
    }
    const log = { ...data, id: ++nextId };
    logs.push(log);
    return { id: log.id };
  });
  prisma.notifyLog.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Log> }) => {
    const found = logs.filter(log => matches(log, where));
    found.forEach(log => Object.assign(log, data));
    return { count: found.length };
  });
  prisma.notifyLog.deleteMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const count = logs.filter(log => matches(log, where)).length;
    logs = logs.filter(log => !matches(log, where));
    return { count };
  });
  prisma.notifyLog.findUnique.mockImplementation(async ({ where }: { where: { type_refId_fireDate_channel: Record<string, unknown> } }) =>
    logs.find(log => matches(log, where.type_refId_fireDate_channel)) ?? null);
  prisma.notifyLog.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    logs.filter(log => matches(log, where)).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0] ?? null);
  resolveNotificationChannels.mockResolvedValue(channels);
  sendNotificationChannelBatch.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('必选升级等待通知', () => {
  it('未满十分钟不读取渠道或占用日志，满十分钟后向同类型的两个实例分别通知', async () => {
    vi.setSystemTime(new Date(initialTime.getTime() + 599_999));
    expect(await runUpgradeReminderCheck()).toEqual({ pushed: 0, skipped: 0, failed: 0 });
    expect(resolveNotificationChannels).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    tenMinutesLater();
    expect(await runUpgradeReminderCheck()).toEqual({ pushed: 2, skipped: 0, failed: 0 });
    expect(logs.map(log => [log.channel, log.status])).toEqual([['bark', 'sent'], ['instance:2', 'sent']]);
    expect(sendNotificationChannelBatch).toHaveBeenCalledWith(channels[0], [{
      title: '我的账单助手 · 系统升级待确认',
      body: '升级至 v0.5.0 需要你确认。因为未迁移所以无法正常通知，请打开系统完成升级。',
    }]);
  });

  it.each(['optional', 'silent', 'executing', 'completed', 'failed', 'confirmed', 'no-plan', 'all-decided', 'running-task'])(
    '%s 不触发必选等待通知', async (scenario) => {
      tenMinutesLater();
      if (scenario === 'optional' || scenario === 'silent') plan!.hasRequired = false;
      if (['executing', 'completed', 'failed'].includes(scenario)) plan!.status = scenario;
      if (scenario === 'confirmed') plan!.startedAt = initialTime;
      if (scenario === 'all-decided') plan!.tasks[0].status = 'approved';
      if (scenario === 'running-task') plan!.tasks.push({ status: 'running', approvedAt: initialTime, ignoredAt: null });
      if (scenario === 'no-plan') plan = null;
      await runUpgradeReminderCheck();
      expect(resolveNotificationChannels).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    },
  );

  it.each(['approvedAt', 'ignoredAt'] as const)('旧入口逐项操作 %s 后按最后一次操作计时', async (field) => {
    plan!.tasks.push({ status: field === 'approvedAt' ? 'approved' : 'ignored', approvedAt: null, ignoredAt: null,
      [field]: new Date(initialTime.getTime() + 300_000) });
    tenMinutesLater();
    await runUpgradeReminderCheck();
    expect(sendNotificationChannelBatch).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(initialTime.getTime() + 900_000));
    expect((await runUpgradeReminderCheck()).pushed).toBe(2);
  });

  it('读取页面导致的普通 updatedAt 变化不延后等待通知', async () => {
    tenMinutesLater();
    plan!.updatedAt = new Date();
    expect((await runUpgradeReminderCheck()).pushed).toBe(2);
  });

  it('用户确认后即使迁移失败，也不再发送未迁移催办', async () => {
    plan!.status = 'failed';
    plan!.tasks[0] = { status: 'failed', approvedAt: new Date(initialTime.getTime() + 60_000), ignoredAt: null };
    plan!.startedAt = initialTime;
    vi.setSystemTime(new Date(2026, 8, 10, 8, 0));
    await runUpgradeReminderCheck();
    expect(sendNotificationChannelBatch).not.toHaveBeenCalled();
  });

  it('同一天重复检查不重发，另一个升级计划可以独立通知', async () => {
    tenMinutesLater();
    await runUpgradeReminderCheck();
    vi.setSystemTime(new Date(initialTime.getTime() + 1_200_000));
    expect(await runUpgradeReminderCheck()).toEqual({ pushed: 0, skipped: 2, failed: 0 });
    expect(sendNotificationChannelBatch).toHaveBeenCalledTimes(2);
    plan!.id = 8;
    plan!.toVersion = '0.6.0';
    expect((await runUpgradeReminderCheck()).pushed).toBe(2);
  });

  it('一直未确认时从次日已设定时刻继续提醒，首次和每天通知共用模板', async () => {
    tenMinutesLater();
    await runUpgradeReminderCheck();
    const firstMessage = sendNotificationChannelBatch.mock.calls[0][1];
    vi.setSystemTime(new Date(2026, 8, 10, 7, 59));
    expect((await runUpgradeReminderCheck()).pushed).toBe(0);
    vi.setSystemTime(new Date(2026, 8, 10, 8, 0));
    expect((await runUpgradeReminderCheck()).pushed).toBe(2);
    expect(sendNotificationChannelBatch.mock.calls[2][1]).toEqual(firstMessage);
    expect((await runUpgradeReminderCheck()).pushed).toBe(0);
    vi.setSystemTime(new Date(2026, 8, 11, 8, 0));
    expect((await runUpgradeReminderCheck()).pushed).toBe(2);
  });

  it('首次通知在当天固定时段之前发过，当天不重复，次日遵守自定义时段', async () => {
    vi.stubEnv('REMINDER_HOUR', '13');
    tenMinutesLater();
    await runUpgradeReminderCheck();
    vi.setSystemTime(new Date(2026, 8, 9, 13, 0));
    expect((await runUpgradeReminderCheck()).pushed).toBe(0);
    vi.setSystemTime(new Date(2026, 8, 10, 12, 59));
    expect((await runUpgradeReminderCheck()).pushed).toBe(0);
    vi.setSystemTime(new Date(2026, 8, 10, 13, 0));
    expect((await runUpgradeReminderCheck()).pushed).toBe(2);
  });

  it('每日通知部分失败，下一分钟只补发失败渠道', async () => {
    tenMinutesLater();
    await runUpgradeReminderCheck();
    vi.setSystemTime(new Date(2026, 8, 10, 8, 0));
    sendNotificationChannelBatch.mockResolvedValueOnce({ ok: false });
    expect(await runUpgradeReminderCheck()).toEqual({ pushed: 1, skipped: 0, failed: 1 });
    vi.setSystemTime(new Date(2026, 8, 10, 8, 1));
    expect(await runUpgradeReminderCheck()).toEqual({ pushed: 1, skipped: 1, failed: 0 });
  });

  it('未配置启用渠道时不写日志，之后出现渠道仍可通知', async () => {
    tenMinutesLater();
    resolveNotificationChannels.mockResolvedValueOnce([]);
    await runUpgradeReminderCheck();
    expect(logs).toEqual([]);
    expect((await runUpgradeReminderCheck()).pushed).toBe(2);
  });

  it.each([false, true])('渠道失败（异常=%s）不阻断另一渠道，下一轮仅重试失败实例', async (throws) => {
    tenMinutesLater();
    if (throws) sendNotificationChannelBatch.mockRejectedValueOnce(new Error('传输失败'));
    else sendNotificationChannelBatch.mockResolvedValueOnce({ ok: false });
    expect(await runUpgradeReminderCheck()).toEqual({ pushed: 1, skipped: 0, failed: 1 });
    expect(logs.map(log => log.channel)).toEqual(['instance:2']);
    expect(await runUpgradeReminderCheck()).toEqual({ pushed: 1, skipped: 1, failed: 0 });
    expect(sendNotificationChannelBatch.mock.calls.map(([channel]) => channel.id)).toEqual([1, 2, 1]);
  });

  it('新鲜预占阻止并发发送，异常中断满十五分钟可接管', async () => {
    tenMinutesLater();
    resolveNotificationChannels.mockResolvedValue([channels[0]]);
    logs.push({ id: ++nextId, type: 'upgrade_pending', refId: 7, fireDate: new Date('2026-09-08T16:00:00Z'),
      channel: 'bark', status: 'pending', sentAt: new Date() });
    expect((await runUpgradeReminderCheck()).skipped).toBe(1);
    expect(sendNotificationChannelBatch).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(initialTime.getTime() + 1_500_000));
    expect((await runUpgradeReminderCheck()).pushed).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('sent');
  });

  it('两次检查并发争取发送权时，每个实例仅发送一次', async () => {
    tenMinutesLater();
    const results = await Promise.all([runUpgradeReminderCheck(), runUpgradeReminderCheck()]);
    expect(results.reduce((sum, result) => sum + result.pushed, 0)).toBe(2);
    expect(sendNotificationChannelBatch).toHaveBeenCalledTimes(2);
  });

  it.each(['confirmed', 'recent-action', 'deleted'])('发送准备期间计划变为 %s 时释放预占且不发送', async (change) => {
    tenMinutesLater();
    resolveNotificationChannels.mockImplementationOnce(async () => {
      if (change === 'confirmed') { plan!.status = 'executing'; plan!.tasks[0].status = 'approved'; }
      if (change === 'recent-action') plan!.tasks.push({ status: 'ignored', ignoredAt: new Date(), approvedAt: null });
      if (change === 'deleted') plan = null;
      return channels;
    });
    await runUpgradeReminderCheck();
    expect(sendNotificationChannelBatch).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('数据库预占失败不上报为成功，也不调用外部渠道', async () => {
    tenMinutesLater();
    const error = Object.assign(new Error('数据库不可用'), { code: 'P1001' });
    prisma.notifyLog.create.mockRejectedValue(error);
    await expect(runUpgradeReminderCheck()).rejects.toBe(error);
    expect(sendNotificationChannelBatch).not.toHaveBeenCalled();
  });
});
