import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { amountLine, applyTransactionTails, buildBill, dateLine, mailText, parseAmount, parseDate, pick, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 湖南银行信用卡电子账单解析器（合并账户账单，卡尾在明细行末）
 * 实测邮件特征（creditcard@hunan-bank.com）：
 *   标题: 湖南银行信用卡2026年08月电子账单
 *   正文: 账单日 ( Statement Date ) 2026-08-08
 *         到期还款日 ( Payment Due Date ) 2026-09-02
 *         本期应还款总额 ( Current Balance ) RMB 779.78
 *         本期最低还款额度 ( Mininum Payment ) RMB 77.98
 * 旧域名华融湘江银行（hrxjbank.com.cn，2023 年更名湖南银行）模板同构，白名单直接兼容。
 */
export const hnb2026Parser: BankParser = {
  id: 'hnb2026',
  bankName: '湖南银行',
  senderPatterns: ['@hunan-bank.com', '@hrxjbank.com.cn'],
  subjectPatterns: [/湖南银行.*电子账单/, /华融湘江银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const stmtRaw = pick(text, [/账单日 \( Statement Date \)\s*(\d{4}-\d{2}-\d{2})/]);
    const dueRaw = pick(text, [/到期还款日 \( Payment Due Date \)\s*(\d{4}-\d{2}-\d{2})/]);
    // 2022 华融湘江版为"本期还款总额"（无"应"），2026 湖南银行版为"本期应还款总额"
    const amountRaw = pick(text, [/本期应?还款总额 \( Current Balance \)\s*RMB\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/本期最低还款额度 \( Mininum Payment \)\s*RMB\s*(-?[\d,]+\.\d{2})/]);
    if (!stmtRaw || !dueRaw || !amountRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '湖南银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount,
      minAmount: minRaw ? parseAmount(minRaw) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];
    // 明细行组（"本期账务明细" 后）：交易日 / 记账日 / 交易类型 / 交易摘要 / 人民币金额 / 卡尾（行末）。
    // 卡尾在明细行末的为合并账户银行：全部卡尾作为批量副卡（主卡取第一个）。
    // 还款行可能无交易摘要（类型后直接金额），此时以交易类型作摘要。
    const sectionStart = text.indexOf('本期账务明细');
    const txns: ParsedTransaction[] = [];
    if (sectionStart >= 0) {
      const lines = text.slice(sectionStart).split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i + 4 < lines.length; i++) {
        const d1 = dateLine(lines[i] ?? '');
        const d2 = d1 ? dateLine(lines[i + 1] ?? '') : null;
        if (!d1 || !d2 || !/^\d{4}-\d{2}-\d{2}$/.test(d1)) continue;
        const type = lines[i + 2] ?? '';
        if (!type) continue;
        const desc = lines[i + 3] ?? '';
        const value6 = amountLine(lines[i + 4] ?? '');
        const tail6 = lines[i + 5] ?? '';
        if (desc && value6 != null && /^\d{4}$/.test(tail6)) {
          txns.push({ date: d1, description: `${type} ${desc}`, amount: value6, cardLast4: tail6 });
          i += 5;
          continue;
        }
        const value5 = amountLine(desc);
        const tail5 = lines[i + 4] ?? '';
        if (value5 != null && /^\d{4}$/.test(tail5)) {
          txns.push({ date: d1, description: type, amount: value5, cardLast4: tail5 });
          i += 4;
        }
      }
    }
    applyTransactionTails(bill, txns);
    return [bill];
  },
};
