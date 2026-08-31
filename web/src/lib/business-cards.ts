export function businessPrimaryOf<T extends { businessRole: string }>(cards: readonly T[]): T | undefined {
  return cards.find((card) => card.businessRole === 'primary');
}

/** 明确业务组在展开时固定先展示主卡，其余卡片保持接口原有顺序。 */
export function businessPrimaryFirst<T extends { businessRole: string }>(cards: readonly T[]): T[] {
  const primary = businessPrimaryOf(cards);
  return primary ? [primary, ...cards.filter((card) => card !== primary)] : [...cards];
}

/** 明确业务组永返回账单确定的主卡；普通套卡才使用旧的封面选择。 */
export function businessCoverOf<T extends { businessRole: string }>(
  cards: readonly T[],
  fallback: () => T,
): T {
  return businessPrimaryOf(cards) ?? fallback();
}
