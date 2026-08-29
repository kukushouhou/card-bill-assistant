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
 * 中信银行信用卡电子账单解析器（2020-2023 摘要型旧版模板）
 * 旧邮件特征（citiccard@bill.citiccard.com）：
 *   标题: 中信银行信用卡电子账单
 *   正文: 尊敬的XX先生：2020年02月账单已产生，记录了您2020年01月03日至2020年02月02日
 *         账户变动信息。（周期期末即出账日）
 *         到期还款日：02月21日 / 账单日：02月02日（横幅展示行，无年份）
 *         汇总区: RMB 946.00 / RMB 94.60（应还总额/最低还款）
 *         到期还款日：2020年02月21日（完整日期，取此行）
 *         卡区块: 6226-88**-****-0616 RMB 946.00 RMB 94.60
 *         （卡号 + 应还款金额 + 最低还款额，一封邮件可含多张卡）
 *   卡尾取交易明细「卡号后四位」四位（运通卡抬头印 855，明细列为 8855，不得用抬头）。
 *   与新版差异：无"账单日 XXXX年XX月XX日 Statement Date"行、卡区块为 RMB 双列
 *   （新版为 CNY + 六列数字）。
 */
export const citic2020Parser: BankParser = {
  id: 'citic2020',
  bankName: '中信银行',
  priority: 90,
  senderPatterns: ['@bill.citiccard.com'],
  subjectPatterns: [/中信银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // 出账日：账单周期期末（"记录了您X日至Y日账户变动信息"）
    const stmtRaw = pick(text, [
      /记录了您\d{4}年\d{1,2}月\d{1,2}日至(\d{4}年\d{1,2}月\d{1,2}日)账户变动信息/,
    ]);
    // 完整日期行（横幅"到期还款日：02月21日"无年份，不会命中）
    const dueRaw = pick(text, [/到期还款日[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/]);
    if (!stmtRaw || !dueRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    if (!statementDate || !dueDate) return [];

    const holderName = pickHolder(text);
    const txns = citicTransactions(text);
    const txnTails = txns.map((t) => t.cardLast4);
    const bills: ParsedBill[] = [];
    // 卡区块：卡号 + RMB 应还款金额 + RMB 最低还款额（拍平后标签与金额跨行）
    for (const m of text.matchAll(
      /(?:\d{4})-\d{2}\*{2}-\*{4}-(\d{3,4})\s*RMB\s*(-?[\d,]+\.\d{2})\s*RMB\s*(-?[\d,]+\.\d{2})/g,
    )) {
      const amount = parseAmount(m[2]);
      const minAmount = parseAmount(m[3]);
      if (amount == null || minAmount == null) continue;
      const cardLast4 = resolveCiticCardLast4(m[1]!, txnTails);
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
