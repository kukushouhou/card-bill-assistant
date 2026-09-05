interface BusinessCardLike {
  id: number;
  businessRole: string;
  businessPrimaryCardId?: number | null;
}

/** 只有确实拥有副卡/附属卡的主卡才代表明确业务组。 */
export function businessRelationshipPrimaryOf<T extends BusinessCardLike>(cards: readonly T[]): T | undefined {
  return cards.find((card) => (
    card.businessRole === 'primary'
    && cards.some((candidate) => (
      candidate.businessPrimaryCardId === card.id
      && (candidate.businessRole === 'secondary' || candidate.businessRole === 'supplementary')
    ))
  ));
}

/** 明确业务组在展开时固定先展示主卡，其余卡片保持接口原有顺序。 */
export function businessPrimaryFirst<T extends BusinessCardLike>(cards: readonly T[]): T[] {
  const primary = businessRelationshipPrimaryOf(cards);
  return primary ? [primary, ...cards.filter((card) => card !== primary)] : [...cards];
}

/** 明确业务组永返回账单确定的主卡；普通套卡才使用旧的封面选择。 */
export function businessCoverOf<T extends BusinessCardLike>(
  cards: readonly T[],
  fallback: () => T,
): T {
  return businessRelationshipPrimaryOf(cards) ?? fallback();
}

/** 卡片中心永不显示袖标；只有展开明确业务组后才显示。 */
export function shouldShowBusinessRole<T extends BusinessCardLike>(cards: readonly T[], expanded: boolean): boolean {
  return expanded && businessRelationshipPrimaryOf(cards) != null;
}

/** 明确业务组按实际成员区分副卡与附属卡；普通套卡返回 null。 */
export function businessRelationshipLabel<T extends BusinessCardLike>(cards: readonly T[]): string | null {
  if (!businessRelationshipPrimaryOf(cards)) return null;
  const hasSecondary = cards.some((card) => card.businessRole === 'secondary');
  const hasSupplementary = cards.some((card) => card.businessRole === 'supplementary');
  if (hasSecondary && hasSupplementary) return '主卡、副卡与附属卡';
  if (hasSecondary) return '主卡与副卡';
  if (hasSupplementary) return '主卡与附属卡';
  return null;
}

export function cardGroupTitle<T extends BusinessCardLike>(bankName: string, cards: readonly T[]): string {
  return `${bankName} · ${cards.length} 张卡`;
}
