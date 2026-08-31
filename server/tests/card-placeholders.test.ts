import { describe, expect, it, vi } from 'vitest';
import { reconcileUnfinishedPlaceholderCards } from '../src/lib/card-placeholders';

function card(overrides: Record<string, unknown>) {
  return {
    id: 1,
    bankName: '平安银行',
    cardLast4: '----',
    displayLast4: '----',
    statementDay: 18,
    dueRule: 'offset',
    dueDay: null,
    dueOffsetDays: 19,
    ...overrides,
  };
}

describe('未完善占位卡协调', () => {
  it('同银行同周期存在真实卡时只隐藏占位档案', async () => {
    const db = {
      card: {
        findMany: vi.fn().mockResolvedValue([
          card({ id: 519 }),
          card({ id: 31, cardLast4: '1765', displayLast4: '1765' }),
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const result = await reconcileUnfinishedPlaceholderCards(db as never);
    expect(result.hiddenCardIds).toEqual([519]);
    expect(db.card.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [519] }, hidden: false },
      data: { hidden: true, isPrimary: false, primaryManual: false },
    });
  });

  it('已完善展示尾号的占位档案不自动隐藏', async () => {
    const db = {
      card: {
        findMany: vi.fn().mockResolvedValue([
          card({ id: 9, displayLast4: '3096' }),
          card({ id: 10, cardLast4: '3096', displayLast4: '3096' }),
        ]),
        updateMany: vi.fn(),
      },
    };
    expect((await reconcileUnfinishedPlaceholderCards(db as never)).hiddenCardIds).toEqual([]);
    expect(db.card.updateMany).not.toHaveBeenCalled();
  });

  it('银行或还款周期不同时保留合法占位卡', async () => {
    const db = {
      card: {
        findMany: vi.fn().mockResolvedValue([
          card({ id: 525, bankName: '浦发银行' }),
          card({ id: 30, bankName: '浦发银行', cardLast4: '6688', displayLast4: '6688', dueOffsetDays: 20 }),
          card({ id: 31, cardLast4: '1765', displayLast4: '1765' }),
        ]),
        updateMany: vi.fn(),
      },
    };
    expect((await reconcileUnfinishedPlaceholderCards(db as never)).hiddenCardIds).toEqual([]);
  });
});
