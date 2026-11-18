import type { BankParser, MailContext, ParsedBill } from '../types';
import { abcSummaryAmounts } from '../abc-summary';
import { abcTextTransactions, attachStatementTransactions } from '../statement-rows';
import { buildBill, parseDate, pickHolder } from '../_util';

/** 农行 2026 补寄 PDF：表头集中在前，账户值、两列金额和跨页明细随后输出。 */
export const abcpdf2026Parser: BankParser = {
  id: 'abcpdf2026',
  bankName: '农业银行',
  priority: 110,
  senderPatterns: ['@creditcard.abchina.com.cn'],
  subjectPatterns: [/农业银行.*对账单/, /金穗信用卡.*账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mail.pdfText;
    if (!text || !/本期应还款额[（(]欠款为-[）)]\s*New Balance/.test(text)
      || !/最低还款额[（(]欠款为-[）)]\s*Min\.?\s*Payment/.test(text)) return [];
    const accounts = [...text.matchAll(/(\d{6}\*{6}(\d{4}))\s+(\d{4}\/\d{2}\/\d{2})\s*-\s*(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})/g)];
    if (!accounts.length) throw new Error('农行 PDF 缺少完整的卡号、账单周期或还款日');
    const bills: ParsedBill[] = [];
    for (const [index, account] of accounts.entries()) {
      const section = text.slice(account.index! + account[0].length, accounts[index + 1]?.index);
      const statementDate = parseDate(account[4]!);
      const dueDate = parseDate(account[5]!);
      if (!statementDate || !dueDate) throw new Error('农行 PDF 账单日期无效');
      const summary = section.split(/额度信息|交易明细/)[0]!;
      const amounts = abcSummaryAmounts(summary);
      if (!amounts.length || amounts.length % 2 !== 0) throw new Error('农行 PDF 应还金额或最低还款额不完整');
      const accountBills: ParsedBill[] = [];
      for (let i = 0; i < amounts.length; i += 2) {
        const balance = amounts[i]!;
        const minimum = amounts[i + 1]!;
        if (balance.currency !== minimum.currency || accountBills.some(bill => bill.currency === balance.currency)) {
          throw new Error('农行 PDF 无法确定应还与最低还款额的币种配对');
        }
        const bill = buildBill({ bankName: '农业银行', cardLast4: account[2]!, cardNoFull: account[1],
          holderName: pickHolder(section), amount: balance.amount, minAmount: minimum.amount,
          currency: balance.currency, statementDate, dueDate });
        if (!bill) throw new Error('农行 PDF 还款日早于出账日');
        bill.cycleStartDate = parseDate(account[3]!) ?? undefined;
        accountBills.push(bill);
      }
      const detailStart = section.indexOf('交易明细');
      const transactions = abcTextTransactions(detailStart < 0 ? section : section.slice(detailStart));
      attachStatementTransactions(accountBills, transactions);
      bills.push(...accountBills);
    }
    return bills;
  },
};
