import { config } from '../../config';
import type { Prisma } from '../../generated/prisma/client';
import { shanghaiMidnight } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { resolveNotificationChannels, sendNotificationChannelBatch } from '../../notify/notification.service';
import type { NotificationSendResult } from '../../notify/types';

const WAIT_MS = 10 * 60 * 1000;
const PENDING_LEASE_MS = 15 * 60 * 1000;
const planSelect = {
  id: true, toVersion: true, hasRequired: true, status: true, createdAt: true, startedAt: true,
  tasks: { select: { status: true, approvedAt: true, ignoredAt: true } },
} satisfies Prisma.UpgradePlanSelect;
type ReminderPlan = Prisma.UpgradePlanGetPayload<{ select: typeof planSelect }>;

function needsReminder(plan: ReminderPlan | null, now: Date): plan is ReminderPlan {
  if (!plan?.hasRequired || plan.status !== 'awaiting_decision' || plan.startedAt) return false;
  if (plan.tasks.some(task => task.status === 'running')
    || !plan.tasks.some(task => task.status === 'awaiting_decision')) return false;

  // 读页面和重启不重置等待时间；兼容旧入口逐项确认/忽略后继续等待的计划。
  let since = plan.createdAt.getTime();
  for (const task of plan.tasks) {
    since = Math.max(since, task.approvedAt?.getTime() ?? 0, task.ignoredAt?.getTime() ?? 0);
  }
  return now.getTime() - since >= WAIT_MS;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'code' in error && error.code === 'P2002';
}

/** 由统一调度入口的升级分支调用，不启动独立定时器或日常账单任务。 */
export async function runUpgradeReminderCheck(): Promise<{ pushed: number; skipped: number; failed: number }> {
  const result = { pushed: 0, skipped: 0, failed: 0 };
  const plan = await prisma.upgradePlan.findFirst({
    where: { status: { in: ['awaiting_decision', 'executing', 'failed'] } },
    orderBy: { createdAt: 'desc' },
    select: planSelect,
  });
  if (!needsReminder(plan, new Date())) return result;

  const channels = await resolveNotificationChannels();
  for (const channel of channels) {
    const now = new Date();
    const deliveryKey = channel.deliveryKey ?? channel.type;
    const previous = await prisma.notifyLog.findFirst({
      where: { type: 'upgrade_pending', refId: plan.id, channel: deliveryKey, status: 'sent' },
      orderBy: { sentAt: 'desc' }, select: { sentAt: true, fireDate: true },
    });
    // 首次满十分钟即通知；之后只在每日已设定的通知时间到达后提醒。
    // 同一天已成功通知则不再发；错过时段或发送失败会在后续检查补发。
    const dailyAt = new Date(now);
    dailyAt.setHours(config.reminderHour, 0, 0, 0);
    if (dailyAt > now) dailyAt.setDate(dailyAt.getDate() - 1);
    const fireDate = shanghaiMidnight(previous ? dailyAt : now);
    if (previous && (previous.sentAt >= dailyAt || previous.fireDate >= fireDate)) {
      result.skipped++;
      continue;
    }
    const eventKey = {
      type: 'upgrade_pending', refId: plan.id,
      fireDate, channel: deliveryKey,
    };
    const leaseAt = new Date();
    let logId: number;
    try {
      const log = await prisma.notifyLog.create({
        data: { ...eventKey, status: 'pending', sentAt: leaseAt }, select: { id: true },
      });
      logId = log.id;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const claimed = await prisma.notifyLog.updateMany({
        where: { ...eventKey, status: 'pending', sentAt: { lte: new Date(leaseAt.getTime() - PENDING_LEASE_MS) } },
        data: { sentAt: leaseAt, detail: null },
      });
      if (claimed.count === 0) {
        result.skipped++;
        continue;
      }
      const log = await prisma.notifyLog.findUnique({
        where: { type_refId_fireDate_channel: eventKey }, select: { id: true },
      });
      if (!log) throw new Error('升级通知预占记录在接管后不存在');
      logId = log.id;
    }

    const ownedLease = { id: logId, status: 'pending', sentAt: leaseAt };
    // 读取渠道或争取发送权期间，用户可能已经确认；发送前重新核对持久化状态。
    const current = await prisma.upgradePlan.findUnique({ where: { id: plan.id }, select: planSelect });
    if (!needsReminder(current, new Date())) {
      await prisma.notifyLog.deleteMany({ where: ownedLease });
      break;
    }
    let sent: NotificationSendResult;
    try {
      sent = await sendNotificationChannelBatch(channel, [{
        title: `${config.appName} · 系统升级待确认`,
        body: `升级至 v${current.toVersion} 需要你确认。因为未迁移所以无法正常通知，请打开系统完成升级。`,
      }]);
    } catch {
      // 意外的渠道异常也只影响自身；不把配置或请求地址写入日志。
      sent = { ok: false, error: '通知发送异常' };
    }
    if (sent.ok) {
      await prisma.notifyLog.updateMany({
        where: ownedLease, data: { status: 'sent', detail: null, sentAt: new Date() },
      });
      result.pushed++;
    } else {
      // 下一轮仅重试未成功的渠道，已发送记录保留。
      await prisma.notifyLog.deleteMany({ where: ownedLease });
      result.failed++;
      console.error(`[upgrade] 升级待处理通知发送失败（渠道 ${channel.id}），将在下一轮重试`);
    }
  }
  return result;
}
