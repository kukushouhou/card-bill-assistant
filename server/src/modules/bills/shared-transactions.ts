import type { Prisma } from '../../generated/prisma/client';

/** 最后一张同币种账单删除后清理共享明细；删除其中一张不会丢失其余账单的共享记录。 */
export async function cleanupOrphanSharedTransactions(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.billTransaction.findMany({ where: { statementMailLogId: { not: null } },
    select: { id: true, currency: true, statementMailLog: { select: { bills: { select: { currency: true } } } } } });
  const orphanIds = rows.filter((row) => !row.statementMailLog?.bills.some((bill) => bill.currency === row.currency)).map((row) => row.id);
  if (orphanIds.length) await tx.billTransaction.deleteMany({ where: { id: { in: orphanIds } } });
}
