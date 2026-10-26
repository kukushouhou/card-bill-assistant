import { prisma } from '../../lib/prisma';
import { STATEMENT_REPAIR_KEY } from './migrations/repair-statements-050';
import { ICBC_FOREIGN_REPAIR_KEY, emptyIcbcRepairCounts } from './migrations/repair-icbc-foreign-080';
import { emptyRepairCounts, type RepairCounts } from './migrations/statement-repair';

/** 结果只归属最近完成计划；本轮被忽略/未完成时，不能退回旧修复结果。 */
export async function latestStatementRepairResult() {
  const plan = await prisma.upgradePlan.findFirst({ where: { status: 'completed' },
    orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }], include: { tasks: { include: { items: true } } } });
  const current = plan?.tasks.find(task => task.key === ICBC_FOREIGN_REPAIR_KEY);
  const task = current ?? plan?.tasks.find(task => task.key === STATEMENT_REPAIR_KEY);
  if (!task || task.status !== 'completed') return null;
  const icbc = task.key === ICBC_FOREIGN_REPAIR_KEY;
  const counts = { ...emptyRepairCounts(), ...(icbc ? emptyIcbcRepairCounts() : {}) };
  const incomplete: Array<{ bankName: string; billCount: number; reason: string }> = [];
  const preserved: Array<{ bankName: string; billCount: number; reason: string }> = [];
  for (const item of task.items) {
    const data = item.payload as unknown as { bankName: string; billIds: number[];
      result?: RepairCounts & { uncertainRepayments?: number; skippedBills?: number; reasons?: string[] }; incompleteReason?: string };
    if (data.result) for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key]! += data.result[key] ?? 0;
    if (data.incompleteReason) incomplete.push({ bankName: data.bankName, billCount: data.billIds.length, reason: data.incompleteReason });
    if (data.result?.skippedBills) preserved.push({ bankName: data.bankName, billCount: data.result.skippedBills,
      reason: data.result.reasons?.join('；') ?? '目标无法确认，保留原状' });
  }
  const payload = task.payload as unknown as { banks: Array<{ bankName: string; billCount: number; mailCount: number }>; lowerBound?: string };
  return { kind: icbc ? 'icbc-foreign' : 'statement', version: task.toVersion, finishedAt: task.finishedAt,
    banks: payload.banks, lowerBound: payload.lowerBound, counts, incomplete, ...(icbc ? { preserved } : {}) };
}
