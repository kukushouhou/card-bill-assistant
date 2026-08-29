import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, cycleEnd, mailText, parseAmount, parseDate, pick, pickHolder } from '../_util';

/**
 * 邮储银行信用卡电子账单解析器
 * 实测邮件特征（creditcardcenter@cardmail.psbcltd.cn）：
 *   标题: 邮储银行信用卡电子账单
 *   正文: 现呈上您尾号为5888的信用卡电子对账单，账单周期为【2026/06/28-2026/07/27】
 *         （部分邮件作"现呈上尾号5888的..."，缺"为"字）
 *         本期应还款总额 ￥6163.68 / 本期最低还款额 ￥616.37
 *         到期还款日 2026年08月16日
 *   明细: 交易日(YYYYMMDD)/记账日/摘要(可跨行)/￥金额/卡号末四位/国别/境内外标识
 *         金额符号：+ 号表示支出，- 号表示还款；合并账户一封邮件多张卡（主卡尾号在摘要区）
 */

/**
 * 邮储明细解析（HTML 拍平后行序）：
 * 交易日/记账日两行日期 → 摘要一到多行 → ￥金额行 → 4 位卡尾行。
 * 摘要行内的 <br> 会在拍平时产生空行，故按"日期对 + 向后扫描到金额行"的状态机解析。
 */
function parsePsbcTransactions(text: string): Array<ParsedTransaction & { cardLast4?: string }> {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const d1 = lines[i] ?? '';
    if (!/^\d{8}$/.test(d1)) continue;
    const d2 = lines[i + 1] ?? '';
    if (!/^\d{8}$/.test(d2)) continue;
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

export const psbc2026Parser: BankParser = {
  id: 'psbc2026',
  bankName: '邮储银行',
  senderPatterns: ['@cardmail.psbcltd.cn'],
  subjectPatterns: [/邮储银行.*电子账单/, /邮政储蓄.*信用卡.*账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const cardLast4 = pick(text, [/尾号[为]?(\d{4})/]);
    const cycleRaw = pick(text, [/账单周期为【(\d{4}\/\d{2}\/\d{2}-\d{4}\/\d{2}\/\d{2})】/]);
    const dueRaw = pick(text, [/到期还款日\s*(\d{4}年\d{1,2}月\d{1,2}日)/]);
    const amountRaw = pick(text, [/本期应还款总额\s*￥\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/本期最低还款额\s*￥\s*(-?[\d,]+\.\d{2})/]);
    if (!cardLast4 || !cycleRaw || !dueRaw || !amountRaw) return [];

    const statementDate = cycleEnd(cycleRaw);
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

    const txns = parsePsbcTransactions(text);
    if (txns.length > 0) {
      bill.transactions = txns;
      // 合并账户：账单内出现过的全部卡尾（主卡在前）
      const tails = Array.from(new Set(txns.map((t) => t.cardLast4).filter((t): t is string => !!t)));
      if (tails.length > 1) bill.cardLast4s = [cardLast4, ...tails.filter((t) => t !== cardLast4)];
    }
    return [bill];
  },
};
