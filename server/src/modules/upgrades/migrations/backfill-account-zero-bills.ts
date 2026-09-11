import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { prisma } from '../../../lib/prisma';
import { recomputePrimary } from '../../../lib/card-groups';
import { openMissingCycle } from '../../../modules/bills/ledger';
import { createSiblingZeroBills, inferCardRule } from '../../../parsers/pipeline';
import { listAccountBillParsers } from '../../../parsers/registry';
import type { MigrationInspection, TaskExecutionResult, VersionMigration } from '../migration.types';
import { affectedBankNames } from '../migration-context';

type ZeroBillTarget = {
  cardId: number;
  bankName: string;
  cardLast4: string;
  /** 户身份姓名（附属卡为关联主卡姓名），执行时作为 createSiblingZeroBills 的比对基准 */
  holderName: string;
  period: string;
  statementDate: string;
  dueDate: string;
  currency: string;
};

function itemKeyOf(target: ZeroBillTarget): string {
  return `card:${target.cardId}:${target.period}:${target.currency}`;
}

function readTargetPayload(value: unknown): ZeroBillTarget {
  if (!value || typeof value !== 'object') throw new Error('升级任务明细缺少卡片参数');
  const row = value as Record<string, unknown>;
  const cardId = Number(row.cardId);
  const bankName = typeof row.bankName === 'string' ? row.bankName : '';
  const cardLast4 = typeof row.cardLast4 === 'string' ? row.cardLast4 : '';
  const holderName = typeof row.holderName === 'string' ? row.holderName : '';
  const period = typeof row.period === 'string' ? row.period : '';
  const statementDate = typeof row.statementDate === 'string' ? row.statementDate : '';
  const dueDate = typeof row.dueDate === 'string' ? row.dueDate : '';
  const currency = typeof row.currency === 'string' ? row.currency : '';
  if (
    !Number.isInteger(cardId) || cardId < 1 || !bankName || !holderName
    || !period || !statementDate || !dueDate || !currency
  ) {
    throw new Error('升级任务明细卡片参数无效');
  }
  return { cardId, bankName, cardLast4, holderName, period, statementDate, dueDate, currency };
}

/**
 * 扫描户级账单银行「当前待还账期」需要补零账单的卡：
 * 每户（银行 + 户身份）取最新一张账单作为该户账期真相，规则按该账单同步后，
 * 仍处于「未取得账单」窗口（openMissingCycle 非空）且该期无自有/关联账单的活跃卡即为目标。
 * 只覆盖当前账期，不回填历史。
 */
async function scanAccountZeroBillTargets(db: PrismaClient | Prisma.TransactionClient): Promise<ZeroBillTarget[]> {
  const banks = listAccountBillParsers().map((parser) => parser.bankName);
  if (banks.length === 0) return [];

  const cards = await db.card.findMany({
    where: { bankName: { in: banks }, hidden: false },
    select: {
      id: true,
      bankName: true,
      cardLast4: true,
      displayLast4: true,
      holderName: true,
      status: true,
      businessRole: true,
      businessPrimaryId: true,
      statementDay: true,
      dueRule: true,
      dueDay: true,
      dueOffsetDays: true,
    },
  });
  const primaryIdSet = new Set(
    cards.map((card) => card.businessPrimaryId).filter((id): id is number => id != null),
  );
  const primaryNames = new Map<number, string | null>();
  if (primaryIdSet.size > 0) {
    const primaries = await db.card.findMany({
      where: { id: { in: [...primaryIdSet] } },
      select: { id: true, holderName: true },
    });
    for (const primary of primaries) primaryNames.set(primary.id, primary.holderName);
  }
  const identityOf = (card: {
    holderName: string | null;
    businessRole: string;
    businessPrimaryId: number | null;
  }): string | null => {
    const name = card.businessRole === 'supplementary' && card.businessPrimaryId != null
      ? primaryNames.get(card.businessPrimaryId) ?? null
      : card.holderName;
    return name?.trim() || null;
  };

  const bills = await db.bill.findMany({
    where: { card: { bankName: { in: banks } } },
    select: {
      id: true,
      cardId: true,
      period: true,
      statementDate: true,
      dueDate: true,
      currency: true,
      card: { select: { bankName: true, holderName: true, businessRole: true, businessPrimaryId: true } },
    },
  });
  // 每户（银行 + 身份）最新一张账单：出账日新者优先，其次 CNY，再次 id 大者
  const newer = (
    a: (typeof bills)[number],
    b: (typeof bills)[number],
  ): number =>
    b.statementDate.getTime() - a.statementDate.getTime()
    || (b.currency === 'CNY' ? 1 : 0) - (a.currency === 'CNY' ? 1 : 0)
    || b.id - a.id;
  const latestByHousehold = new Map<string, (typeof bills)[number]>();
  for (const bill of bills) {
    const identity = identityOf(bill.card);
    if (!identity) continue;
    const key = `${bill.card.bankName}|${identity}`;
    const current = latestByHousehold.get(key);
    if (!current || newer(current, bill) > 0) latestByHousehold.set(key, bill);
  }

  // 该期已有账单（自有或关联，含手动标记）的卡跳过
  const billById = new Map(bills.map((bill) => [bill.id, bill] as const));
  const billIds = bills.map((bill) => bill.id);
  const ownCovered = new Set<string>();
  const linkedCovered = new Set<string>();
  for (const bill of bills) ownCovered.add(`${bill.cardId}:${bill.period}`);
  if (billIds.length > 0) {
    const links = await db.billCard.findMany({
      where: { billId: { in: billIds } },
      select: { billId: true, cardId: true },
    });
    for (const link of links) {
      const bill = billById.get(link.billId);
      if (bill) linkedCovered.add(`${link.cardId}:${bill.period}`);
    }
  }

  const now = new Date();
  const targets: ZeroBillTarget[] = [];
  for (const card of cards) {
    const identity = identityOf(card);
    if (!identity) continue;
    const latest = latestByHousehold.get(`${card.bankName}|${identity}`);
    if (!latest) continue;
    // 规则按最新账单同步后再判断当前待还窗口（陈旧规则会算错账期）
    const rule = inferCardRule(latest.statementDate, latest.dueDate);
    const cycle = openMissingCycle(
      {
        statementDay: rule.statementDay,
        dueRule: rule.dueRule,
        dueDay: rule.dueDay,
        dueOffsetDays: rule.dueOffsetDays,
        status: card.status,
        businessPrimaryId: card.businessPrimaryId,
      },
      now,
    );
    if (!cycle || cycle.period !== latest.period) continue;
    const key = `${card.id}:${latest.period}`;
    if (ownCovered.has(key) || linkedCovered.has(key)) continue;
    targets.push({
      cardId: card.id,
      bankName: card.bankName,
      cardLast4: card.displayLast4,
      holderName: identity,
      period: latest.period,
      statementDate: latest.statementDate.toISOString(),
      dueDate: latest.dueDate.toISOString(),
      currency: latest.currency,
    });
  }
  return targets.sort((a, b) => a.bankName.localeCompare(b.bankName, 'zh-CN') || a.cardId - b.cardId);
}

