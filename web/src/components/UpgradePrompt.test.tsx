import { describe, expect, it } from 'vitest';
import { bankText, upgradePromptText } from './UpgradePrompt';

describe('历史账单更新提示', () => {
  it('按银行数量生成自然的合并名称', () => {
    expect(bankText(['工商银行'])).toBe('工商银行');
    expect(bankText(['工商银行', '平安银行'])).toBe('工商银行和平安银行');
    expect(bankText(['工商银行', '平安银行', '广发银行']))
      .toBe('工商银行、平安银行和广发银行');
  });

  it('正文使用明确主语并只说明更新价值', () => {
    expect(upgradePromptText(['工商银行', '平安银行', '广发银行'])).toBe(
      '系统检测到你已有工商银行、平安银行和广发银行的历史账单。本次更新可以更准确地识别这些账单中的主卡、副卡、附属卡和手机信用卡，减少重复账单和还款提醒。你是否要现在更新这些历史账单？',
    );
  });
});
