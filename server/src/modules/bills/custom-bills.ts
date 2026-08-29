import { daysBetween, shanghaiMidnight, ymd } from '../../lib/dates';
import { customOccurrenceRemaining, occurrenceToView } from '../reminders/custom-occurrences';

export interface CustomBillDatabaseRow {
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
}

export function customBillView(row: CustomBillDatabaseRow, now: Date) {
  const occurrence = occurrenceToView(row);
  const overdueDays = occurrence.status === 'open'
    ? daysBetween(shanghaiMidnight(occurrence.targetDate), shanghaiMidnight(now))
    : 0;
  return {
    recordType: 'custom' as const,
    id: occurrence.id,
    customOccurrenceId: occurrence.id,
    customReminderId: occurrence.reminderId,
    customBusinessType: occurrence.businessType,
    customName: occurrence.name,
    note: occurrence.note,
    cardId: null,
    bankName: null,
    cardLast4: null,
    cardTails: [] as string[],
    period: ymd(occurrence.targetDate).slice(0, 7),
    statementDate: null,
    dueDate: occurrence.targetDate,
    amount: occurrence.amount,
    remainingAmount: customOccurrenceRemaining(occurrence),
    minAmount: null,
    currency: 'CNY',
    paidStatus: occurrence.status === 'paid' ? 'paid' as const : 'unpaid' as const,
    paidAt: occurrence.completedAt,
    paidAmount: occurrence.status === 'paid' ? occurrence.amount : null,
    hasDetails: false,
    annualFeeAmount: null,
    source: 'custom' as const,
    missing: false,
    daysOverdue: overdueDays > 0 ? overdueDays : null,
  };
}

export function sortCombinedBillRows<T extends { paidStatus: string | null; dueDate: Date; id: number | null }>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    const aPaid = a.paidStatus === 'paid';
    const bPaid = b.paidStatus === 'paid';
    if (aPaid !== bPaid) return aPaid ? 1 : -1;
    const dueDiff = a.dueDate.getTime() - b.dueDate.getTime();
    if (dueDiff !== 0) return aPaid ? -dueDiff : dueDiff;
    return aPaid ? (b.id ?? 0) - (a.id ?? 0) : (a.id ?? 0) - (b.id ?? 0);
  });
}

export function customBillTrendRows(rows: CustomBillDatabaseRow[]): Array<{ period: string; amount: number | null }> {
  return rows.map((row) => ({
    period: ymd(row.targetDate).slice(0, 7),
    amount: row.amount == null ? null : Number(row.amount),
  }));
}
