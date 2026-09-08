import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { abcTextTransactions, attachStatementTransactions, htmlTransactions } from '../statement-rows';
import { attachTransactions, buildBill, cycleEnd, mailText, parseAmount, parseDate, pick, pickHolder } from '../_util';

/**
 * 农业银行金穗信用卡电子对账单解析器
 * 实测邮件特征（e-statement@creditcard.abchina.com.cn）：
 *   标题: 中国农业银行金穗信用卡电子对账单
 *   正文: 卡号 Card No 625998******9164 账单周期 Statement Cycle 2026/07/20-2026/08/19
 *         到期还款日 Payment Due Date 2026/09/13
 *         本期应还款额(欠款为-) New Balance 人民币(CNY) -1,399.80（银行负数表示欠款）
 */
export const abc2026Parser: BankParser = {
  id: 'abc2026',
  bankName: '农业银行',
  senderPatterns: ['@creditcard.abchina.com.cn'],
  subjectPatterns: [/农业银行.*对账单/, /金穗信用卡.*账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // 实测字段中英文标签间可能隔空格或换行（"到期还款日\nPayment Due Date"），统一用 \s*
    const cardM = text.match(/卡号\s*Card No\s*(\d{6})\*{6}(\d{4})/);
    if (!cardM) return [];

    const cycleRaw = pick(text, [/账单周期\s*Statement Cycle\s*(\d{4}\/\d{2}\/\d{2}-\d{4}\/\d{2}\/\d{2})/]);
    const statementDate = cycleRaw ? cycleEnd(cycleRaw) : null;
    const dueRaw = pick(text, [/到期还款日\s*Payment Due Date\s*(\d{4}\/\d{2}\/\d{2})/]);
    const dueDate = dueRaw ? parseDate(dueRaw) : null;
    if (!statementDate || !dueDate) return [];

    const amountRaw = pick(text, [/本期应还款额\(欠款为-\)\s*New Balance\s*人民币\(CNY\)\s*(-?[\d,]+\.\d{2})/]);
    const amount = amountRaw ? parseAmount(amountRaw) : null;
    if (amount == null) return [];

    const minRaw = pick(text, [/最低还款额\(欠款为-\)\s*Min Payment\s*人民币\(CNY\)\s*(-?[\d,]+\.\d{2})/]);
    const minAmount = minRaw ? parseAmount(minRaw) : null;

    const bill = buildBill({
      bankName: '农业银行',
      cardLast4: cardM[2],
      holderName: pickHolder(text),
      amount: -amount,
      minAmount: minAmount == null ? null : -minAmount,
      currency: 'CNY',
      statementDate,
      dueDate,
      cardNoFull: `${cardM[1]}******${cardM[2]}`,
    });
    if (!bill) return [];
    attachStatementTransactions([bill], htmlTransactions(mail, 'abc') ?? abcTextTransactions(text));
    return [bill];
  },
};
