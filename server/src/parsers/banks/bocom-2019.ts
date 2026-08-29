import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, mailText, parseAmount, parseDate, pick, pickHolder } from '../_util';
import { addDays } from '../../lib/dates';

/**
 * 交通银行信用卡电子账单解析器（2019-2024 旧版模板）
 * 旧邮件特征（pccc@bocomcc.com，与现役同域名）：
 *   标题: 交通银行信用卡电子账单 / 交通银行银联优逸白金卡2022年01月电子账单 /
 *         交通银行白金信用卡2024年01月电子账单
 *   正文与现役差异（现役为"中文 English 值"同行，旧版仅中文标签）：
 *     2019: 交通银行银联优逸白金卡 卡号：\n622656******0988（卡号独立成行）
 *           账单周期：2018/12/11-2019/01/10
 *           到期还款日 ---（溢缴款期还款日留空，按交行规则出账日+25天推算）
 *           本期应还款额 ¥ -3442.90 $---（¥ 为半角 U+00A5，现役为全角 ￥；标签带"额"字）
 *     2022: 交通银行银联优逸白金卡622656******0988（卡名后直接卡号，无"信用卡"前缀词）
 *           账单周期 2021/12/11-2022/01/10 / 最后还款日 2022/02/04（标签为"最后还款日"）
 *           本期应还款 ￥1057.16 $ --- 最低应还款 ￥105.72 $ ---
 *     2024: 交通银行白金信用卡622656******0988 / 账单周期 2023/12/11-2024/01/10
 *           到期还款日 2024-02-04 / 本期应还款 ￥18.80 ＄--- 最低应还款 ￥0.94 ＄---
 *   明细两种行格式（现役为"MM/DD MM/DD 卡尾 摘要 CNY 金额 CNY 金额"单行流）：
 *     2019: "2018/12/15 2018/12/16 摘要... RMB 97.98 RMB 97.98"全日期连续流，
 *           无逐笔卡尾，卡尾在区域头"卡号末四位 0988"
 *     2022/2024: "12/10 12/12 0988 摘要... RMB 0.01 RMB 0.01"短日期 + 卡尾，
 *           金额常被拍平到独立行
 */

/**
 * 旧版明细解析，两区（还款、退货、费用返还 / 消费、取现、其他费用）符号与现役一致：
 * 返还区取负（冲抵）、消费区取正。先试 2019 全日期格式，无命中再试 2022/2024 短日期格式。
 */
