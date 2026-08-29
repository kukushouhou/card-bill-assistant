import { addDays, daysBetween, shanghaiMidnight, today, ymd } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import {
  customTargetDatesBetween,
  occurrenceAvailableDate,
  type CustomReminderBusinessType,
  type CustomScheduleLike,
} from './custom-schedule';

export interface CustomOccurrenceLike {
  id: number;
  reminderId: number | null;
  name: string;
  businessType: string;
  targetDate: Date;
  availableDate: Date;
  daysBefore: number[];
  note: string | null;
  amount: number | null;
  status: string;
  completedAt: Date | null;
  suspended: boolean;
}

function scheduleOf(reminder: {
  type: string;
  interval: number;
  anchorDate: Date;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  monthOfYear: number | null;
  specificDate: Date | null;
}): CustomScheduleLike {
  return reminder;
}

/**
 * 将已经到最早提醒日的目标日期物化为期次。重复调用依靠唯一键保持幂等。
 * disabledCutoff 用于编辑已停用提醒时重建停用前已经存在的未处理期次。
 */
export async function materializeCustomReminderOccurrences(
  now: Date = today(),
  reminderIds?: number[],
  disabledCutoff?: Date,
): Promise<number> {
  const reminders = await prisma.customReminder.findMany({
    where: {
      ...(reminderIds ? { id: { in: reminderIds } } : {}),
      ...(disabledCutoff ? {} : { enabled: true }),
    },
  });
  let created = 0;
  for (const reminder of reminders) {
    const daysBefore = ((reminder.daysBefore as number[]) ?? []).filter(Number.isInteger);
    const lead = daysBefore.length > 0 ? Math.max(...daysBefore) : 0;
    const cutoff = shanghaiMidnight(disabledCutoff ?? now);
    const horizon = addDays(cutoff, lead);
    const targets = customTargetDatesBetween(scheduleOf(reminder), reminder.anchorDate, horizon);
    const data = targets
      .filter((targetDate) => occurrenceAvailableDate(targetDate, daysBefore) <= cutoff)
      .map((targetDate) => ({
        reminderId: reminder.id,
        name: reminder.name,
        businessType: reminder.businessType,
        targetDate,
        availableDate: occurrenceAvailableDate(targetDate, daysBefore),
        daysBefore,
        note: reminder.note,
        amount: reminder.businessType === 'fixed_bill' ? reminder.fixedAmount : null,
        suspended: !reminder.enabled && reminder.hideOpenWhenDisabled,
      }));
    if (data.length === 0) continue;
    const result = await prisma.customReminderOccurrence.createMany({ data, skipDuplicates: true });
    created += result.count;
  }
  return created;
}

/** 未处理期次随提醒条目重建；已完成/已还款快照不改。 */
export async function syncOpenCustomReminderOccurrences(reminderId: number, now: Date = today()): Promise<void> {
  const reminder = await prisma.customReminder.findUnique({ where: { id: reminderId } });
  if (!reminder) return;
  const previous = await prisma.customReminderOccurrence.findMany({
    where: { reminderId, status: 'open' },
    select: { targetDate: true, businessType: true, amount: true },
  });
  await prisma.customReminderOccurrence.deleteMany({ where: { reminderId, status: 'open' } });
  const cutoff = reminder.enabled ? undefined : reminder.disabledAt ?? now;
  await materializeCustomReminderOccurrences(now, [reminderId], cutoff);
  // 动态账单恢复未还后仍保留本期金额；仅同一目标日期继承，周期改动产生的新期次不串金额。
  for (const occurrence of previous) {
    if (occurrence.businessType !== 'dynamic_bill' || occurrence.amount == null) continue;
    await prisma.customReminderOccurrence.updateMany({
      where: { reminderId, targetDate: occurrence.targetDate, status: 'open' },
      data: { amount: occurrence.amount },
    });
  }
}

export function occurrenceToView(occurrence: {
  id: number;
  reminderId: number | null;
  name: string;
  businessType: string;
  targetDate: Date;
  availableDate: Date;
  daysBefore: unknown;
  note: string | null;
  amount: unknown;
  status: string;
  completedAt: Date | null;
  suspended: boolean;
}): CustomOccurrenceLike {
  return {
    ...occurrence,
    daysBefore: ((occurrence.daysBefore as number[]) ?? []).filter(Number.isInteger),
    amount: occurrence.amount == null ? null : Number(occurrence.amount),
  };
}

export function customOccurrenceDaysOverdue(occurrence: Pick<CustomOccurrenceLike, 'targetDate' | 'status'>, now: Date): number | null {
  if (occurrence.status !== 'open') return null;
  const days = daysBetween(shanghaiMidnight(occurrence.targetDate), shanghaiMidnight(now));
  return days > 0 ? days : null;
}

export function customOccurrenceRemaining(occurrence: Pick<CustomOccurrenceLike, 'amount' | 'status'>): number | null {
  if (occurrence.amount == null) return null;
  return occurrence.status === 'paid' ? 0 : occurrence.amount;
}

export function customOccurrencePeriod(occurrence: Pick<CustomOccurrenceLike, 'targetDate'>): string {
  return ymd(occurrence.targetDate).slice(0, 7);
}

export function isCustomBillType(type: string): type is Exclude<CustomReminderBusinessType, 'general'> {
  return type === 'fixed_bill' || type === 'dynamic_bill';
}