export async function inspectAccountZeroBills(db: PrismaClient | Prisma.TransactionClient): Promise<MigrationInspection | null> {
  const targets = await scanAccountZeroBillTargets(db);
  if (targets.length === 0) return null;
  const byBank = new Map<string, number>();
  for (const target of targets) byBank.set(target.bankName, (byBank.get(target.bankName) ?? 0) + 1);
  const summary = [...byBank.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
    .map(([bank, count]) => `${bank} ${count} 张卡`)
    .join('、');
  return { total: targets.length, payload: { banks: [...byBank.keys()] }, summary: `待更新：${summary}` };
}

/** 可选迁移等待期间邮件可继续同步；真正执行前在这里重新扫描最新目标。 */
export async function prepareZeroBillTask(taskId: number): Promise<void> {
  const targets = await scanAccountZeroBillTargets(prisma);
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

export async function executeZeroBillTask(taskId: number): Promise<TaskExecutionResult> {
  await prepareZeroBillTask(taskId);
  const rows = await prisma.upgradeTaskItem.findMany({
    where: { taskId, status: { in: ['pending', 'failed'] } },
    orderBy: { itemKey: 'asc' },
  });
  // 逐项执行：扫描结果可能已随新邮件变化，目标消失记 unchanged（真实账单已到或期次已滚走）
  const targets = await scanAccountZeroBillTargets(prisma);
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
        await createSiblingZeroBills(tx, {
          bankName: payload.bankName,
          period: payload.period,
          statementDate: new Date(payload.statementDate),
          dueDate: new Date(payload.dueDate),
          currency: payload.currency,
          excludeCardIds: [],
          holderName: payload.holderName,
        });
      });
      await markItem(item, 'succeeded');
    } catch (error) {
      await markItem(item, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  // 规则传播改变了归组键，重算优先显示卡
  await recomputePrimary();
  const counts = await itemCounts(taskId);
  return {
    succeeded: counts.succeeded,
    unchanged: counts.unchanged,
    failed: counts.failed,
    error: counts.failed > 0 ? '部分卡片零账单补齐失败，请重试' : undefined,
  };
}

export const accountZeroBillsMigration: VersionMigration = {
  key: 'account-zero-bills-current-v1',
  targetVersion: '0.4.1',
  order: 10,
  mode: 'optional',
  title: '修正本期账单状态',
  description: '根据已收到的本期账单，将误显示的「未取得账单」改为「无需还款」，并校正相关卡片的出账日和还款日。无需重读邮件，历史账单不变。',
  executeLabel: '现在执行',
  ignoreLabel: '忽略更新',
  ignoreWarning: '忽略后，本期仍可能显示「未取得账单」并产生多余提醒；收到下期账单后会正常处理。系统将不再提供本次迁移服务。',
  describeImpact({ total, payload }) {
    const banks = affectedBankNames(payload);
    return banks.length > 0 ? `${banks.join('、')} · 共 ${total} 张卡的本期账单` : null;
  },
  inspect: inspectAccountZeroBills,
  prepareTask: prepareZeroBillTask,
  executeTask: executeZeroBillTask,
};
