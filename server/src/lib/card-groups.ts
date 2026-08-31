import { prisma } from './prisma';
import type { Prisma, PrismaClient } from '../generated/prisma/client';

type CardGroupDb = PrismaClient | Prisma.TransactionClient;

/**
 * 历史同封参考（并查集）：凡曾出现在同一封合并账单（BillCard 关联同一 Bill）的卡互联。
 * 不作为主归组依据，仅作防抖动参考。
 */
export function unionFindGroups(
  cardIds: number[],
  billCards: Array<{ billId: number; cardId: number }>,
): Map<number, number[]> {
  const parent = new Map<number, number>(cardIds.map((id) => [id, id]));
  const known = new Set(cardIds);
  const validBillCards = billCards.filter((bc) => known.has(bc.cardId));
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const byBill = new Map<number, number[]>();
  for (const bc of validBillCards) {
    const list = byBill.get(bc.billId) ?? [];
    list.push(bc.cardId);
    byBill.set(bc.billId, list);
  }
  for (const members of byBill.values()) {
    for (let i = 1; i < members.length; i++) union(members[0]!, members[i]!);
  }

  const groups = new Map<number, number[]>();
  for (const id of cardIds) {
    const root = find(id);
    const list = groups.get(root) ?? [];
    list.push(id);
    groups.set(root, list);
  }
  return groups;
}

export interface CycleGroupCard {
  id: number;
  bankName: string;
  statementDay: number;
  dueRule: string;
  dueDay: number | null;
  dueOffsetDays: number | null;
  businessRole?: string;
  businessPrimaryId?: number | null;
}

/** 规则键：同银行 + 出账日 + 还款规则相同 → 同组 */
export function cycleRuleKey(card: CycleGroupCard): string {
  const duePart = card.dueRule === 'fixed' ? `f${card.dueDay ?? ''}` : `o${card.dueOffsetDays ?? ''}`;
  return `${card.bankName}|${card.statementDay}|${card.dueRule}|${duePart}`;
}

/**
 * 套卡归组：只看出账日与还款规则。
 * 规则相同即同组；没有账单不拆；禁止用账单还款日拆组。
 * 输出 Map 的 key 为组代表卡 ID，value 为组内卡 ID（升序，稳定）
 */
export function groupCardsByCycle(cards: CycleGroupCard[]): Map<number, number[]> {
  const assigned = new Set<number>();
  const groups = new Map<number, number[]>();
  // 只有确实拥有副卡/附属卡的主卡才优先锁定业务组。
  // 单独出现的主卡仍参与后续账期归组，不能仅凭 primary 身份拆成单卡组。
  const primaryIdsWithDependents = new Set(
    cards
      .map((card) => card.businessPrimaryId)
      .filter((id): id is number => id != null),
  );
  const primaries = cards.filter(
    (card) => card.businessRole === 'primary' && primaryIdsWithDependents.has(card.id),
  );
  for (const primary of primaries) {
    const members = cards
      .filter((card) => card.id === primary.id || card.businessPrimaryId === primary.id)
      .map((card) => card.id)
      .sort((a, b) => a - b);
    if (members.length === 0) continue;
    groups.set(primary.id, members);
    for (const id of members) assigned.add(id);
  }

  const buckets = new Map<string, number[]>();
  for (const card of cards) {
    if (assigned.has(card.id)) continue;
    const key = cycleRuleKey(card);
    const list = buckets.get(key) ?? [];
    list.push(card.id);
    buckets.set(key, list);
  }

  for (const members of buckets.values()) {
    const sorted = [...members].sort((a, b) => a - b);
    groups.set(sorted[0]!, sorted);
  }
  return groups;
}

/** 全部套卡组（只看规则，含单卡组） */
export async function allCardGroups(db: CardGroupDb = prisma): Promise<Map<number, number[]>> {
  const cards = await db.card.findMany({
    select: {
      id: true,
      bankName: true,
      statementDay: true,
      dueRule: true,
      dueDay: true,
      dueOffsetDays: true,
      businessRole: true,
      businessPrimaryId: true,
    },
  });
  return groupCardsByCycle(cards);
}

/**
 * 组内优先显示卡：primaryManual=true 压过自动；否则按 priority 金额降序；并列时 ID 升序最小。
 * 单卡组返回 null（isPrimary 恒 false）。不承担主卡权限。isBillOwner 不参与自动选定。
 * 调用方须只传入 status=active 且 hidden=false 的候选；本函数不按卡号过滤。
 */
export function pickPrimaryId(
  members: number[],
  opts: { primaryManualIds: Iterable<number>; priorities: Map<number, number> },
): number | null {
  if (members.length <= 1) return null;
  const sorted = [...members].sort((a, b) => a - b);
  const manuals = new Set(opts.primaryManualIds);
  const manual = sorted.filter((id) => manuals.has(id));
  if (manual.length > 0) return manual[0]!;
  let bestId = sorted[0]!;
  let bestPriority = opts.priorities.get(bestId) ?? 0;
  for (const id of sorted) {
    const n = opts.priorities.get(id) ?? 0;
    if (n > bestPriority) {
      bestPriority = n;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * 归组后标记每组优先显示卡：手动钉住压过自动；否则 priority 降序；并列 ID 升序最小。
 * 只有 status=active 能当主卡；hidden 卡不参与候选；冻结/注销让位复用本函数。单卡组 isPrimary 恒 false。
 */
export async function recomputePrimary(db: CardGroupDb = prisma): Promise<void> {
  const [cards, groups] = await Promise.all([
    db.card.findMany({
      select: {
        id: true,
        isPrimary: true,
        primaryManual: true,
        status: true,
        priority: true,
        hidden: true,
        businessRole: true,
        businessPrimaryId: true,
      },
    }),
    allCardGroups(db),
  ]);
  const cardOf = new Map(cards.map((c) => [c.id, c]));
  const manualIds = cards
    .filter((c) => c.primaryManual && c.status === 'active' && !c.hidden)
    .map((c) => c.id);
  const priorities = new Map<number, number>(cards.map((c) => [c.id, c.priority]));

  for (const members of groups.values()) {
    const businessPrimary = members.find((id) => {
      if (cardOf.get(id)?.businessRole !== 'primary') return false;
      return members.some((memberId) => cardOf.get(memberId)?.businessPrimaryId === id);
    }) ?? null;
    if (businessPrimary != null) {
      for (const id of members) {
        const card = cardOf.get(id);
        if (!card) continue;
        const want = id === businessPrimary;
        if (card.isPrimary !== want || card.primaryManual) {
          await db.card.update({
            where: { id },
            data: { isPrimary: want, primaryManual: false },
          });
        }
      }
      continue;
    }
    const activeMembers = members.filter((id) => {
      const c = cardOf.get(id);
      return c?.status === 'active' && !c.hidden;
    });
    // 多卡组仅 1 张正常卡时仍标它为主卡（其余已冻结/注销/隐藏）；0 张则无主卡
    const primaryId =
      members.length <= 1
        ? null
        : activeMembers.length <= 1
          ? (activeMembers[0] ?? null)
          : pickPrimaryId(activeMembers, { primaryManualIds: manualIds, priorities });
    for (const id of members) {
      const card = cardOf.get(id);
      if (!card) continue;
      const want = primaryId != null && id === primaryId;
      if (card.isPrimary !== want) {
        await db.card.update({ where: { id }, data: { isPrimary: want } });
      }
    }
  }
}
