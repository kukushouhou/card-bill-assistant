import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromYmd } from '../src/lib/dates';

const prisma = vi.hoisted(() => ({
  customReminder: { findMany: vi.fn(), findUnique: vi.fn() },
  customReminderOccurrence: { createMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../src/lib/prisma', () => ({ prisma }));

import {
  materializeCustomReminderOccurrences,
  syncOpenCustomReminderOccurrences,
} from '../src/modules/reminders/custom-occurrences';

function reminder(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: '房贷',
    businessType: 'fixed_bill',
    type: 'monthly',
    interval: 1,
    anchorDate: fromYmd('2026-08-01'),
    dayOfWeek: null,
    dayOfMonth: 15,
    monthOfYear: null,
    specificDate: null,
    daysBefore: [7, 3, 0],
    fixedAmount: 5000,
    note: null,
    enabled: true,
    disabledAt: null,
    hideOpenWhenDisabled: false,
    ...overrides,
  };
}

describe('自定义提醒期次物化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.customReminderOccurrence.createMany.mockResolvedValue({ count: 1 });
    prisma.customReminderOccurrence.deleteMany.mockResolvedValue({ count: 1 });
    prisma.customReminderOccurrence.findMany.mockResolvedValue([]);
    prisma.customReminderOccurrence.updateMany.mockResolvedValue({ count: 1 });
  });

  it('到最早提醒日才生成固定账单，并复制固定金额', async () => {
    prisma.customReminder.findMany.mockResolvedValue([reminder()]);

    await materializeCustomReminderOccurrences(fromYmd('2026-08-08'));

    expect(prisma.customReminderOccurrence.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        reminderId: 1,
        targetDate: fromYmd('2026-08-15'),
        availableDate: fromYmd('2026-08-08'),
        amount: 5000,
        suspended: false,
      })],
      skipDuplicates: true,
    });
  });

  it('动态账单生成时金额为空', async () => {
    prisma.customReminder.findMany.mockResolvedValue([reminder({ businessType: 'dynamic_bill', fixedAmount: null })]);
    await materializeCustomReminderOccurrences(fromYmd('2026-08-08'));
    expect(prisma.customReminderOccurrence.createMany.mock.calls[0][0].data[0].amount).toBeNull();
  });

  it('同步只删除未处理期次，停用隐藏模式重建为隐藏', async () => {
    const disabled = reminder({
      enabled: false,
      disabledAt: fromYmd('2026-08-08'),
      hideOpenWhenDisabled: true,
    });
    prisma.customReminder.findUnique.mockResolvedValue(disabled);
    prisma.customReminder.findMany.mockResolvedValue([disabled]);

    await syncOpenCustomReminderOccurrences(1, fromYmd('2026-08-20'));

    expect(prisma.customReminderOccurrence.deleteMany).toHaveBeenCalledWith({
      where: { reminderId: 1, status: 'open' },
    });
    expect(prisma.customReminderOccurrence.createMany.mock.calls[0][0].data[0].suspended).toBe(true);
  });

  it('同一目标日期的动态账单恢复未还后，编辑提醒仍保留已填写金额', async () => {
    const dynamic = reminder({ businessType: 'dynamic_bill', fixedAmount: null });
    prisma.customReminder.findUnique.mockResolvedValue(dynamic);
    prisma.customReminder.findMany.mockResolvedValue([dynamic]);
    prisma.customReminderOccurrence.findMany.mockResolvedValue([{
      targetDate: fromYmd('2026-08-15'),
      businessType: 'dynamic_bill',
      amount: 88.6,
    }]);

    await syncOpenCustomReminderOccurrences(1, fromYmd('2026-08-08'));

    expect(prisma.customReminderOccurrence.updateMany).toHaveBeenCalledWith({
      where: { reminderId: 1, targetDate: fromYmd('2026-08-15'), status: 'open' },
      data: { amount: 88.6 },
    });
  });
});
