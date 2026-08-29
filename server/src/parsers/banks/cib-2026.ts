import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, cycleEnd, mailText, parseAmount, parseDate, pick, pickHolder } from '../_util';

/**
 * 兴业银行信用卡电子账单解析器
 * 实测邮件特征（creditcard@message.cib.com.cn）：
 *   标题: 兴业银行信用卡2026年07月电子账单
 *   正文: 尊敬的 XX 先生 您好!（卡号末四位 0648）
 *         账单日 Statement Date 2026年07月25日（2026 模板；2021-2025 旧模板为
 *         "账单周期 Statement Cycle 2021/10/26-2021/11/25"，取周期期末为出账日）
 *         到期还款日 Payment Due Date 2026年08月14日
 *         本期应还款总额 New Balance RMB 6,542.97
 *         本期最低还款额 Minimum Payment RMB 327.15
 */
export const cib2026Parser: BankParser = {
  id: 'cib2026',
  bankName: '兴业银行',
  senderPatterns: ['@message.cib.com.cn'],
  subjectPatterns: [/兴业银行.*电子账单/, /兴业.*信用卡.*账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const cardLast4 = pick(text, [/卡号末四位\s*(\d{4})/]);
    // 出账日：2026 模板为"账单日"行；2021-2025 旧模板为"账单周期"行（取期末）
    const stmtRaw = pick(text, [
      /账单日 Statement Date\s*(\d{4}年\d{1,2}月\d{1,2}日)/,
      /账单周期 Statement Cycle\s*(\d{4}\/\d{1,2}\/\d{1,2}-\d{4}\/\d{1,2}\/\d{1,2})/,
    ]);
    const dueRaw = pick(text, [/到期还款日 Payment Due Date\s*(\d{4}年\d{1,2}月\d{1,2}日)/]);
    const amountRaw = pick(text, [/本期应还款总额 New Balance RMB\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/本期最低还款额 Minimum Payment RMB\s*(-?[\d,]+\.\d{2})/]);
    if (!cardLast4 || !stmtRaw || !dueRaw || !amountRaw) return [];

    const statementDate = /-/.test(stmtRaw) ? cycleEnd(stmtRaw) : parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '兴业银行',
      cardLast4,
      holderName: pickHolder(text),
      amount,
      minAmount: minRaw ? parseAmount(minRaw) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];
    // 明细为连续流（拍平后多笔连排，交易日可带时间）：
    // "2026-06-26 2026-06-26 财付通--火山引擎 47.98" / "2026-06-29 23:47 2026-06-30 （特约）美团 276.80"
    const sectionStart = text.indexOf('主卡交易');
    const sectionEnd = text.indexOf('账单说明');
    if (sectionStart >= 0 && sectionEnd > sectionStart) {
      const section = text.slice(sectionStart, sectionEnd);
      const txns: ParsedTransaction[] = [];
      for (const m of section.matchAll(
        /(\d{4}-\d{2}-\d{2})(?:\s+\d{2}:\d{2})?\s+(\d{4}-\d{2}-\d{2})\s+([^\s].{1,80}?)\s+(-?[\d,]+\.\d{2})/g,
      )) {
        const value = parseAmount(m[4]);
        if (value == null) continue;
        txns.push({ date: m[1], description: m[3].trim(), amount: value });
      }
      if (txns.length > 0) bill.transactions = txns;
    }
    return [bill];
  },
};
