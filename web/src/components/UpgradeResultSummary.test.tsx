import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UpgradeResultSummary from './UpgradeResultSummary';
import type { StatementRepairResult } from '../api/types';
const result: StatementRepairResult = { kind: 'icbc-foreign', version: '0.8.0', finishedAt: '2026-10-26', lowerBound: '2026-09-26',
  banks: [{ bankName: '工商银行', billCount: 25, mailCount: 25 }], counts: { correctedBills: 12, addedBills: 0,
    addedTransactions: 0, correctedTransactions: 0, removedTransactions: 0, restoredRepayments: 1,
    fallbackMinimumBills: 0, unavailableMails: 0, uncertainRepayments: 0 }, incomplete: [] };
describe('工行迁移结果', () => {
  it('修正与恢复分别计数，不把候选数量写成错误数', () => {
    render(<UpgradeResultSummary result={result} />);
    expect(screen.getByText('修正账单 12 笔')).toBeTruthy();
    expect(screen.getByText('恢复待还 1 笔')).toBeTruthy();
    expect(screen.getByText('补建账单 0 笔')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('原文缺失说明账单未修正，时序证据不足独立说明金额已修状态未变', () => {
    render(<UpgradeResultSummary result={{ ...result, counts: { ...result.counts, unavailableMails: 2, uncertainRepayments: 3 },
      incomplete: [{ bankName: '工商银行', billCount: 2, reason: '原文缺失' }] }} />);
    expect(screen.getByText('2 封邮件的账单未修正')).toBeTruthy();
    expect(screen.getByText('相关账单保留原状。未修正数量不代表仍有错误账单；原文未列出对应外币应还金额时，也会保留现有记录。')).toBeTruthy();
    expect(screen.getByText('3 笔账单金额已修正，还款状态未变')).toBeTruthy();
    expect(screen.getByText('现有记录不足以确认这些账单是否曾被系统自动标为已还清，因此保留原还款状态，未自动恢复待还。')).toBeTruthy();
  });
  it('0.5 结果继续说明明细未补齐', () => {
    render(<UpgradeResultSummary result={{ ...result, kind: 'statement', version: '0.5.0', counts: { ...result.counts, unavailableMails: 1 }, incomplete: [] }} />);
    expect(screen.getByText('1 封邮件的明细未补齐')).toBeTruthy();
  });
  it('已完成的旧工行结果12封保留项无需改写数据也不再暗示读取失败或证明真实零额', () => {
    render(<UpgradeResultSummary result={{ ...result, counts: { ...result.counts, unavailableMails: 12, skippedBills: 11 },
      incomplete: Array.from({ length: 12 }, () => ({ bankName: '工商银行', billCount: 1, reason: '原文不能唯一对应现有外币账单，保留原状' })) }} />);
    expect(screen.getByText('12 封邮件的账单未修正')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('未修正数量不代表仍有错误账单');
    expect(screen.getByRole('alert').textContent).not.toMatch(/无法完整读取|零余额|确认无欠款/);
  });
});
