import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { prisma } from '../../../lib/prisma';
import { recomputePrimary } from '../../../lib/card-groups';
import type { MigrationInspection, TaskExecutionResult, VersionMigration } from '../migration.types';
import { affectedBankNames } from '../migration-context';

type LinkRepairTarget = {
  cardId: number;
  bankName: string;
  cardLast4: string;
  primaryCardId: number;
  primaryCardLast4: string;
  /** 证据账单：恢复关联所依据的最新一封合并账单 */
  period: string;
  statementDate: string;
};

function itemKeyOf(target: Pick<LinkRepairTarget, 'cardId'>): string {
  return `card:${target.cardId}`;
}

function readTargetPayload(value: unknown): LinkRepairTarget {
  if (!value || typeof value !== 'object') throw new Error('升级任务明细缺少卡片参数');
  const row = value as Record<string, unknown>;
  const cardId = Number(row.cardId);
  const bankName = typeof row.bankName === 'string' ? row.bankName : '';
  const cardLast4 = typeof row.cardLast4 === 'string' ? row.cardLast4 : '';
  const primaryCardId = Number(row.primaryCardId);
  const primaryCardLast4 = typeof row.primaryCardLast4 === 'string' ? row.primaryCardLast4 : '';
  const period = typeof row.period === 'string' ? row.period : '';
  const statementDate = typeof row.statementDate === 'string' ? row.statementDate : '';
  if (
    !Number.isInteger(cardId) || cardId < 1 || !bankName || !cardLast4
    || !Number.isInteger(primaryCardId) || primaryCardId < 1 || !primaryCardLast4
    || !period || !statementDate
  ) {
    throw new Error('升级任务明细卡片参数无效');
  }
  return { cardId, bankName, cardLast4, primaryCardId, primaryCardLast4, period, statementDate };
}

interface OwnerSnapshot {
  id: number;
  bankName: string;
  cardLast4: string;
  statementDay: number;
  dueRule: string;
  dueDay: number | null;
  dueOffsetDays: number | null;
}

/**
 * 扫描「附属卡关联缺失」的卡：businessRole=supplementary 但 businessPrimaryId 为空。
 * 旧版合账只能保留已有关联、不能首次建立关联，导致这类卡独立展示且规则不再跟随更新。
 * 修复证据取 BillCard：该卡以非承接卡身份出现在同银行可见承接卡的账单中，按最新一封挂回。
 */
async function scanLinkRepairTargets(db: PrismaClient | Prisma.TransactionClient): Promise<LinkRepairTarget[]> {
  const orphans = await db.card.findMany({
    where: { businessRole: 'supplementary', businessPrimaryId: null, hidden: false },
    select: { id: true, bankName: true, displayLast4: true },
  });
  if (orphans.length === 0) return [];
  const orphanById = new Map(orphans.map((card) => [card.id, card]));

  const links = await db.billCard.findMany({
    where: { cardId: { in: orphans.map((card) => card.id) } },
    select: { billId: true, cardId: true },
  });
  const billIds = [...new Set(links.map((link) => link.billId))];
  const bills = billIds.length === 0
    ? []
    : await db.bill.findMany({
        where: { id: { in: billIds } },
        select: { id: true, cardId: true, period: true, statementDate: true },
      });
  const billById = new Map(bills.map((bill) => [bill.id, bill]));

  // 候选承接卡：证据账单的承接卡（排除孤卡自己承接的账单），须可见且与孤卡同银行
  const ownerIds = [...new Set(
    bills
      .filter((bill) => !orphanById.has(bill.cardId))
      .map((bill) => bill.cardId),
  )];
  const owners = ownerIds.length === 0
    ? []
    : await db.card.findMany({
        where: { id: { in: ownerIds }, hidden: false },
        select: {
          id: true,
          bankName: true,
          cardLast4: true,
          statementDay: true,
          dueRule: true,
          dueDay: true,
          dueOffsetDays: true,
        },
      });
  const ownerById = new Map<number, OwnerSnapshot>(owners.map((owner) => [owner.id, owner]));

  const targets: LinkRepairTarget[] = [];
  for (const orphan of orphans) {
    // 最新证据账单：出账日新者优先，其次 id 大者
    let latest: { bill: { id: number; period: string; statementDate: Date }; owner: OwnerSnapshot } | null = null;
    for (const link of links) {
      if (link.cardId !== orphan.id) continue;
      const bill = billById.get(link.billId);
      if (!bill || bill.cardId === orphan.id) continue;
      const owner = ownerById.get(bill.cardId);
      if (!owner || owner.bankName !== orphan.bankName) continue;
      if (!latest || bill.statementDate.getTime() > latest.bill.statementDate.getTime()
        || (bill.statementDate.getTime() === latest.bill.statementDate.getTime() && bill.id > latest.bill.id)) {
        latest = { bill, owner };
      }
    }
    if (!latest) continue;
    targets.push({
      cardId: orphan.id,
      bankName: orphan.bankName,
      cardLast4: orphan.displayLast4,
      primaryCardId: latest.owner.id,
      primaryCardLast4: latest.owner.cardLast4,
      period: latest.bill.period,
      statementDate: latest.bill.statementDate.toISOString(),
    });
  }
  return targets.sort((a, b) => a.bankName.localeCompare(b.bankName, 'zh-CN') || a.cardId - b.cardId);
}

