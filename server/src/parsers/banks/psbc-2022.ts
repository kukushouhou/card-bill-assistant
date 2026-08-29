import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, mailText, monthlyRuleDate, parseAmount, parseDate, pick, pickHolder } from '../_util';

/**
 * 邮储银行信用卡电子账单解析器（2022-2024 旧版模板）
 * 旧邮件特征（creditcardcenter@cardmail.psbc.com，注意与现役 psbcltd.cn 域名不同）：
 *   标题: 邮储银行信用卡电子账单
 *   正文: 中国邮政储蓄银行信用卡对账单 (2022年02月)
 *         尊敬的张三 先生：您好!...现呈上您尾号为5888的信用卡电子对账单。
 *         账单日 27 / 本期应还款总额 ￥628.45 / 本期最低还款额 ￥62.85
 *         到期还款日 2022年03月19日
 *   与新版差异：无"账单周期为【...】"行，出账日由对账单月份标题 "(YYYY年MM月)"
 *   加"账单日 27"组合得出（如 2022年02月 + 27 日 → 2022-02-27）
 *   明细: 交易日/记账日两行日期（YYYY/MM/DD 斜杠格式，新版为 YYYYMMDD）
 *         → 摘要 → ￥金额行 → 卡尾行（2024 起金额后另有国别/境内外标识行）
 */

/**
 * 旧版明细解析：与现役同构的状态机，仅日期格式为 YYYY/MM/DD。
 */
function parsePsbc2022Transactions(text: string): Array<ParsedTransaction & { cardLast4?: string }> {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const d1 = lines[i] ?? '';
    if (!/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(d1)) continue;
    const d2 = lines[i + 1] ?? '';
    if (!/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(d2)) continue;
    let j = i + 2;
    const desc: string[] = [];
    let amount: number | null = null;
    while (j < lines.length && j <= i + 8) {
      const l = lines[j] ?? '';
      const am = l.match(/^￥\s*(-?[\d,]+\.\d{2})$/);
      if (am) {
        amount = parseAmount(am[1]);
        break;
      }
      desc.push(l);
      j++;
    }
    if (amount == null || desc.length === 0) continue;
    const tailLine = lines[j + 1] ?? '';
    txns.push({
      date: d1,
      description: desc.join(''),
      amount,
      cardLast4: /^\d{4}$/.test(tailLine) ? tailLine : undefined,
    });
    i = j;
  }
  return txns;
}

export const psbc2022Parser: BankParser = {
  id: 'psbc2022',
  bankName: '邮储银行',
  priority: 90,
  senderPatterns: ['@cardmail.psbc.com', '@cardmail.psbcltd.cn'],
  subjectPatterns: [/邮储银行.*电子账单/, /邮政储蓄.*信用卡.*账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const cardLast4 = pick(text, [/尾号[为]?(\d{4})/]);
    // 出账日：对账单月份标题 + 账单日（"账单日 \n 27"）
    const cycleMonth = text.match(/\((\d{4})年(\d{1,2})月\)/);
    const stmtDay = pick(text, [/账单日\s*(\d{1,2})/]);
    const dueRaw = pick(text, [/到期还款日\s*(\d{4}年\d{1,2}月\d{1,2}日)/]);
    const amountRaw = pick(text, [/本期应还款总额\s*￥\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/本期最低还款额\s*￥\s*(-?[\d,]+\.\d{2})/]);
    if (!cardLast4 || !cycleMonth || !stmtDay || !dueRaw || !amountRaw) return [];

    const statementDate = monthlyRuleDate(stmtDay, Number(cycleMonth[1]), Number(cycleMonth[2]));
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '邮储银行',
      cardLast4,
      holderName: pickHolder(text),
      amount,
      minAmount: minRaw ? parseAmount(minRaw) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];

    const txns = parsePsbc2022Transactions(text);
    if (txns.length > 0) {
      bill.transactions = txns;
      // 合并账户：账单内出现过的全部卡尾（主卡在前）
      const tails = Array.from(new Set(txns.map((t) => t.cardLast4).filter((t): t is string => !!t)));
      if (tails.length > 1) bill.cardLast4s = [cardLast4, ...tails.filter((t) => t !== cardLast4)];
    }
    return [bill];
  },
};
