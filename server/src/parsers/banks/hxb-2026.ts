import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { applyTransactionTails, buildBill, mailText, monthlyRuleDate, parseAmount, parseDate, pick, pickHolder, propagateAccountBillTails, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 华夏银行信用卡电子账单解析器（账户级账单：汇总区无卡号）
 * 实测邮件特征（admin@creditcardmail.hxb.com.cn）：
 *   标题: 华夏信用卡-电子账单2026年08月
 *   正文: 华夏信用卡对账单(2026/08)（账单月份）
 *         本期应还款 ＄0.00 ￥10,070.71（美元在前人民币在后）
 *         最低应还款 ＄0.00 ￥503.54
 *         账单日 每月19日（规则型，实际出账日按账单月份取 19 号）
 *         最后还款日 2026/09/08
 *         交易行: 08/03 08/03 财付通i车位 5616 ￥8.00（卡尾号在金额前）
 * 汇总金额为账户级（一封邮件可含多张卡交易，无法按卡拆分），固定 '----' 账户标识
 */
export const hxb2026Parser: BankParser = {
  id: 'hxb2026',
  bankName: '华夏银行',
  senderPatterns: ['@creditcardmail.hxb.com.cn'],
  subjectPatterns: [/华夏.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const periodM = text.match(/对账单\((\d{4})\/(\d{2})\)/);
    const dayRaw = pick(text, [/账单日\s*每月(\d{1,2})日/]);
    const dueRaw = pick(text, [/最后还款日\s*(\d{4}\/\d{2}\/\d{2})/]);
    // 2026 版"＄0.00 ￥10,070.71"（美元在前）；2022 版"￥78.00 Amount Payable $0.00"（人民币在前）
    const usdFirstAmount = text.match(/本期应还款\s*＄\s*(-?[\d,]+\.\d{2})\s*￥\s*(-?[\d,]+\.\d{2})/);
    const cnyFirstAmount = text.match(/本期应还款\s*￥\s*(-?[\d,]+\.\d{2})\s*Amount Payable\s*\$\s*(-?[\d,]+\.\d{2})/);
    const usdFirstMin = text.match(/最低应还款\s*＄\s*(-?[\d,]+\.\d{2})\s*￥\s*(-?[\d,]+\.\d{2})/);
    const cnyFirstMin = text.match(/最低应还款\s*￥\s*(-?[\d,]+\.\d{2})\s*Amount Payable\s*\$\s*(-?[\d,]+\.\d{2})/);
    if (!periodM || !dayRaw || !dueRaw || (!usdFirstAmount && !cnyFirstAmount)) return [];

    const statementDate = monthlyRuleDate(dayRaw, Number(periodM[1]), Number(periodM[2]));
    const dueDate = parseDate(dueRaw);
    if (!statementDate || !dueDate) return [];

    const balances = usdFirstAmount
      ? [
          { currency: 'CNY', amount: usdFirstAmount[2], minAmount: usdFirstMin?.[2] },
          { currency: 'USD', amount: usdFirstAmount[1], minAmount: usdFirstMin?.[1] },
        ]
      : [
          { currency: 'CNY', amount: cnyFirstAmount![1], minAmount: cnyFirstMin?.[1] },
          { currency: 'USD', amount: cnyFirstAmount![2], minAmount: cnyFirstMin?.[2] },
        ];
    const bills = balances.flatMap((balance) => {
      const amount = parseAmount(balance.amount ?? '');
      if (amount == null) return [];
      const bill = buildBill({
        bankName: '华夏银行',
        cardLast4: UNKNOWN_CARD_TAIL,
        holderName: pickHolder(text),
        amount,
        minAmount: balance.minAmount ? parseAmount(balance.minAmount) : null,
        currency: balance.currency,
        statementDate,
        dueDate,
      });
      return bill ? [bill] : [];
    });
    // 明细为单行连续流（仅人民币区）："08/03 08/03 财付通i车位 5616 ￥8.00"，金额符号直接使用；
    // 还款类交易摘要与完整卡号跨行（"银联信用卡还款\n6222020000000000 5986 -￥920.74"），卡尾前允许可选完整卡号
    const rmbStart = text.indexOf('人民币账务信息');
    const usdStart = text.indexOf('美元账务信息');
    if (rmbStart >= 0) {
      const section = usdStart > rmbStart ? text.slice(rmbStart, usdStart) : text.slice(rmbStart);
      const txns: ParsedTransaction[] = [];
      for (const m of section.matchAll(
        /(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(.{2,50}?)\s+(?:\d{15,19}\s+)?(\d{4})\s+(-?)￥\s*([\d,]+\.\d{2})/g,
      )) {
        const value = parseAmount(m[6]);
        if (value == null) continue;
        txns.push({ date: m[1], description: m[3].trim(), amount: m[5] === '-' ? -value : value, currency: 'CNY', cardLast4: m[4] });
      }
      const cnyBill = bills.find((bill) => bill.currency === 'CNY');
      if (cnyBill && txns.length > 0) applyTransactionTails(cnyBill, txns);
    }
    if (usdStart >= 0) {
      const section = text.slice(usdStart);
      const txns: ParsedTransaction[] = [];
      for (const m of section.matchAll(
        /(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(.{2,50}?)\s+(?:\d{15,19}\s+)?(\d{4})\s+(-?)[＄$]\s*([\d,]+\.\d{2})/g,
      )) {
        const value = parseAmount(m[6]);
        if (value == null) continue;
        txns.push({ date: m[1], description: m[3].trim(), amount: m[5] === '-' ? -value : value, currency: 'USD', cardLast4: m[4] });
      }
      const usdBill = bills.find((bill) => bill.currency === 'USD');
      if (usdBill && txns.length > 0) applyTransactionTails(usdBill, txns);
    }
    propagateAccountBillTails(bills);
    return bills;
  },
};
