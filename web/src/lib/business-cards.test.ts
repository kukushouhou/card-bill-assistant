import { describe, expect, it } from 'vitest';
import { businessCoverOf, businessPrimaryFirst, businessPrimaryOf } from './business-cards';

describe('业务主卡封面', () => {
  const cards = [
    { id: 1, businessRole: 'primary' },
    { id: 2, businessRole: 'secondary' },
    { id: 3, businessRole: 'supplementary' },
  ];

  it('副卡或附属卡命中搜索时仍由业务主卡作为列表封面', () => {
    expect(businessPrimaryOf(cards)?.id).toBe(1);
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
});
