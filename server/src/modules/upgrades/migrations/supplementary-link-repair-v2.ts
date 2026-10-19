import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { affectedBankNames } from '../migration-context';
import type { MigrationInspection, VersionMigration } from '../migration.types';
import {
  executeSupplementaryLinkTask,
  prepareSupplementaryLinkTask,
  scanLinkRepairTargets,
  scanSupplementaryLinkEvidence,
  type LinkRepairTarget,
} from './supplementary-link-repair';

function legacySnapshot(itemKey: string, value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const cardId = Number(row.cardId);
  const primaryCardId = Number(row.primaryCardId);
  const statementDate = typeof row.statementDate === 'string' ? new Date(row.statementDate) : null;
  if (!Number.isSafeInteger(cardId) || cardId < 1 || itemKey !== `card:${cardId}`
    || !Number.isSafeInteger(primaryCardId) || primaryCardId < 1
    || typeof row.bankName !== 'string' || !row.bankName
    || !statementDate || !Number.isFinite(statementDate.getTime())) return null;
  return { cardId, primaryCardId, bankName: row.bankName, statementDate };
}

/** 已正确关联不入场；只纠正仍匹配旧任务快照且有执行前证据的错误关联。 */
export async function scanSupplementaryLinkRepairsV2(
  db: PrismaClient | Prisma.TransactionClient,
  cardId?: number,
): Promise<LinkRepairTarget[]> {
  const targets = await scanLinkRepairTargets(db, cardId);
  const history = await db.upgradeTaskItem.findMany({
    where: {
      task: { key: 'supplementary-link-repair-v1' },
      status: { in: ['succeeded', 'failed'] },
      processedAt: { not: null },
      ...(cardId === undefined ? {} : { itemKey: `card:${cardId}` }),
    },
    select: { itemKey: true, payload: true, processedAt: true },
  });
  const snapshots = history.flatMap((item) => {
    const snapshot = legacySnapshot(item.itemKey, item.payload);
    return snapshot && item.processedAt ? [{ ...snapshot, processedAt: item.processedAt }] : [];
  });
  if (!snapshots.length) return targets;
  const cards = await db.card.findMany({
    where: {
      id: { in: snapshots.map((snapshot) => snapshot.cardId) },
      businessRole: 'supplementary', businessPrimaryId: { not: null }, hidden: false,
    },
    select: { id: true, bankName: true, displayLast4: true, businessPrimaryId: true, businessRelationDate: true },
  });
  for (const card of cards) {
    const snapshot = snapshots.find((row) => row.cardId === card.id);
    if (!snapshot || card.bankName !== snapshot.bankName || card.businessPrimaryId !== snapshot.primaryCardId
      || card.businessRelationDate?.getTime() !== snapshot.statementDate.getTime()) continue;
    // 迁移后才新增/改写的账单不能证明旧执行器当时写错，不能据此打扰已正确的用户。
    const [historical] = await scanSupplementaryLinkEvidence(db, [card], snapshot.processedAt);
    if (!historical || historical.primaryCardId === card.businessPrimaryId) continue;
    const [latest] = await scanSupplementaryLinkEvidence(db, [card]);
    if (!latest || latest.primaryCardId === card.businessPrimaryId) continue;
    targets.push({
      ...latest,
      previousPrimaryCardId: snapshot.primaryCardId,
      previousRelationDate: snapshot.statementDate.toISOString(),
    });
  }
  return targets.sort((a, b) => a.bankName.localeCompare(b.bankName, 'zh-CN') || a.cardId - b.cardId);
}

export const supplementaryLinkRepairMigrationV2: VersionMigration = {
  key: 'supplementary-link-repair-v2',
  targetVersion: '0.7.1',
  order: 10,
  mode: 'optional',
  supersedes: ['supplementary-link-repair-v1'],
  title: '修复附属卡与主卡的关联',
  description: '恢复尚未建立的附属卡关联，并纠正上次更新中未正确恢复的关联。已正确建立的关联保持不变。系统将依据最新有效账单恢复关联，并校正账期规则。无需重读邮件，历史账单不变。',
  executeLabel: '现在执行',
  ignoreLabel: '忽略更新',
  ignoreWarning: '忽略后，待修复卡片将保留当前关联和账期规则。系统将不再提供本次迁移服务。',
  describeImpact({ total, payload }) {
    const banks = affectedBankNames(payload);
    return banks.length > 0 ? `${banks.join('、')} · 共 ${total} 张附属卡` : null;
  },
  async inspect(db): Promise<MigrationInspection | null> {
    const targets = await scanSupplementaryLinkRepairsV2(db);
    if (!targets.length) return null;
    return { total: targets.length, payload: { banks: [...new Set(targets.map((target) => target.bankName))] } };
  },
  prepareTask: (taskId) => prepareSupplementaryLinkTask(taskId, scanSupplementaryLinkRepairsV2),
  executeTask: (taskId) => executeSupplementaryLinkTask(taskId, scanSupplementaryLinkRepairsV2),
};
