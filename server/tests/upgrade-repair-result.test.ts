import { beforeEach, describe, expect, it, vi } from 'vitest';
import { latestStatementRepairResult } from '../src/modules/upgrades/statement-repair-result';

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

  it.each([
    { executed: [] }, { executed: ['平安银行'] }, { executed: ['民生银行'] }, { executed: ['广发银行'] },
    { executed: ['平安银行', '民生银行'] }, { executed: ['平安银行', '广发银行'] },
    { executed: ['民生银行', '广发银行'] }, { executed: ['平安银行', '民生银行', '广发银行'] },
  ])('三家银行只汇总已执行项目 $executed，全部忽略时不显示旧结果', async ({ executed }) => {
    const pab = repairTask({ key: 'pab-details-repair-085-v1', toVersion: '0.8.5',
      payload: { banks: [{ bankName: '平安银行', billCount: 8, mailCount: 4 }] },
      items: [{ payload: { bankName: '平安银行', billIds: [1], result: { addedTransactions: 12 } } }] });
    const cmbc = repairTask({ key: 'cmbc-details-repair-085-v1', toVersion: '0.8.5',
      payload: { banks: [{ bankName: '民生银行', billCount: 18, mailCount: 9 }] },
      items: [{ payload: { bankName: '民生银行', billIds: [2], result: { correctedTransactions: 31 } } }] });
    const cgb = repairTask({ key: 'cgb-statement-recovery-085-v1', toVersion: '0.8.5',
      payload: { banks: [{ bankName: '广发银行', billCount: 0, mailCount: 60 }] },
      items: [{ payload: { bankName: '广发银行', billIds: [], result: { addedBills: 202, addedTransactions: 145 } } }] });
    const tasks = [pab, cmbc, cgb].map(task => ({ ...task,
      status: executed.includes(task.payload.banks[0]!.bankName) ? 'completed' : 'ignored' }));
    db.upgradePlan.findFirst.mockResolvedValue({ tasks: [repairTask(), ...tasks] });
    if (!executed.length) {
      expect(await latestStatementRepairResult()).toBeNull();
      return;
    }
    expect(await latestStatementRepairResult()).toMatchObject({ kind: 'bank-statements', version: '0.8.5',
      counts: { addedBills: executed.includes('广发银行') ? 202 : 0,
        addedTransactions: (executed.includes('平安银行') ? 12 : 0) + (executed.includes('广发银行') ? 145 : 0),
        correctedTransactions: executed.includes('民生银行') ? 31 : 0, correctedBills: 0 },
      banks: executed.map(bankName => ({ bankName })) });
  });

  it('农行恢复展示本次补单和缺失邮件结果，零张旧账单也能报告', async () => {
    db.upgradePlan.findFirst.mockResolvedValue({ tasks: [repairTask(), repairTask({
      key: 'abc-statement-repair-084-v1', toVersion: '0.8.4',
      payload: { banks: [{ bankName: '农业银行', mailCount: 2, billCount: 0 }] },
      items: [{ payload: { bankName: '农业银行', billIds: [], result: { addedBills: 1, addedTransactions: 8 } } },
        { payload: { bankName: '农业银行', billIds: [], result: { unavailableMails: 1 }, incompleteReason: '邮件已删除' } }],
    })] });
    expect(await latestStatementRepairResult()).toMatchObject({ kind: 'abc-statement', version: '0.8.4',
      counts: { addedBills: 1, addedTransactions: 8, unavailableMails: 1, correctedBills: 0 },
      incomplete: [{ bankName: '农业银行', billCount: 0, reason: '邮件已删除' }] });
  });

  it('本轮忽略农行恢复时不显示旧迁移结果', async () => {
    db.upgradePlan.findFirst.mockResolvedValue({ tasks: [repairTask(), repairTask({ key: 'abc-statement-repair-084-v1', status: 'ignored' })] });
    expect(await latestStatementRepairResult()).toBeNull();
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
  it.each(['ignored', 'failed'])('本轮工行 %s 不退回同计划旧0.5结果', async status => {
    db.upgradePlan.findFirst.mockResolvedValue({ tasks: [repairTask(), repairTask({ key: 'icbc-foreign-amount-repair-080-v1', status })] });
    expect(await latestStatementRepairResult()).toBeNull();
  });
  it('本轮工行完成聚合金额、恢复、状态保留与原文跳过，旧任务不混入', async () => {
    db.upgradePlan.findFirst.mockResolvedValue({ tasks: [repairTask(), repairTask({ key: 'icbc-foreign-amount-repair-080-v1', toVersion: '0.8.0',
      items: [{ payload: { bankName: '工商银行', billIds: [1], result: { correctedBills: 1, restoredRepayments: 0, uncertainRepayments: 1 } } },
        { payload: { bankName: '工商银行', billIds: [2], incompleteReason: '原文缺失', result: { unavailableMails: 1 } } }] })] });
    expect(await latestStatementRepairResult()).toMatchObject({ kind: 'icbc-foreign', version: '0.8.0', counts: {
      correctedBills: 1, restoredRepayments: 0, uncertainRepayments: 1, unavailableMails: 1, addedTransactions: 0 } });
  });
});
