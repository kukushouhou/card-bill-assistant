import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  card: { findMany: vi.fn(), update: vi.fn() },
  bill: { findMany: vi.fn() },
}));
vi.mock('../src/lib/prisma', () => ({ prisma }));

import { groupCardsByCycle, pickPrimaryId, recomputePrimary, unionFindGroups, type CycleGroupCard } from '../src/lib/card-groups';

describe('账户分组并查集（unionFindGroups）', () => {
  it('无合并账单：各自成单卡组', () => {
    const groups = unionFindGroups([1, 2, 3], []);
    expect(groups.size).toBe(3);
    expect(groups.get(1)).toEqual([1]);
    expect(groups.get(2)).toEqual([2]);
    expect(groups.get(3)).toEqual([3]);
  });

  it('同一封合并账单的卡归为一个账户组', () => {
    // 账单 A（id=10）：卡 1、2、3；账单 B（id=11）：卡 3、4 → 全部互联
    const groups = unionFindGroups(
      [1, 2, 3, 4, 5],
      [
        { billId: 10, cardId: 1 },
        { billId: 10, cardId: 2 },
        { billId: 10, cardId: 3 },
        { billId: 11, cardId: 3 },
        { billId: 11, cardId: 4 },
      ],
    );
    expect(groups.size).toBe(2);
    const members = [...groups.values()].sort((a, b) => a.length - b.length);
    expect(members[0]).toEqual([5]);
    expect(new Set(members[1])).toEqual(new Set([1, 2, 3, 4]));
  });

  it('不同账单的相同卡组保持一组（历史多期合并账单）', () => {
    // 民生 10 张卡连续多月合并出账：每期账单都是同一批卡
    const cardIds = Array.from({ length: 10 }, (_, i) => i + 1);
    const billCards = [1, 2, 3].flatMap((billId) => cardIds.map((cardId) => ({ billId, cardId })));
    const groups = unionFindGroups(cardIds, billCards);
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toHaveLength(10);
  });

  it('跨组传递：A-B 同账单、C-D 同账单、B-C 同账单 → 四卡一组', () => {
    const groups = unionFindGroups(
      [1, 2, 3, 4],
      [
        { billId: 1, cardId: 1 },
        { billId: 1, cardId: 2 },
        { billId: 2, cardId: 3 },
        { billId: 2, cardId: 4 },
        { billId: 3, cardId: 2 },
        { billId: 3, cardId: 3 },
      ],
    );
    expect(groups.size).toBe(1);
    expect(new Set([...groups.values()][0])).toEqual(new Set([1, 2, 3, 4]));
  });

  it('BillCard 中出现未知卡 ID 不影响分组（防御脏数据）', () => {
    const groups = unionFindGroups(
      [1, 2],
      [
        { billId: 1, cardId: 1 },
        { billId: 1, cardId: 99 },
      ],
    );
    expect(groups.get(1)).toEqual([1]);
    expect(groups.get(2)).toEqual([2]);
  });
});

describe('套卡归组（groupCardsByCycle）', () => {
  function card(id: number, overrides: Partial<CycleGroupCard> = {}): CycleGroupCard {
    return {
      id,
      bankName: '招商银行',
      statementDay: 5,
      dueRule: 'offset',
      dueDay: null,
      dueOffsetDays: 18,
      ...overrides,
    };
  }

  it('同银行同规则归为一组', () => {
    const groups = groupCardsByCycle([card(1), card(2), card(3, { bankName: '平安银行' })]);
    expect([...groups.values()].sort((a, b) => a.length - b.length)).toEqual([[3], [1, 2]]);
  });

  it('还款规则不同拆开', () => {
    const groups = groupCardsByCycle([card(1), card(2, { dueOffsetDays: 20 })]);
    expect(groups.size).toBe(2);
  });

  it('账单还款日不同但规则相同仍同组（不用账单还款日拆组）', () => {
    const groups = groupCardsByCycle([card(1), card(2), card(3)]);
    expect([...groups.values()][0]).toEqual([1, 2, 3]);
  });

  it('没有账单仍按规则同组', () => {
    const groups = groupCardsByCycle([card(1), card(2)]);
    expect([...groups.values()][0]).toEqual([1, 2]);
  });

  it('改一张套卡的出账日后不再与原组共用成员，且单卡组不标优先', () => {
    const groups = groupCardsByCycle([card(1), card(2, { statementDay: 10 })]);
    expect(groups.get(1)).toEqual([1]);
    expect(groups.get(2)).toEqual([2]);
    expect(pickPrimaryId([2], { primaryManualIds: [], priorities: new Map([[2, 5]]) })).toBeNull();
  });
});

