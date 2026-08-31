import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { today } from '../lib/dates';
import { collectTodayEvents } from '../modules/reminders/reminder.engine';
import { syncAllEnabledAccounts } from '../modules/email/email.service';
import { resolveNotificationChannels, sendNotificationChannelBatch } from '../notify/notification.service';

/** pending 发送预占的租约；进程中断后超过该时长可由下一次任务原子接管。 */
const NOTIFY_PENDING_LEASE_MS = 15 * 60 * 1000;
const scheduledTasks: ScheduledTask[] = [];
const activeScheduledRuns = new Set<Promise<unknown>>();
let schedulerStarted = false;

function trackScheduledRun(run: () => Promise<unknown>): void {
  const promise = run();
  activeScheduledRuns.add(promise);
  void promise.finally(() => activeScheduledRuns.delete(promise));
}

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return typeof error === 'object' && error != null && 'code' in error && error.code === 'P2002';
}

/**
 * 每日提醒任务：
 * 1. 先同步所有启用邮箱（保证账单最新）
 * 2. 计算今日应提醒事件
 * 3. 对每个已启用通知渠道，按 NotifyLog(type, refId, fireDate, channel) 独立去重并发送
 */
export async function runDailyReminderJob(): Promise<{ pushed: number; skipped: number; failed: number }> {
  await syncAllEnabledAccounts().catch((err) => {
    console.error('[job] 提醒前邮箱同步失败（继续用已有数据计算提醒）:', err);
  });

  const { now, cardEvents, customEvents } = await collectTodayEvents();
  const all = [
    ...cardEvents.map((e) => ({
      type: e.type,
      refId: e.refId,
      title: e.title,
      body: e.body,
    })),
    ...customEvents.map((e) => ({ type: e.type, refId: e.refId, title: e.title, body: e.body })),
  ];

  const result = { pushed: 0, skipped: 0, failed: 0 };
  if (all.length === 0) {
    console.log('[job] 今日无待提醒事项');
    return result;
  }

  const channels = await resolveNotificationChannels();
  if (channels.length === 0) {
    result.skipped = all.length;
    console.log('[job] 未配置已启用的通知渠道，今日提醒已跳过');
    return result;
  }

  for (const channel of channels) {
    const leaseAt = new Date();
    const staleBefore = new Date(leaseAt.getTime() - NOTIFY_PENDING_LEASE_MS);
    const toSend: Array<{ title: string; body: string }> = [];
    const pendingLogIds: number[] = [];
    for (const event of all) {
      try {
        const log = await prisma.notifyLog.create({
          data: {
            type: event.type,
            refId: event.refId,
            fireDate: now,
            channel: channel.type,
            status: 'pending',
            sentAt: leaseAt,
          },
        });
        pendingLogIds.push(log.id);
        toSend.push({ title: event.title, body: event.body });
      } catch (error) {
        // 只有 P2002 才表示同一事件已被其他任务预占；其余数据库异常必须上抛，不能误报为已发送。
        if (!isUniqueConstraintError(error)) throw error;

        // pending 超出租约说明上次进程可能在发送前中断。带旧时间条件原子接管，避免正常并发重复发送。
        const reclaimed = await prisma.notifyLog.updateMany({
          where: {
            type: event.type,
            refId: event.refId,
            fireDate: now,
            channel: channel.type,
            status: 'pending',
            sentAt: { lte: staleBefore },
          },
          data: { sentAt: leaseAt, detail: null },
        });
        if (reclaimed.count === 0) {
          result.skipped++;
          continue;
        }

        const log = await prisma.notifyLog.findUnique({
          where: {
            type_refId_fireDate_channel: {
              type: event.type,
              refId: event.refId,
              fireDate: now,
              channel: channel.type,
            },
          },
          select: { id: true },
        });
        if (!log) throw new Error('通知发送预占记录在接管后不存在');
        pendingLogIds.push(log.id);
        toSend.push({ title: event.title, body: event.body });
      }
    }

    if (toSend.length === 0) continue;
    const sent = await sendNotificationChannelBatch(channel, toSend);
    if (sent.ok) {
      await prisma.notifyLog.updateMany({
        where: { id: { in: pendingLogIds }, status: 'pending', sentAt: leaseAt },
        data: { status: 'sent', detail: null, sentAt: new Date() },
      });
      result.pushed += toSend.length;
      console.log(`[job] 已通过 ${channel.name} 发送 ${toSend.length} 条提醒`);
    } else {
      // 发送失败即移除本轮预占日志，让下一次任务能够重试。
      await prisma.notifyLog.deleteMany({
        where: { id: { in: pendingLogIds }, status: 'pending', sentAt: leaseAt },
      });
      result.failed += toSend.length;
      console.error(`[job] 通知渠道 ${channel.name} 发送失败:`, sent.error);
    }
  }
  return result;
}

/** 注册定时任务 */
export function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const hour = config.reminderHour;

  // 每日提醒：每天 REMINDER_HOUR 点整
  scheduledTasks.push(cron.schedule(`0 ${hour} * * *`, () => {
    console.log(`[cron] 触发每日提醒任务 (${hour}:00)`);
    trackScheduledRun(() => runDailyReminderJob().catch((err) => console.error('[cron] 每日提醒任务异常:', err)));
  }));

  // 邮箱增量同步：每 2 小时（除每日提醒任务的整点外也照常跑，增量拉取开销小）
  scheduledTasks.push(cron.schedule('30 */2 * * *', () => {
    console.log('[cron] 触发邮箱定时同步');
    trackScheduledRun(() => syncAllEnabledAccounts().catch((err) => console.error('[cron] 邮箱同步异常:', err)));
  }));

  console.log(`[cron] 调度器已启动：每日 ${hour}:00 提醒推送，每 2 小时邮箱同步`);
}

/** 迁移执行前停止新调度，并等待已进入的同步/推送收尾。 */
export async function pauseScheduler(): Promise<void> {
  if (schedulerStarted) {
    for (const task of scheduledTasks.splice(0)) task.stop();
    schedulerStarted = false;
  }
  if (activeScheduledRuns.size > 0) await Promise.allSettled([...activeScheduledRuns]);
}

export function isSchedulerStarted(): boolean {
  return schedulerStarted;
}

/** 手动触发一次今日提醒（管理接口用，幂等） */
export async function triggerDailyReminderNow() {
  return runDailyReminderJob();
}

export function todayAnchor(): Date {
  return today();
}
