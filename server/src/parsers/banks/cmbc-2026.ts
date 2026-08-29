import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { amountLine, applyTransactionTails, buildBill, dateLine, mailText, parseAmount, parseDate, pick, pickHolder, propagateAccountBillTails, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 民生银行信用卡电子对账单解析器（合并账户账单，卡尾在明细行末）
 * 实测邮件特征（master@creditcard.cmbc.com.cn）：
 *   标题: 民生信用卡2026年08月电子对账单
 *   正文: 本期账单日 Statement Date 2026/08/05
 *         本期最后还款日 Payment Due Date 2026/08/25
 *         人民币/美元账户 RMB/USD Account RMB 528.96 USD 0.00 RMB 100.00 USD 0.00
 *         （2020-2021 旧版无 USD 段：RMB/USD Account RMB 14,363.70 RMB 1,436.37）
 */
export const cmbc2026Parser: BankParser = {
  id: 'cmbc2026',
  bankName: '民生银行',
  senderPatterns: ['@creditcard.cmbc.com.cn'],
  subjectPatterns: [/民生.*对账单/, /民生信用卡.*账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const stmtRaw = pick(text, [/本期账单日\s*Statement Date\s*(\d{4}\/\d{2}\/\d{2})/]);
    const dueRaw = pick(text, [/本期最后还款日\s*Payment Due Date\s*(\d{4}\/\d{2}\/\d{2})/]);
    // 汇总区金额：新版 RMB x USD x RMB y；2020-2021 旧版无 USD 段（RMB x RMB y）
    const modernAmounts = text.match(/RMB\/USD Account\s*RMB\s*(-?[\d,]+\.\d{2})\s*USD\s*(-?[\d,]+\.\d{2})\s*RMB\s*(-?[\d,]+\.\d{2})\s*USD\s*(-?[\d,]+\.\d{2})/);
    const legacyAmounts = text.match(/RMB\/USD Account\s*RMB\s*(-?[\d,]+\.\d{2})\s+RMB\s*(-?[\d,]+\.\d{2})/);
    if (!stmtRaw || !dueRaw || (!modernAmounts && !legacyAmounts)) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    if (!statementDate || !dueDate) return [];
    const balanceRows = modernAmounts
      ? [
          { currency: 'CNY', amount: modernAmounts[1], minAmount: modernAmounts[3] },
          { currency: 'USD', amount: modernAmounts[2], minAmount: modernAmounts[4] },
        ]
      : [{ currency: 'CNY', amount: legacyAmounts![1], minAmount: legacyAmounts![2] }];
    const bills = balanceRows.flatMap((row) => {
      const amount = parseAmount(row.amount!);
      if (amount == null) return [];
      const bill = buildBill({
        bankName: '民生银行',
        cardLast4: UNKNOWN_CARD_TAIL,
        holderName: pickHolder(text),
        amount,
        minAmount: parseAmount(row.minAmount!),
        currency: row.currency,
        statementDate,
        dueDate,
      });
      return bill ? [bill] : [];
    });
    // 明细行组（分组标记 消 费/分 期/还 款 后）：MM/DD / MM/DD / 摘要 / 金额 / 卡尾（行末）。
    // 卡尾在明细行末的为合并账户银行：全部卡尾作为批量副卡（主卡取第一个），
    // 交易归属各卡，金额符号直接使用（负=还款冲抵）。
    const txns: ParsedTransaction[] = [];
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let currentCurrency = 'CNY';
    for (let i = 0; i + 4 < lines.length; i++) {
      const currencyLine = lines[i]?.match(/New Balance\s+(RMB|USD)/i);
      if (currencyLine) {
        currentCurrency = currencyLine[1]!.toUpperCase() === 'RMB' ? 'CNY' : 'USD';
        continue;
      }
      const d1 = dateLine(lines[i] ?? '');
      const d2 = d1 ? dateLine(lines[i + 1] ?? '') : null;
      if (!d1 || !d2 || !/^\d{2}\/\d{2}$/.test(d1)) continue;
      const desc = lines[i + 2] ?? '';
      const value = amountLine(lines[i + 3] ?? '');
      const tail = lines[i + 4] ?? '';
      if (!desc || value == null || !/^\d{4}$/.test(tail)) continue;
      txns.push({ date: d1, description: desc, amount: value, currency: currentCurrency, cardLast4: tail });
      i += 4;
    }
    for (const bill of bills) {
      applyTransactionTails(bill, txns.filter((transaction) => transaction.currency === bill.currency));
    }
    propagateAccountBillTails(bills);
    return bills;
  },
};
