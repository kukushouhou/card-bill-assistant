import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { applyTransactionTails, buildBill, cycleEnd, mailText, parseAmount, parseDate, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 招商银行信用卡账单解析器（账户级合并账单，卡尾从明细行提取）
 * 实测邮件特征（ccsvc@message.cmbchina.com）：
 *   标题: 招商银行信用卡电子账单（同发件人还会发"每日信用管家"，靠标题白名单区分）
 *   正文摘要行: 2026/07/09-2026/08/08 ￥ 35,000.00 ￥ 1,927.79 ￥ 96.39 2026/08/26
 *               （账单周期 额度 应还总额 最低还款 到期还款日）
 * 明细行组：日期(MMDD 1-2个) 描述 ￥金额 卡尾(4位) [积分/金额]——卡尾紧跟金额行，
 * 多卡尾作为批量副卡（主卡取第一个）。
 */
export const cmb2026Parser: BankParser = {
  id: 'cmb2026',
  bankName: '招商银行',
  senderPatterns: ['@message.cmbchina.com', '@ccb.cmbchina.com'],
  subjectPatterns: [/招商银行.*电子账单/, /电子账单.*招商银行/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // 摘要行：周期 额度 应还 最低 到期还款日（应还/最低可为负数=溢缴款，2024 实测）
    const m = text.match(
      /(\d{4}\/\d{2}\/\d{2})-(\d{4}\/\d{2}\/\d{2})\s*￥\s*[\d,]+\.\d{2}\s*￥\s*(-?[\d,]+\.\d{2})\s*￥\s*(-?[\d,]+\.\d{2})\s*(\d{4}\/\d{2}\/\d{2})/,
    );
    if (!m) return [];

    const statementDate = cycleEnd(m[2]);
    const dueDate = parseDate(m[5]);
    const amount = parseAmount(m[3]);
    const minAmount = parseAmount(m[4]);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '招商银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount,
      minAmount,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];
    bill.cycleStartDate = parseDate(m[1]) ?? undefined;
    applyTransactionTails(bill, parseCmbTransactions(text));
    return [bill];
  },
};

/**
 * 招行明细（分行单元格，账户级）：[类型] 日期(MMDD 1-2个) 描述... ￥金额 卡尾 [CN] [金额]。
 * 以 ￥金额 行为锚点回溯取日期与描述、前向紧邻行取卡尾（4 位数字）；
 * 金额符号直接使用（负=还款冲抵）。
 */
function parseCmbTransactions(text: string): ParsedTransaction[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const isDate = (l: string) => /^\d{4}$/.test(l);
  const txns: ParsedTransaction[] = [];
  for (let k = 0; k < lines.length; k++) {
    const amountM = (lines[k] ?? '').match(/^￥\s*(-?[\d,]+\.\d{2})$/);
    if (!amountM) continue;
    const value = parseAmount(amountM[1]);
    if (value == null) continue;
    // 回溯：描述（非日期非类型标记，至多3行）+ 日期行（1-2个）
    const desc: string[] = [];
    let j = k - 1;
    while (j >= 0 && !isDate(lines[j] ?? '') && !/^(还款|费用|消费|利息|其他)$/.test(lines[j] ?? '') && desc.length < 3) {
      desc.unshift(lines[j] ?? '');
      j--;
    }
    let date: string | null = null;
    if (j >= 0 && isDate(lines[j] ?? '')) {
      date = lines[j] ?? null;
      if (j - 1 >= 0 && isDate(lines[j - 1] ?? '')) date = lines[j - 1] ?? null;
    }
    if (desc.length === 0 || !date) continue;
    // 前向：金额行紧邻的下一行为卡尾（与下一笔交易的日期行同为 4 位数字，
    // 但日期行前必有描述行隔开，紧跟金额行的 4 位数字必为卡尾）
    // 招行特例：末四位四个零且交易地为空（0000 后无 CN）才视为没卡号
    const tailLine = lines[k + 1] ?? '';
    const locLine = lines[k + 2] ?? '';
    let cardLast4: string | null = null;
    if (/^\d{4}$/.test(tailLine)) {
      cardLast4 = tailLine === '0000' && locLine !== 'CN' ? null : tailLine;
    }
    txns.push({ date, description: desc.join(' '), amount: value, cardLast4 });
  }
  return txns;
}
