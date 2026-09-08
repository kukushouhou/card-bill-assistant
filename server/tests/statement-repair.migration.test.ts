import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { fallbackStatement } from '../src/modules/upgrades/migrations/statement-repair';
import { repairStatements050Migration } from '../src/modules/upgrades/migrations/repair-statements-050';
import { fromYmd } from '../src/lib/dates';

vi.mock('../src/lib/prisma', () => ({ prisma: {} }));

describe('0.5 历史账单修复入口', () => {
  it('没有来源账单不进迁移，即使存在空卡档案', async () => {
    const db = { mailLog: { findMany: vi.fn().mockResolvedValue([]) }, card: { findMany: vi.fn() } };
    expect(await repairStatements050Migration.inspect(db as unknown as PrismaClient)).toBeNull();
    expect(db.card.findMany).not.toHaveBeenCalled();
    expect(db.mailLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      bills: { some: { source: 'email' } }, status: 'matched',
    }) }));
  });
  it('提示只列实际银行，账单去重计数与来源邮件分开', async () => {
    const db = { mailLog: { findMany: vi.fn().mockResolvedValue([
      { id: 1, accountId: 1, uid: 10, parserId: 'abc2026', bills: [{ id: 101 }, { id: 102 }] },
      { id: 2, accountId: 1, uid: 11, parserId: 'ccb2026', bills: [{ id: 103 }] },
    ]) } };
    const inspection = await repairStatements050Migration.inspect(db as unknown as PrismaClient);
    expect(inspection?.total).toBe(2);
    const text = repairStatements050Migration.describeImpact!(inspection!);
    expect(text).toContain('需要复核');
    expect(text).toContain('农业银行 2 笔现有账单（1 封邮件）');
    expect(text).toContain('建设银行 1 笔现有账单（1 封邮件）');
    expect(text).not.toContain('中信');
  });
});

describe('缺失原文的可靠金额恢复', () => {
  const row = (amount: number, minAmount: number | null) => ({ amount, minAmount, currency: 'CNY', period: '2026-08',
    statementDate: fromYmd('2026-08-13'), dueDate: fromYmd('2026-09-07'), card: { bankName: '测试银行', cardLast4: '1111' }, cards: [],
  }) as unknown as Parameters<typeof fallbackStatement>[0];
  it('农行恢复欠款和溢缴款两个方向', () => {
    expect(fallbackStatement(row(-19.85, -1.98), 'abc2026')).toMatchObject({ amount: 19.85, minAmount: 1.98 });
    expect(fallbackStatement(row(19.85, 0), 'abc2019')).toMatchObject({ amount: -19.85 });
  });
  it('中信旧最低列保存应还总额，缺少该列则失败', () => {
    expect(fallbackStatement(row(50, 70), 'citic2026')).toMatchObject({ amount: 70, minAmount: 70 });
    expect(() => fallbackStatement(row(50, null), 'citic2026')).toThrow('能够恢复应还金额');
    expect(() => fallbackStatement(row(50, 5), 'boc2026')).toThrow('无法可靠恢复');
  });
});