describe('优先显示推导（pickPrimaryId）', () => {
  it('单卡组不标记优先', () => {
    expect(pickPrimaryId([1], { primaryManualIds: [1], priorities: new Map([[1, 9]]) })).toBeNull();
  });

  it('primaryManual 压过金额分', () => {
    expect(pickPrimaryId([1, 2], { primaryManualIds: [1], priorities: new Map([[2, 900], [1, 1]]) })).toBe(1);
  });

  it('无手动指定时取 priority 最高的卡', () => {
    expect(pickPrimaryId([1, 2], { primaryManualIds: [], priorities: new Map([[1, 300], [2, 100]]) })).toBe(1);
  });

  it('priority 并列时取组内 ID 升序最小', () => {
    expect(pickPrimaryId([3, 1], { primaryManualIds: [], priorities: new Map() })).toBe(1);
    expect(pickPrimaryId([3, 1], { primaryManualIds: [], priorities: new Map([[1, 2], [3, 2]]) })).toBe(1);
  });
});

function cardRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    isPrimary: false,
    primaryManual: false,
    status: 'active',
    hidden: false,
    priority: 0,
    bankName: '招商银行',
    statementDay: 5,
    dueRule: 'offset',
    dueDay: null,
    dueOffsetDays: 18,
    ...overrides,
  };
}

describe('recomputePrimary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.card.update.mockResolvedValue({});
  });

  it('无手动指定时优先标记 priority 最高的卡', async () => {
    prisma.card.findMany.mockResolvedValue([
      cardRow(1, { priority: 300 }),
      cardRow(2, { isPrimary: true, priority: 100 }),
    ]);
    await recomputePrimary();
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { isPrimary: false } });
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { isPrimary: true } });
  });

  it('改规则拆成单卡组后 isPrimary 恒 false', async () => {
    prisma.card.findMany.mockResolvedValue([
      cardRow(1, { isPrimary: true }),
      cardRow(2, { statementDay: 10 }),
    ]);
    await recomputePrimary();
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { isPrimary: false } });
    expect(prisma.card.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 2 } }));
  });

  it('主卡冻结后让位给 priority 最高的正常卡，冻结卡不能当主卡', async () => {
    prisma.card.findMany.mockResolvedValue([
      cardRow(1, { isPrimary: true, status: 'frozen', priority: 900 }),
      cardRow(2, { priority: 10 }),
      cardRow(3, { priority: 100 }),
    ]);
    await recomputePrimary();
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { isPrimary: false } });
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { isPrimary: true } });
  });

  it('身份 ---- 卡按普通卡对待，不因卡号排除', async () => {
    prisma.card.findMany.mockResolvedValue([
      cardRow(1, { cardLast4: '----', priority: 20 }),
      cardRow(2, { isPrimary: true, cardLast4: '3096', priority: 10 }),
    ]);
    await recomputePrimary();
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { isPrimary: false } });
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { isPrimary: true } });
  });

  it('组内全部冻结则无主卡', async () => {
    prisma.card.findMany.mockResolvedValue([
      cardRow(1, { isPrimary: true, status: 'frozen' }),
      cardRow(2, { status: 'closed' }),
    ]);
    await recomputePrimary();
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { isPrimary: false } });
    expect(prisma.card.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 2 } }));
  });

  it('hidden 卡不参与主卡候选，即使 status=active 且 priority 更高', async () => {
    prisma.card.findMany.mockResolvedValue([
      cardRow(1, { hidden: true, priority: 900, isPrimary: true }),
      cardRow(2, { priority: 10 }),
    ]);
    await recomputePrimary();
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { isPrimary: false } });
    expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { isPrimary: true } });
  });
});
