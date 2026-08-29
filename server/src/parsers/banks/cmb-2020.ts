import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { applyTransactionTails, buildBill, cycleEnd, mailText, parseAmount, parseDate, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 招商银行信用卡电子账单解析器（2020-2021 分行摘要模板）
 * 与现役 cmb2026 差异：摘要各值分行输出（2026 版为单行连排），
 * 补发账单周期带"(补)"后缀且摘要无额度值，账单年月不出现在标题。
 * 实测邮件特征（ccsvc@message.cmbchina.com，标题"招商银行信用卡电子账单"）：
 *   正文摘要（拍平分行）:
 *     尊敬的 张三 先生，您好！以下是您的招商银行信用卡06月账单
 *     2021/05/09-2021/06/08（周期，补发为 2020/04/09-2020/05/08(补)）
 *     ￥35,000（额度，补发版无此行）
 *     ￥11,529.02（应还） ￥1,824.99（最低） 2021/06/26（到期还款日）
 *   明细行组（分行）：MMDD / 描述 / ￥[- ]金额 / 卡尾（4位）[/ CN] [/ 原始金额]
 *     多卡尾作为批量副卡（主卡取第一个）。
 */
export const cmb2020Parser: BankParser = {
  id: 'cmb2020',
  bankName: '招商银行',
  priority: 95,
  senderPatterns: ['@message.cmbchina.com', '@ccb.cmbchina.com'],
  subjectPatterns: [/招商银行.*电子账单/, /电子账单.*招商银行/],

  parse(mail: MailContext): ParsedBill[] {
    // 同发件人还有"每日信用管家"等推送，仅处理账单类标题
    if (!/电子账单/.test(mail.subject)) return [];
    const text = mailText(mail);
    if (!text) return [];

    // 摘要（分行）：周期[(补)] [￥额度(无小数)] ￥应还 ￥最低 还款日
    const m = text.match(
      /(\d{4}\/\d{2}\/\d{2})-(\d{4}\/\d{2}\/\d{2})(?:[（(]补[）)])?\s+(?:￥\s*[\d,]+\s+)?￥\s*(-?[\d,]+\.\d{2})\s+￥\s*(-?[\d,]+\.\d{2})\s+(\d{4}\/\d{2}\/\d{2})/,
    );
    if (!m) return [];

    const statementDate = cycleEnd(m[2]!);
    const dueDate = parseDate(m[5]);
    const amount = parseAmount(m[3]!);
    const minAmount = parseAmount(m[4]!);
    if (!statementDate || !dueDate || amount == null || minAmount == null) return [];

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
    applyTransactionTails(bill, parseCmb2020Transactions(text));
    return [bill];
  },
};

/**
 * 招行 2020-2021 明细（分行单元格，账户级）：MMDD / 描述 / ￥[- ]金额 / 卡尾（4位）[/ CN] [/ 原始金额]。
 * 以金额行为锚点回溯取日期与描述、前向紧邻行取卡尾；金额符号取￥后的独立负号（如"￥- 2,923.46"）。
 */
function parseCmb2020Transactions(text: string): ParsedTransaction[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const isDate = (l: string) => /^\d{4}$/.test(l);
  const txns: ParsedTransaction[] = [];
  for (let k = 0; k < lines.length; k++) {
    const amountM = (lines[k] ?? '').match(/^￥\s*(-?)\s*(-?[\d,]+\.\d{2})$/);
    if (!amountM) continue;
    const value = parseAmount(amountM[2]);
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
    // 前向：金额行紧邻的下一行为卡尾（紧跟金额行的 4 位数字必为卡尾）
    // 招行特例：末四位四个零且交易地为空（0000 后无 CN）才视为没卡号
    const tailLine = lines[k + 1] ?? '';
    const locLine = lines[k + 2] ?? '';
    let cardLast4: string | null = null;
    if (/^\d{4}$/.test(tailLine)) {
      cardLast4 = tailLine === '0000' && locLine !== 'CN' ? null : tailLine;
    }
    const negative = amountM[1] === '-' || amountM[2]!.startsWith('-');
    txns.push({ date, description: desc.join(' '), amount: negative ? -value : value, cardLast4 });
  }
  return txns;
}
