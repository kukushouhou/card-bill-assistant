import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { attachTransactions, buildBill, cardTailLine, dateLine, mailText, parseAmount, parseDate, pick, pickHolder } from '../_util';

/**
 * 建设银行信用卡电子账单解析器（多卡应还款明细：每行一张卡）
 * 实测邮件特征（service@vip.ccb.com）：
 *   标题: 中国建设银行信用卡电子账单
 *   正文: 本期账单日 Statement Date 2026-08-14
 *         本期到期还款日 Payment Due Date 2026/09/03
 *         卡行（应还款明细）: 62270816****9490 人民币(CNY) 857.90 200.00
 */
export const ccb2026Parser: BankParser = {
  id: 'ccb2026',
  bankName: '建设银行',
  senderPatterns: ['service@vip.ccb.com'],
  subjectPatterns: [/建设银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const stmtRaw = pick(text, [/本期账单日\s*Statement Date\s*(\d{4}-\d{2}-\d{2})/]);
    const dueRaw = pick(text, [/本期到期还款日\s*Payment Due Date\s*(\d{4}\/\d{2}\/\d{2})/]);
    if (!stmtRaw || !dueRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    if (!statementDate || !dueDate) return [];

    const holderName = pickHolder(text);
    const bills: ParsedBill[] = [];
    // 应还款明细卡行：卡号 人民币(CNY) 应还款额/溢缴款 最低还款额
    for (const m of text.matchAll(/(\d{8})\*{4}(\d{4})\s*[^\n(]{1,12}\(([A-Z]{3})\)\s*(-?[\d,]+\.\d{2})\s*(-?[\d,]+\.\d{2})/g)) {
      const amount = parseAmount(m[4]);
      const minAmount = parseAmount(m[5]);
      if (amount == null || minAmount == null) continue;
      const bill = buildBill({
        bankName: '建设银行',
        cardLast4: m[2],
        holderName,
        amount,
        minAmount,
        currency: m[3],
        statementDate,
        dueDate,
        cardNoFull: `${m[1]}****${m[2]}`,
      });
      if (bill) bills.push(bill);
    }
    attachCcbTransactions(text, bills);
    return bills;
  },
};

/**
 * 建行明细行组（分行单元格）：交易日 / 记账日 / 卡尾 / 描述 / CNY / 交易金额 / CNY / 结算金额。
 * 取结算金额（最后一列），符号直接使用（负=还款/冲抵）。
 */
function attachCcbTransactions(text: string, bills: ParsedBill[]): void {
  if (bills.length === 0) return;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  for (let i = 0; i + 7 < lines.length; i++) {
    const d1 = dateLine(lines[i] ?? '');
    const d2 = d1 ? dateLine(lines[i + 1] ?? '') : null;
    const tail = d2 ? cardTailLine(lines[i + 2] ?? '') : null;
    if (!d1 || !d2 || !tail) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d1)) continue;
    // 描述行若干，后跟原交易币种/金额与入账币种/金额
    let j = i + 3;
    const desc: string[] = [];
    while (j < lines.length && !/^[A-Z]{3}$/.test(lines[j] ?? '')) {
      desc.push(lines[j] ?? '');
      j++;
      if (desc.length > 3) break;
    }
    if (j + 4 >= lines.length || !/^[A-Z]{3}$/.test(lines[j] ?? '') || !/^[A-Z]{3}$/.test(lines[j + 2] ?? '')) continue;
    const originalValue = parseAmount(lines[j + 1] ?? '');
    const value = parseAmount(lines[j + 3] ?? '');
    if (value == null || desc.length === 0) continue;
    txns.push({
      date: d1,
      description: desc.join(' '),
      amount: value,
      currency: lines[j + 2],
      originalAmount: originalValue,
      originalCurrency: lines[j],
      cardLast4: tail,
    });
    i = j + 3;
  }
  for (const bill of bills) {
    attachTransactions([bill], txns.filter((transaction) => transaction.currency === bill.currency));
  }
}
