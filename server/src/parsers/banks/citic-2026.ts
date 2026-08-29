import type { BankParser, MailContext, ParsedBill } from '../types';
import {
  attachTransactions,
  buildBill,
  citicTransactions,
  mailText,
  parseAmount,
  parseDate,
  pick,
  pickHolder,
  resolveCiticCardLast4,
} from '../_util';

/**
 * 中信银行信用卡电子账单解析器（多卡明细表：每行一张卡）
 * 实测邮件特征（citiccard@bill.citiccard.com）：
 *   标题: 中信银行信用卡电子账单
 *   正文: 账单日 2026年08月13日 Statement Date / 到期还款日 2026年09月01日 Payment Due Date
 *         卡行: 6229-19**-****-5983 CNY 2665.50 2665.50 965.00 965.00 48.25
 *         （上期应还 - 上期已还 + 本期新增 = 账户账单金额，最低还款额）
 *   卡尾取交易明细「卡号后四位」四位；抬头已是四位且与明细一致时沿用。
 */
export const citic2026Parser: BankParser = {
  id: 'citic2026',
  bankName: '中信银行',
  senderPatterns: ['@bill.citiccard.com'],
  subjectPatterns: [/中信银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const stmtRaw = pick(text, [/账单日\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*Statement Date/]);
    const dueRaw = pick(text, [/到期还款日\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*Payment Due Date/]);
    if (!stmtRaw || !dueRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    if (!statementDate || !dueDate) return [];

    const holderName = pickHolder(text);
    const txns = citicTransactions(text);
    const txnTails = txns.map((t) => t.cardLast4);
    const bills: ParsedBill[] = [];
    // 卡行：卡号 CNY 上期应还 上期已还 本期新增 账户账单金额 最低还款额
    for (const m of text.matchAll(
      /(\d{4})-\d{2}\*{2}-\*{4}-(\d{3,4})\s*CNY\s*(-?[\d,]+\.\d{2})\s*(-?[\d,]+\.\d{2})\s*(-?[\d,]+\.\d{2})\s*(-?[\d,]+\.\d{2})\s*(-?[\d,]+\.\d{2})/g,
    )) {
      const amount = parseAmount(m[5]);
      const minAmount = parseAmount(m[6]);
      if (amount == null || minAmount == null) continue;
      const cardLast4 = resolveCiticCardLast4(m[2]!, txnTails);
      if (!cardLast4) continue;
      const bill = buildBill({
        bankName: '中信银行',
        cardLast4,
        holderName,
        amount,
        minAmount,
        currency: 'CNY',
        statementDate,
        dueDate,
      });
      if (bill) bills.push(bill);
    }
    attachTransactions(bills, txns);
    return bills;
  },
};
