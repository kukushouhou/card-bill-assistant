import type { BankParser, MailContext, ParsedBill } from '../types';
import { applyTransactionTails, buildBill, fiveLineTransactions, mailText, parseAmount, parseDate, pick, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 北京银行信用卡电子账单解析器（合并账户账单，卡尾在明细行末）
 * 实测邮件特征（service@ebill.bankofbeijing.com.cn）：
 *   标题: 北京银行-信用卡2026年08月电子账单
 *   正文: 本期账单日:2026年08月20日 / 本期到期还款日:2026年09月09日
 *         人民币账户 本期应还款金额： 1,505.50 元 / 最低还款金额： 75.28 元
 */
export const bob2026Parser: BankParser = {
  id: 'bob2026',
  bankName: '北京银行',
  senderPatterns: ['service@ebill.bankofbeijing.com.cn'],
  subjectPatterns: [/北京银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const stmtRaw = pick(text, [/本期账单日:\s*(\d{4}年\d{1,2}月\d{1,2}日)/]);
    const dueRaw = pick(text, [/本期到期还款日:\s*(\d{4}年\d{1,2}月\d{1,2}日)/]);
    const amountRaw = pick(text, [/本期应还款金额：\s*(-?[\d,]+\.\d{2})\s*元/]);
    const minRaw = pick(text, [/最低还款金额：\s*(-?[\d,]+\.\d{2})\s*元/]);
    if (!stmtRaw || !dueRaw || !amountRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '北京银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount,
      minAmount: minRaw ? parseAmount(minRaw) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];
    // 明细为 5 行组：交易日/记账日/摘要/RMB:金额/卡尾号（行末）；金额 +号=支出、-号=还款。
    // 卡尾在明细行末的为合并账户银行：全部卡尾作为批量副卡（主卡取第一个）。
    const txns = fiveLineTransactions(text, /^RMB:(-?[\d,]+\.\d{2})$/);
    applyTransactionTails(bill, txns);
    return [bill];
  },
};
