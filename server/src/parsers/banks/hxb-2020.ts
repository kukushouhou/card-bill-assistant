import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { applyTransactionTails, buildBill, fiveLineTransactions, mailText, monthlyRuleDate, parseAmount, parseDate, pick, pickHolder, propagateAccountBillTails, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 华夏银行信用卡电子账单解析器（2020-2022 旧模板）
 * 实测邮件特征（admin@creditcardmail.hxb.com.cn）：
 *   标题: 华夏信用卡-电子账单
 *   正文: 华夏信用卡对账单（2020年12月份）（期次带"年/月份"）
 *         账单日 Statement Date: 每月19日（规则型）
 *         本期到期还款日 Payment Due Date: 2021/01/08
 *         本期应还金额 Amount Payable RMB: 1,072.99 USD: 0.00（币种分行）
 *         最低还款额 Minimum Payment RMB: 107.30 USD: 0.00
 *   明细两种形态：
 *     2020-2021（HTML 拍平 5 行组）：交易日/记账日/摘要/金额/卡号后四位（卡尾在明细最后一列）
 *     2022（纯文本单行流）：2022/01/01 2022/01/01 国网湖南省电力有限公司 10.00 5986
 * 与 2026 版差异：期次/还款日/金额字段名与格式全不同；明细卡尾在金额后（2026 版在金额前）。
 */
export const hxb2020Parser: BankParser = {
  id: 'hxb2020',
  bankName: '华夏银行',
  priority: 90,
  senderPatterns: ['@creditcardmail.hxb.com.cn'],
  subjectPatterns: [/华夏.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const periodM = text.match(/对账单[（(](\d{4})年(\d{1,2})月份[）)]/);
    const dayRaw = pick(text, [/账单日\s*Statement Date:\s*每月(\d{1,2})日/]);
    const dueRaw = pick(text, [/本期到期还款日\s*Payment Due Date:\s*(\d{4}\/\d{2}\/\d{2})/]);
    const amountMatch = text.match(/本期应还金额\s*Amount Payable\s*RMB:\s*(-?[\d,]+\.\d{2})\s*USD:\s*(-?[\d,]+\.\d{2})/);
    const minMatch = text.match(/最低还款额\s*Minimum Payment\s*RMB:\s*(-?[\d,]+\.\d{2})\s*USD:\s*(-?[\d,]+\.\d{2})/);
    if (!periodM || !dayRaw || !dueRaw || !amountMatch) return [];

    const statementDate = monthlyRuleDate(dayRaw, Number(periodM[1]), Number(periodM[2]));
    const dueDate = parseDate(dueRaw);
    if (!statementDate || !dueDate) return [];

    const bills = ['CNY', 'USD'].flatMap((currency, index) => {
      const amount = parseAmount(amountMatch[index + 1]!);
      if (amount == null) return [];
      const bill = buildBill({
        bankName: '华夏银行',
        cardLast4: UNKNOWN_CARD_TAIL,
        holderName: pickHolder(text),
        amount,
        minAmount: minMatch ? parseAmount(minMatch[index + 1]!) : null,
        currency,
        statementDate,
        dueDate,
      });
      return bill ? [bill] : [];
    });

    // 明细仅取人民币区（美元区单列）
    const rmbStart = text.indexOf('人民币交易明细');
    const usdStart = text.indexOf('美元交易明细');
    if (rmbStart < 0) return bills;
    const section = usdStart > rmbStart ? text.slice(rmbStart, usdStart) : text.slice(rmbStart);

    // 形态一：5 行组（HTML 拍平）：交易日/记账日/摘要/金额/卡尾（行末）
    let txns: ParsedTransaction[] = fiveLineTransactions(section, /^(-?[\d,]+\.\d{2})$/);
    // 形态二：单行流（纯文本）：2022/01/01 2022/01/01 摘要 10.00 5986（卡尾在行末）
    if (txns.length === 0) {
      for (const m of section.matchAll(/(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(.{2,60}?)\s+(-?[\d,]+\.\d{2})\s+(\d{4})\b/g)) {
        const value = parseAmount(m[4]);
        if (value == null) continue;
        txns.push({ date: m[1], description: m[3].trim(), amount: value, cardLast4: m[5] === '0000' ? null : m[5] });
      }
    }
    const cnyBill = bills.find((bill) => bill.currency === 'CNY');
    if (cnyBill) {
      for (const transaction of txns) transaction.currency = 'CNY';
      applyTransactionTails(cnyBill, txns);
    }
    if (usdStart >= 0) {
      const usdSection = text.slice(usdStart);
      let usdTransactions: ParsedTransaction[] = fiveLineTransactions(usdSection, /^(-?[\d,]+\.\d{2})$/);
      if (usdTransactions.length === 0) {
        for (const m of usdSection.matchAll(/(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(.{2,60}?)\s+(-?[\d,]+\.\d{2})\s+(\d{4})\b/g)) {
          const value = parseAmount(m[4]);
          if (value == null) continue;
          usdTransactions.push({ date: m[1], description: m[3].trim(), amount: value, cardLast4: m[5] === '0000' ? null : m[5] });
        }
      }
      const usdBill = bills.find((bill) => bill.currency === 'USD');
      if (usdBill) {
        for (const transaction of usdTransactions) transaction.currency = 'USD';
        applyTransactionTails(usdBill, usdTransactions);
      }
    }
    propagateAccountBillTails(bills);
    return bills;
  },
};
