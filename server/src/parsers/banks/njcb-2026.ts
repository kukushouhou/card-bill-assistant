import type { BankParser, MailContext, ParsedBill } from '../types';
import { applyTransactionTails, buildBill, fiveLineTransactions, mailText, parseAmount, parseDate, pick, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 南京银行 N CARD 账户电子账单解析器（合并账户账单，卡尾在明细行末）
 * 实测邮件特征（cc@message.njcb.com.cn）：
 *   标题: 南京银行N CARD账户电子账单
 *   正文（字段名带空格）: 账 单 日 2026-08-12 / 到 期 还 款 日 2026-09-06
 *         本 期 应 还 总 额 5.00 人民币 / 本 期 最 低 还 款 额 5.00 人民币
 */
export const njcb2026Parser: BankParser = {
  id: 'njcb2026',
  bankName: '南京银行',
  senderPatterns: ['@message.njcb.com.cn'],
  subjectPatterns: [/南京银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const stmtRaw = pick(text, [/账\s*单\s*日\s*(\d{4}-\d{2}-\d{2})/]);
    const dueRaw = pick(text, [/到\s*期\s*还\s*款\s*日\s*(\d{4}-\d{2}-\d{2})/]);
    const amountRaw = pick(text, [/本\s*期\s*应\s*还\s*总\s*额\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/本\s*期\s*最\s*低\s*还\s*款\s*额\s*(-?[\d,]+\.\d{2})/]);
    if (!stmtRaw || !dueRaw || !amountRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '南京银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount,
      minAmount: minRaw ? parseAmount(minRaw) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];
    // 明细为 5 行组：交易日/记账日/摘要/金额/卡尾号（行末）；金额负数=还款（贷记），正数=入账
    // 卡尾在明细行末的为合并账户银行：全部卡尾作为批量副卡（主卡取第一个）。
    const txns = fiveLineTransactions(text, /^(-?[\d,]+\.\d{2})$/);
    applyTransactionTails(bill, txns);
    return [bill];
  },
};
