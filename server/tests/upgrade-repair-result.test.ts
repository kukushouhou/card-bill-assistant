import { beforeEach, describe, expect, it, vi } from 'vitest';
import { latestStatementRepairResult } from '../src/modules/upgrades/migrations/repair-statements-050';

const db = vi.hoisted(() => ({
  upgradePlan: { findFirst: vi.fn() },
}));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));

function repairTask(overrides: Record<string, unknown> = {}) {
  return {
    key: 'statement-parser-repair-050-v1',
    status: 'completed',
    toVersion: '0.5.0',
    finishedAt: new Date('2026-09-12T08:00:00Z'),
    payload: { banks: [{ bankName: '光大银行', billCount: 45, mailCount: 40 }] },
    items: [
      { payload: { bankName: '光大银行', billIds: [1, 2], result: { correctedBills: 3, addedBills: 0, addedTransactions: 5, correctedTransactions: 0, removedTransactions: 0, restoredRepayments: 0, fallbackMinimumBills: 0, unavailableMails: 0 } } },
      { payload: { bankName: '中信银行', billIds: [9], incompleteReason: '该邮件无法完整修复，已跳过并保留原账单和明细' } },
    ],
    ...overrides,
  };
}

describe('最近一次升级计划的修复结果', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('没有已完成的升级计划时返回 null', async () => {
    db.upgradePlan.findFirst.mockResolvedValue(null);
    expect(await latestStatementRepairResult()).toBeNull();
  });

  it('最近完成的计划未执行修复时不兜底历史结果', async () => {
    // 历史上曾有一次完成的修复任务，但它属于更早的计划；本次计划只有零账单迁移
    db.upgradePlan.findFirst.mockResolvedValue({
      id: 9,
      status: 'completed',
      tasks: [],
    });
    expect(await latestStatementRepairResult()).toBeNull();
  });

  it('最近完成的计划中修复被忽略或失败时返回 null', async () => {
    db.upgradePlan.findFirst.mockResolvedValue({
      id: 9,
      status: 'completed',
      tasks: [repairTask({ status: 'ignored' })],
    });
    expect(await latestStatementRepairResult()).toBeNull();
  });

  it('最近完成的计划执行了修复时返回该次聚合结果', async () => {
    db.upgradePlan.findFirst.mockResolvedValue({
      id: 9,
      status: 'completed',
      tasks: [repairTask()],
    });
    const result = await latestStatementRepairResult();
    expect(result?.counts).toMatchObject({ correctedBills: 3, addedTransactions: 5 });
    expect(result?.incomplete).toHaveLength(1);
    expect(result?.incomplete[0]).toMatchObject({ bankName: '中信银行', billCount: 1 });
    expect(result?.banks).toEqual([{ bankName: '光大银行', billCount: 45, mailCount: 40 }]);
    expect(result?.version).toBe('0.5.0');
  });
});
