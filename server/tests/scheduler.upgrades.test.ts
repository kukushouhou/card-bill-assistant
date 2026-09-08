import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpgradeRuntimeMode } from '../src/modules/upgrades/upgrade.runtime';

const cron = vi.hoisted(() => ({ schedule: vi.fn(), destroy: vi.fn() }));
const sync = vi.hoisted(() => vi.fn());
const collect = vi.hoisted(() => vi.fn());
const remindUpgrade = vi.hoisted(() => vi.fn());
vi.mock('node-cron', () => ({ default: { schedule: cron.schedule } }));
vi.mock('../src/lib/prisma', () => ({ prisma: {} }));
vi.mock('../src/modules/email/email.service', () => ({ syncAllEnabledAccounts: sync }));
vi.mock('../src/modules/reminders/reminder.engine', () => ({ collectTodayEvents: collect }));
vi.mock('../src/modules/upgrades/upgrade-reminder', () => ({ runUpgradeReminderCheck: remindUpgrade }));
vi.mock('../src/notify/notification.service', () => ({ resolveNotificationChannels: vi.fn(), sendNotificationChannelBatch: vi.fn() }));

import { isSchedulerStarted, runDailyReminderJob, startScheduler, stopScheduler, waitForScheduledJobs } from '../src/jobs/scheduler';
import { setUpgradeRuntimeState } from '../src/modules/upgrades/upgrade.runtime';

let scheduledCallback: () => void;
function mode(value: UpgradeRuntimeMode): void { setUpgradeRuntimeState({ mode: value, planId: value === 'ready' ? null : 7, message: null }); }
async function tick(hour: number, minute: number): Promise<void> {
  vi.setSystemTime(new Date(2026, 8, 9, hour, minute));
  scheduledCallback();
  await waitForScheduledJobs();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubEnv('REMINDER_HOUR', '8');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  cron.schedule.mockImplementation((_expression: string, callback: () => void) => {
    scheduledCallback = callback;
    return { destroy: cron.destroy };
  });
  sync.mockResolvedValue(undefined);
  remindUpgrade.mockResolvedValue({ pushed: 0, skipped: 0, failed: 0 });
  collect.mockResolvedValue({ now: new Date(2026, 8, 9), cardEvents: [], customEvents: [] });
  mode('ready');
});

afterEach(async () => {
  await stopScheduler();
  mode('ready');
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('持续运行的统一调度器', () => {
  it('必选等待期间定时器持续运行，每分钟只进入升级通知分支', async () => {
    mode('required_wait');
    startScheduler();
    startScheduler();
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    for (let minute = 0; minute <= 10; minute++) await tick(8, minute);
    await tick(8, 30);
    expect(remindUpgrade).toHaveBeenCalledTimes(12);
    expect(sync).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(cron.destroy).not.toHaveBeenCalled();
    expect(isSchedulerStarted()).toBe(true);
  });

  it('执行升级时直接结束，不同步、推日常提醒或催促用户', async () => {
    mode('executing');
    startScheduler();
    await tick(8, 0);
    await tick(8, 30);
    expect(sync).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(remindUpgrade).not.toHaveBeenCalled();
    expect(isSchedulerStarted()).toBe(true);
  });

  it.each(['ready', 'optional_wait', 'failed'] as const)('%s 保持每日提醒与两小时同步的原有触发时刻', async (state) => {
    mode(state);
    startScheduler();
    await tick(7, 59);
    expect(sync).not.toHaveBeenCalled();
    await tick(8, 0);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledTimes(1);
    await tick(8, 1);
    await tick(8, 30);
    expect(sync).toHaveBeenCalledTimes(2);
    await tick(9, 30);
    expect(sync).toHaveBeenCalledTimes(2);
    await tick(10, 30);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(remindUpgrade).not.toHaveBeenCalled();
  });

  it('自定义每日提醒时间继续生效', async () => {
    vi.stubEnv('REMINDER_HOUR', '13');
    startScheduler();
    await tick(8, 0);
    expect(collect).not.toHaveBeenCalled();
    await tick(13, 0);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('升级完成后使用同一定时器恢复日常任务，无须重新启动', async () => {
    mode('required_wait');
    startScheduler();
    await tick(7, 58);
    mode('executing');
    await tick(7, 59);
    mode('ready');
    await tick(8, 0);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(remindUpgrade).toHaveBeenCalledTimes(1);
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.destroy).not.toHaveBeenCalled();
  });

  it('部分迁移失败后同一定时器恢复同步和日常提醒，停止未迁移催办', async () => {
    mode('required_wait');
    startScheduler();
    await tick(7, 58);
    mode('executing');
    await tick(7, 59);
    mode('failed');
    await tick(8, 0);
    await tick(8, 30);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(remindUpgrade).toHaveBeenCalledTimes(1);
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.destroy).not.toHaveBeenCalled();
  });

  it('升级通知检查失败不破坏调度器，下一分钟仍可重试', async () => {
    mode('required_wait');
    remindUpgrade.mockRejectedValueOnce(new Error('临时故障'));
    startScheduler();
    await tick(8, 1);
    await tick(8, 2);
    expect(remindUpgrade).toHaveBeenCalledTimes(2);
    expect(sync).not.toHaveBeenCalled();
    expect(isSchedulerStarted()).toBe(true);
  });

  it('通知尚未发送完时不叠加检查，等待收尾不会停止定时器', async () => {
    mode('required_wait');
    let finish!: () => void;
    remindUpgrade.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    startScheduler();
    scheduledCallback();
    scheduledCallback();
    expect(remindUpgrade).toHaveBeenCalledTimes(1);
    let drained = false;
    const drain = waitForScheduledJobs().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    expect(cron.destroy).not.toHaveBeenCalled();
    finish();
    await drain;
    expect(isSchedulerStarted()).toBe(true);
    await tick(8, 11);
    expect(remindUpgrade).toHaveBeenCalledTimes(2);
  });

  it('同步期间开始升级，等同步收尾后跳过账单推送，下一次定时检查仍正常', async () => {
    let finish!: () => void;
    sync.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    startScheduler();
    vi.setSystemTime(new Date(2026, 8, 9, 8, 0));
    scheduledCallback();
    mode('executing');
    finish();
    await waitForScheduledJobs();
    expect(collect).not.toHaveBeenCalled();
    expect(isSchedulerStarted()).toBe(true);
    await tick(8, 30);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('直接触发日常提醒也遵守升级状态，不绕过入口保护', async () => {
    mode('required_wait');
    expect(await runDailyReminderJob()).toEqual({ pushed: 0, skipped: 0, failed: 0 });
    expect(sync).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it('只有退出才释放定时器，之后可以重新启动', async () => {
    startScheduler();
    await stopScheduler();
    expect(isSchedulerStarted()).toBe(false);
    expect(cron.destroy).toHaveBeenCalledTimes(1);
    startScheduler();
    expect(isSchedulerStarted()).toBe(true);
    expect(cron.schedule).toHaveBeenCalledTimes(2);
  });
});
