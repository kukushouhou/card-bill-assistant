import type { BankParser, MailContext, ParsedBill } from '../types';
import { abcTextTransactions, attachStatementTransactions, htmlTransactions } from '../statement-rows';
import { buildBill, cycleEnd, mailText, parseDate, pick, pickHolder } from '../_util';
import { abcSummaryAmounts } from '../abc-summary';

/**
 * 农业银行金穗信用卡电子对账单解析器
 * 实测邮件特征（e-statement@creditcard.abchina.com.cn）：
 *   标题: 中国农业银行金穗信用卡电子对账单
 *   正文: 卡号 Card No 625998******9164 账单周期 Statement Cycle 2026/07/20-2026/08/19
 *         到期还款日 Payment Due Date 2026/09/13
 *         本期应还款额(欠款为-) New Balance 人民币(CNY) -1,399.80（银行负数表示欠款）
 *   「欠款为-」栏偶见正数或 0.00 印法（小额账单最低还款额为 0.00），
 *   金额按欠款额语义取绝对值，避免产生负的应还/最低额。
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

    const fields = [...text.matchAll(/(本期应还款额|最低还款额)[（(]欠款为-[）)]\s*(?:New\s+Balance|Min\.?\s*Payment)\s*/gi)];
    const balances = new Map<string, number>();
    const minimums = new Map<string, number>();
    for (const [index, field] of fields.entries()) {
      // 额度和账务汇总表也印有币种，必须限定在应还/最低额字段内。
      const section = text.slice(field.index! + field[0].length, fields[index + 1]?.index)
        .split(/信用额度|额度信息|交易明细|交易日期|账务明细|币种\s*Curr/)[0]!;
      const target = field[1] === '本期应还款额' ? balances : minimums;
      for (const { currency, amount } of abcSummaryAmounts(section)) {
        if (target.has(currency) && target.get(currency) !== amount) throw new Error('农行同币种账单摘要金额冲突');
        target.set(currency, amount);
      }
    }
    if (!balances.size) return [];
    if ([...minimums.keys()].some(currency => !balances.has(currency))) throw new Error('农行账单缺少对应币种的应还金额');
    const bills: ParsedBill[] = [];
    for (const [currency, amount] of balances) {
      const bill = buildBill({
        bankName: '农业银行', cardLast4: cardM[2], holderName: pickHolder(text),
        amount, minAmount: minimums.get(currency), currency, statementDate, dueDate,
        cardNoFull: `${cardM[1]}******${cardM[2]}`,
      });
      if (!bill) return [];
      bills.push(bill);
    }
    attachStatementTransactions(bills, htmlTransactions(mail, 'abc') ?? abcTextTransactions(text));
    return bills;
  },
};
