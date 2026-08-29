import type { BankParser, MailContext, ParsedBill } from '../types';
import {
  attachTransactions,
  buildBill,
  citicTransactions,
  mailText,
  parseAmount,
  parseDate,
  pickHolder,
  resolveCiticCardLast4,
} from '../_util';

/**
 * 中信银行信用卡电子账单解析器（2023 摘要型分行模板）
 * 与 citic2020（单行"卡号 RMB 金额 RMB 金额"）差异：卡表为分行 5 金额组，
 * 账期分隔符为"-"（citic2020 为"至"）。
 * 卡尾取交易明细「卡号后四位」四位（运通卡抬头印 855，明细列为 8855，不得用抬头）。
 * 实测邮件特征（citiccard@bill.citiccard.com）：
 *   正文: 您好！2023年04月账单已产生，记录了您2023年03月03日-2023年04月02日账户变动信息
 *         到期还款日：2023年04月21日（横幅完整日期）
 *   卡表（拍平分行）:
 *     3780-09**-****-855 / RMB / 2,500.82 / 2,500.82 / 4,445.92 / 4,445.92 / 222.30
 *     （卡号 / 币种 / 上期应还 / 上期已还 / 本期新增 / 账户账单金额 / 账户最低还款额，
 *      多卡多组，一封邮件可含 5 张卡）
 */
export const citic2023Parser: BankParser = {
  id: 'citic2023',
  bankName: '中信银行',
  priority: 95,
  senderPatterns: ['@bill.citiccard.com'],
  subjectPatterns: [/中信银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // 账期（期末即出账日），2023 版分隔符为"-"（旧版为"至"），部分月份空格分词（"您 2023年…日 至 …"）
    const stmtRaw = text.match(
      /记录了您\s*\d{4}年\d{1,2}月\d{1,2}日\s*[至\-]\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*账户变动信息/,
    )?.[1];
    const dueRaw = text.match(/到期还款日[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/)?.[1];
    if (!stmtRaw || !dueRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    if (!statementDate || !dueDate) return [];

    const holderName = pickHolder(text);
    const txns = citicTransactions(text);
    const txnTails = txns.map((t) => t.cardLast4);
    const bills: ParsedBill[] = [];
    // 卡表 7 行组（分行）：卡号 / RMB / 上期应还 / 上期已还 / 本期新增 / 账户账单金额 / 最低还款额
    for (const m of text.matchAll(
      /(\d{4})-\d{2}\*{2}-\*{4}-(\d{3,4})\s*\n\s*RMB\s*\n\s*(-?[\d,]+\.\d{2})\s*\n\s*(-?[\d,]+\.\d{2})\s*\n\s*(-?[\d,]+\.\d{2})\s*\n\s*(-?[\d,]+\.\d{2})\s*\n\s*(-?[\d,]+\.\d{2})/g,
    )) {
      const amount = parseAmount(m[6]!);
      const minAmount = parseAmount(m[7]!);
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
