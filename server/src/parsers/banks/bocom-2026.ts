import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { attachTransactions, buildBill, cycleEnd, mailText, parseAmount, parseDate, pick, pickHolder } from '../_util';

/**
 * 交通银行信用卡电子账单解析器（一封邮件一张卡，卡号在标题行）
 * 实测邮件特征（pccc@bocomcc.com）：
 *   标题: 交通银行个人信用卡2026年08月电子账单 / 交通银行白金信用卡2026年08月电子账单
 *   正文: 交通银行个人信用卡622253******8679
 *         账单周期 Statement Cycle 2026/07/11-2026/08/10
 *         到期还款日 Payment Due Date 2026-09-04
 *         本期应还款 ￥34.60 ＄--- / 最低应还款 ￥1.73 ＄---
 */
export const bocom2026Parser: BankParser = {
  id: 'bocom2026',
  bankName: '交通银行',
  senderPatterns: ['pccc@bocomcc.com'],
  subjectPatterns: [/交通银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const cardM = text.match(/信用卡(\d{6})\*{4,}(\d{4})/);
    const cycleRaw = pick(text, [/Statement Cycle\s*(\d{4}\/\d{2}\/\d{2}-\d{4}\/\d{2}\/\d{2})/]);
    const dueRaw = pick(text, [/Payment Due Date\s*(\d{4}-\d{2}-\d{2})/]);
    const amountRaw = pick(text, [/本期应还款\s*￥\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/最低应还款\s*￥\s*(-?[\d,]+\.\d{2})/]);
    if (!cardM || !cycleRaw || !dueRaw || !amountRaw) return [];

    const statementDate = cycleEnd(cycleRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '交通银行',
      cardLast4: cardM[2],
      holderName: pickHolder(text),
      amount,
      minAmount: minRaw ? parseAmount(minRaw) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
      cardNoFull: `${cardM[1]}******${cardM[2]}`,
    });
    if (!bill) return [];
    const transactions = parseBocomTransactions(text);
    bill.transactions = transactions.filter((transaction) => transaction.currency === 'CNY');
    const bills = [bill];
    const usdAmount = text.match(/本期应还款\s*￥\s*-?[\d,]+\.\d{2}\s*[＄$]\s*(-?[\d,]+\.\d{2})/)?.[1];
    const usdMin = text.match(/最低应还款\s*￥\s*-?[\d,]+\.\d{2}\s*[＄$]\s*(-?[\d,]+\.\d{2})/)?.[1];
    if (usdAmount != null) {
      const usdBill = buildBill({
        bankName: '交通银行', cardLast4: cardM[2], holderName: pickHolder(text),
        amount: parseAmount(usdAmount) ?? 0, minAmount: usdMin == null ? 0 : parseAmount(usdMin),
        currency: 'USD', statementDate, dueDate, cardNoFull: `${cardM[1]}******${cardM[2]}`,
      });
      if (usdBill) {
        usdBill.transactions = transactions.filter((transaction) => transaction.currency === 'USD');
        bills.push(usdBill);
      }
    }
    return bills;
  },
};

/**
 * 交行明细分两区："还款、退货、费用返还明细"金额取负（冲抵），"消费、取现、其他费用明细"取正。
 * 交易行为连续流："08/03 08/03 8679 摘要 CNY 577.12 CNY 577.12"
 */
function parseBocomTransactions(text: string): ParsedTransaction[] {
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  const lineRe = /(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(\d{4})\s+(.{2,80}?)\s+([A-Z]{3})\s+([\d,]+\.\d{2})\s+([A-Z]{3})\s+([\d,]+\.\d{2})/g;
  const refundStart = text.indexOf('还款、退货、费用返还明细');
  const chargeStart = text.indexOf('消费、取现、其他费用明细');
  if (refundStart < 0 || chargeStart < 0 || chargeStart < refundStart) return txns.map(({ cardLast4: _c, ...r }) => r);
  const scan = (segment: string, sign: 1 | -1) => {
    for (const m of segment.matchAll(lineRe)) {
      const value = parseAmount(m[8]);
      const originalValue = parseAmount(m[6]);
      if (value == null) continue;
      txns.push({ date: m[1], description: m[4].trim(), amount: sign * value, currency: m[7], originalAmount: originalValue, originalCurrency: m[5], cardLast4: m[3] });
    }
  };
  scan(text.slice(refundStart, chargeStart), -1);
  scan(text.slice(chargeStart), 1);
  return txns.map(({ cardLast4: _c, ...r }) => r);
}
