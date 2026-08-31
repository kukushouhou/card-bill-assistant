import type { Prisma } from '../generated/prisma/client';
import { cycleRuleKey } from './card-groups';

const PLACEHOLDER_TAILS = new Set(['----', '0000']);

type CardStore = Pick<Prisma.TransactionClient, 'card'>;

interface ReconcileOptions {
  bankNames?: string[];
}

export interface PlaceholderReconcileResult {
  hiddenCardIds: number[];
}

export async function findUnfinishedPlaceholderCardIds(
  db: CardStore,
  options: ReconcileOptions = {},
): Promise<number[]> {
  const cards = await db.card.findMany({
    where: {
      hidden: false,
      ...(options.bankNames?.length ? { bankName: { in: options.bankNames } } : {}),
    },
    select: {
      id: true,
      bankName: true,
      cardLast4: true,
      displayLast4: true,
      statementDay: true,
      dueRule: true,
      dueDay: true,
      dueOffsetDays: true,
    },
  });

  const realCycleKeys = new Set(
    cards
      // 展示尾号已是四位数字即具有真实卡身份；包含真实 0000 和用户已完善的 ---- 档案。
      .filter((card) => /^\d{4}$/.test(card.displayLast4))
      .map((card) => cycleRuleKey(card)),
  );
  return cards
    .filter((card) => (
      PLACEHOLDER_TAILS.has(card.cardLast4)
      && card.displayLast4 === '----'
      && realCycleKeys.has(cycleRuleKey(card))
    ))
    .map((card) => card.id)
    .sort((a, b) => a - b);
}

/**
 * 未完善占位卡是历史账单的合法归属；同周期真实卡出现后只隐藏档案，不改挂账单。
 * 调用方决定事务边界，并在隐藏后统一重算优先展示卡。
 */
export async function reconcileUnfinishedPlaceholderCards(
  db: CardStore,
  options: ReconcileOptions = {},
): Promise<PlaceholderReconcileResult> {
  const hiddenCardIds = await findUnfinishedPlaceholderCardIds(db, options);

  if (hiddenCardIds.length > 0) {
    await db.card.updateMany({
      where: { id: { in: hiddenCardIds }, hidden: false },
      data: { hidden: true, isPrimary: false, primaryManual: false },
    });
  }
  return { hiddenCardIds };
}
