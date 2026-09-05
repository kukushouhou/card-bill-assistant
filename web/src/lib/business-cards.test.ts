import { describe, expect, it } from 'vitest';
import {
  businessCoverOf,
  businessPrimaryFirst,
  businessRelationshipLabel,
  businessRelationshipPrimaryOf,
  cardGroupTitle,
  shouldShowBusinessRole,
} from './business-cards';

describe('业务主卡封面', () => {
  const cards = [
    { id: 1, businessRole: 'primary', businessPrimaryCardId: null },
    { id: 2, businessRole: 'secondary', businessPrimaryCardId: 1 },
    { id: 3, businessRole: 'supplementary', businessPrimaryCardId: 1 },
  ];

  it('副卡或附属卡命中搜索时仍由业务主卡作为列表封面', () => {
    expect(businessRelationshipPrimaryOf(cards)?.id).toBe(1);
    expect(businessCoverOf(cards, () => cards[1]!).id).toBe(1);
  });

  it('普通套卡保留原有封面选择', () => {
    const standalone = [{ id: 4, businessRole: 'standalone' }, { id: 5, businessRole: 'standalone' }];
    expect(businessCoverOf(standalone, () => standalone[1]!).id).toBe(5);
  });

  it('展开明确业务组时主卡固定排在最前，其余卡片维持原顺序', () => {
    const unordered = [cards[1]!, cards[2]!, cards[0]!];
    expect(businessPrimaryFirst(unordered).map((card) => card.id)).toEqual([1, 2, 3]);
  });

  it('普通套卡展开顺序不变', () => {
    const standalone = [{ id: 5, businessRole: 'standalone' }, { id: 4, businessRole: 'standalone' }];
    expect(businessPrimaryFirst(standalone).map((card) => card.id)).toEqual([5, 4]);
  });

  it('没有子卡的主卡仍按普通套卡封面和原顺序处理', () => {
    const primaries = [
      { id: 6, businessRole: 'primary', businessPrimaryCardId: null },
      { id: 7, businessRole: 'primary', businessPrimaryCardId: null },
    ];
    expect(businessRelationshipPrimaryOf(primaries)).toBeUndefined();
    expect(businessCoverOf(primaries, () => primaries[1]!).id).toBe(7);
    expect(businessPrimaryFirst(primaries).map((card) => card.id)).toEqual([6, 7]);
  });

  it('卡片中心不显示袖标，只有展开明确业务组后才显示', () => {
    expect(shouldShowBusinessRole(cards, false)).toBe(false);
    expect(shouldShowBusinessRole(cards, true)).toBe(true);
    expect(shouldShowBusinessRole([
      { id: 6, businessRole: 'primary', businessPrimaryCardId: null },
      { id: 7, businessRole: 'primary', businessPrimaryCardId: null },
    ], true)).toBe(false);
  });

  it('业务组标题按实际成员区分副卡和附属卡', () => {
    const secondary = [cards[0]!, cards[1]!];
    const supplementary = [cards[0]!, cards[2]!];
    expect(businessRelationshipLabel(secondary)).toBe('主卡与副卡');
    expect(businessRelationshipLabel(supplementary)).toBe('主卡与附属卡');
    expect(businessRelationshipLabel(cards)).toBe('主卡、副卡与附属卡');
    expect(cardGroupTitle('平安银行', supplementary)).toBe('平安银行 · 2 张卡');
  });

  it('套卡标题统一显示银行与卡片数量', () => {
    const ordinary = [
      { id: 6, businessRole: 'primary', businessPrimaryCardId: null },
      { id: 7, businessRole: 'primary', businessPrimaryCardId: null },
    ];
    expect(businessRelationshipLabel(ordinary)).toBeNull();
    expect(cardGroupTitle('平安银行', ordinary)).toBe('平安银行 · 2 张卡');
  });
});