function parseBocom2019Transactions(text: string): ParsedTransaction[] {
  const refundStart = text.indexOf('还款、退货');
  const chargeStart = text.indexOf('消费、取现');
  if (refundStart < 0 || chargeStart < 0 || chargeStart < refundStart) return [];
  const sections: Array<[string, 1 | -1]> = [
    [text.slice(refundStart, chargeStart), -1],
    [text.slice(chargeStart), 1],
  ];

  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  // 2019 格式：YYYY/MM/DD 日期对 + 摘要（可跨行）+ RMB 金额对
  const fullRe =
    /(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+([\s\S]{2,120}?)\s+(RMB|CNY|USD)\s+([\d,]+\.\d{2})\s+(RMB|CNY|USD)\s+([\d,]+\.\d{2})/g;
  for (const [seg, sign] of sections) {
    const segTail = seg.match(/卡号末四位\s*(\d{4})/)?.[1];
    for (const m of seg.matchAll(fullRe)) {
      const value = parseAmount(m[7]!);
      if (value == null) continue;
      txns.push({
        date: m[1],
        description: m[3]!.replace(/\s+/g, ' ').trim(),
        amount: sign * value,
        currency: m[6] === 'RMB' ? 'CNY' : m[6],
        originalAmount: parseAmount(m[5]!),
        originalCurrency: m[4] === 'RMB' ? 'CNY' : m[4],
        cardLast4: segTail,
      });
    }
  }
  if (txns.length > 0) return txns;

  // 2022/2024 格式：MM/DD 日期对 + 卡尾 + 摘要（可跨行）+ (RMB|CNY) 金额对
  const shortRe =
    /(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(\d{4})\s+([\s\S]{2,120}?)\s+(RMB|CNY|USD)\s+([\d,]+\.\d{2})\s+(RMB|CNY|USD)\s+([\d,]+\.\d{2})/g;
  for (const [seg, sign] of sections) {
    for (const m of seg.matchAll(shortRe)) {
      const value = parseAmount(m[8]!);
      if (value == null) continue;
      txns.push({
        date: m[1],
        description: m[4]!.replace(/\s+/g, ' ').trim(),
        amount: sign * value,
        currency: m[7] === 'RMB' ? 'CNY' : m[7],
        originalAmount: parseAmount(m[6]!),
        originalCurrency: m[5] === 'RMB' ? 'CNY' : m[5],
        cardLast4: m[3],
      });
    }
  }
  return txns;
}

export const bocom2019Parser: BankParser = {
  id: 'bocom2019',
  bankName: '交通银行',
  priority: 90,
  senderPatterns: ['pccc@bocomcc.com'],
  subjectPatterns: [/交通银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // 卡号：旧模板卡名后直接跟卡号（"银联优逸白金卡622656******0988"），无"信用卡"前缀词
    const cardM = text.match(/(\d{6})\*{4,}(\d{4})/);
    if (!cardM) return [];

    // 账单周期：仅中文标签（现役模板标签后跟 Statement Cycle 英文，不会误中）
    const cycleM = text.match(/账单周期[：:]?\s*\d{4}\/\d{2}\/\d{2}-(\d{4}\/\d{2}\/\d{2})/);
    if (!cycleM) return [];
    const statementDate = parseDate(cycleM[1]!);
    if (!statementDate) return [];

    // 还款日：2022 模板叫"最后还款日"，2019/2024 叫"到期还款日"；
    // 溢缴款期还款日为 "---"（实测 2019-01 样本），按交行规则出账日+25天推算
    //（2022/2024 实测还款日与出账日间隔均为 25 天）
    const dueRaw = pick(text, [/(?:最后还款日|到期还款日)[：:]?\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/]);
    const dueDate = dueRaw ? parseDate(dueRaw) : addDays(statementDate, 25);
    if (!dueDate) return [];

    // 金额：2019 标签带"额"字、半角 ¥（U+00A5）；2022/2024 无"额"、全角 ￥
    const amountRaw = pick(text, [/本期应还款额?\s*[￥¥]\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/最低应?还款额?\s*[￥¥]\s*(-?[\d,]+\.\d{2})/]);
    if (!amountRaw) return [];
    const amount = parseAmount(amountRaw);
    if (amount == null) return [];

    const bill = buildBill({
      bankName: '交通银行',
      cardLast4: cardM[2]!,
      holderName: pickHolder(text),
      amount,
      minAmount: minRaw ? parseAmount(minRaw) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
      cardNoFull: `${cardM[1]!}******${cardM[2]!}`,
    });
    if (!bill) return [];
    const transactions = parseBocom2019Transactions(text);
    bill.transactions = transactions.filter((transaction) => (transaction.currency ?? 'CNY') === 'CNY');
    const bills = [bill];
    const usdAmount = text.match(/本期应还款额?\s*[￥¥]\s*-?[\d,]+\.\d{2}\s*[＄$]\s*(-?[\d,]+\.\d{2})/)?.[1];
    const usdMin = text.match(/最低应?还款额?\s*[￥¥]\s*-?[\d,]+\.\d{2}\s*[＄$]\s*(-?[\d,]+\.\d{2})/)?.[1];
    if (usdAmount != null) {
      const usdBill = buildBill({
        bankName: '交通银行', cardLast4: cardM[2]!, holderName: pickHolder(text),
        amount: parseAmount(usdAmount) ?? 0, minAmount: usdMin == null ? 0 : parseAmount(usdMin),
        currency: 'USD', statementDate, dueDate, cardNoFull: `${cardM[1]}******${cardM[2]}`,
      });
      if (usdBill) {
        usdBill.transactions = transactions.filter((transaction) => transaction.currency === 'USD');
        bills.push(usdBill);
      }
    }
    return bills;
  },
};