export async function inspectSupplementaryLinks(db: PrismaClient | Prisma.TransactionClient): Promise<MigrationInspection | null> {
  const targets = await scanLinkRepairTargets(db);
  if (targets.length === 0) return null;
  const byBank = new Map<string, number>();
  for (const target of targets) byBank.set(target.bankName, (byBank.get(target.bankName) ?? 0) + 1);
  const summary = [...byBank.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
    .map(([bank, count]) => `${bank} ${count} 张卡`)
    .join('、');
  return { total: targets.length, payload: { banks: [...byBank.keys()] }, summary: `待恢复：${summary}` };
}

/** 可选迁移等待期间新账单可继续同步；真正执行前在这里重新扫描最新目标。 */
export async function prepareSupplementaryLinkTask(taskId: number): Promise<void> {
  const targets = await scanLinkRepairTargets(prisma);
  const existing = await prisma.upgradeTaskItem.findMany({ where: { taskId }, select: { itemKey: true } });
  const known = new Set(existing.map((item) => item.itemKey));
  const fresh = targets.filter((target) => !known.has(itemKeyOf(target)));
  if (fresh.length > 0) {
    await prisma.upgradeTaskItem.createMany({
      data: fresh.map((target) => ({ taskId, itemKey: itemKeyOf(target), payload: target })),
    });
  }
  const total = await prisma.upgradeTaskItem.count({ where: { taskId } });
  await prisma.upgradeTask.update({ where: { id: taskId }, data: { total } });
}

async function itemCounts(taskId: number) {
  const groups = await prisma.upgradeTaskItem.groupBy({ by: ['status'], where: { taskId }, _count: true });
  const count = (status: string) => groups.find((group) => group.status === status)?._count ?? 0;
  const succeeded = count('succeeded');
  const unchanged = count('unchanged');
  const failed = count('failed');
  return { succeeded, unchanged, failed, processed: succeeded + unchanged + failed };
}

async function updateTaskCounts(taskId: number): Promise<void> {
  await prisma.upgradeTask.update({ where: { id: taskId }, data: await itemCounts(taskId) });
}

async function markItem(
  item: { id: number; taskId: number },
  status: 'succeeded' | 'unchanged' | 'failed',
  error?: string,
): Promise<void> {
  await prisma.upgradeTaskItem.update({
    where: { id: item.id },
    data: { status, error: error?.slice(0, 512) ?? null, processedAt: new Date() },
  });
  await updateTaskCounts(item.taskId);
}

export async function executeSupplementaryLinkTask(taskId: number): Promise<TaskExecutionResult> {
  await prepareSupplementaryLinkTask(taskId);
  const rows = await prisma.upgradeTaskItem.findMany({
    where: { taskId, status: { in: ['pending', 'failed'] } },
    orderBy: { itemKey: 'asc' },
  });
  // 逐项执行：扫描结果可能已随新账单变化，目标消失记 unchanged（关联已被合账环节建立）
  const targets = await scanLinkRepairTargets(prisma);
  const targetByKey = new Map(targets.map((target) => [itemKeyOf(target), target] as const));

  for (const row of rows) {
    const item = { id: row.id, taskId: row.taskId };
    await prisma.upgradeTaskItem.update({ where: { id: row.id }, data: { status: 'running', error: null } });
    const target = targetByKey.get(row.itemKey);
    if (!target) {
      await markItem(item, 'unchanged');
      continue;
    }
    try {
      const payload = readTargetPayload(row.payload);
      await prisma.$transaction(async (tx) => {
        // 关联指向最新证据账单的承接卡；账期规则对齐承接卡当前规则（尊重每卡独立的手动调整）
        const owner = await tx.card.findUnique({
          where: { id: payload.primaryCardId },
          select: {
            id: true,
            bankName: true,
            hidden: true,
            statementDay: true,
            dueRule: true,
            dueDay: true,
            dueOffsetDays: true,
          },
        });
        if (!owner || owner.hidden || owner.bankName !== payload.bankName) {
          throw new Error('承接卡不存在或已隐藏，无法恢复关联');
        }
        await tx.card.update({
          where: { id: payload.cardId },
          data: {
            businessRole: 'supplementary',
            businessPrimaryId: owner.id,
            businessRelationDate: new Date(payload.statementDate),
            statementDay: owner.statementDay,
            dueRule: owner.dueRule,
            dueDay: owner.dueDay,
            dueOffsetDays: owner.dueOffsetDays,
          },
        });
      });
      await markItem(item, 'succeeded');
    } catch (error) {
      await markItem(item, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  // 关联与规则变化影响归组与优先显示卡，统一重算
  await recomputePrimary();
  const counts = await itemCounts(taskId);
  return {
    succeeded: counts.succeeded,
    unchanged: counts.unchanged,
    failed: counts.failed,
    error: counts.failed > 0 ? '部分附属卡关联恢复失败，请重试' : undefined,
  };
}

export const supplementaryLinkRepairMigration: VersionMigration = {
  key: 'supplementary-link-repair-v1',
  targetVersion: '0.7.0',
  order: 10,
  mode: 'optional',
  title: '恢复附属卡与主卡的关联',
  description: '部分历史附属卡缺少与主卡的关联记录，导致独立展示、账期规则不再跟随主卡更新。根据已有账单恢复关联并校正规则。无需重读邮件，历史账单不变。',
  executeLabel: '现在执行',
  ignoreLabel: '忽略更新',
  ignoreWarning: '忽略后，相关附属卡仍会独立展示，账期规则保持现状；收到新账单后会自动恢复关联。系统将不再提供本次迁移服务。',
  describeImpact({ total, payload }) {
    const banks = affectedBankNames(payload);
    return banks.length > 0 ? `${banks.join('、')} · 共 ${total} 张附属卡` : null;
  },
  inspect: inspectSupplementaryLinks,
  prepareTask: prepareSupplementaryLinkTask,
  executeTask: executeSupplementaryLinkTask,
};
