import type { BankParser, MailContext, ParsedBill } from '../types';
import { buildBill, mailText, parseAmount, parseDate, pick, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 浦发银行信用卡电子账单解析器（账户级账单，无卡号，以 '----' 作为账户标识）
 * 实测邮件特征（estmtservice@eb.spdb.com.cn / estmtservice@eb.spdbccc.com.cn）：
 *   标题: 浦发银行-信用卡电子账单
 *   正文: 首行 "20260819 65509972 0412951"（账单日期 客户号 账单编号，金额在跳转链接后；
 *         spdbccc 通道该行与"尊敬的 XX 先生:"同行，正则不锚定行尾）
 *         本期应还款总额： ￥1182.63 ＄0.00
 *         本期最低还款额： ￥59.13 ＄0.00
 *         到期还款日： 2026/09/08
 *   注意：金额与标签之间夹着 "[https://...]" 跳转链接，正则需容忍
 *   邮件仅含摘要（明细需点击链接到网上账单中心查看），无交易明细可解析
 */
export const spdb2026Parser: BankParser = {
  id: 'spdb2026',
  bankName: '浦发银行',
  senderPatterns: ['estmtservice@eb.spdb.com.cn', 'estmtservice@eb.spdbccc.com.cn'],
  subjectPatterns: [/浦发银行.*电子账单/, /浦发.*信用卡.*对账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // 首行账单编号：出账日期 + 客户号 + 编号（行尾可能直接跟称呼文字）
    const stmtRaw = pick(text, [/^\s*(\d{8})\s+\d{6,}\s+\d+/m]);
    const dueRaw = pick(text, [/到期还款日：\s*(\d{4}\/\d{2}\/\d{2})/]);
    const amountRaw = pick(text, [/本期应还款总额：\s*(?:\[[^\]]*\]\s*)*￥\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/本期最低还款额：\s*(?:\[[^\]]*\]\s*)*￥\s*(-?[\d,]+\.\d{2})/]);
    if (!stmtRaw || !dueRaw || !amountRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '浦发银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount,
      minAmount: minRaw ? parseAmount(minRaw) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    const bills = bill ? [bill] : [];
    const usdAmount = text.match(/本期应还款总额：[\s\S]{0,300}?[＄$]\s*(-?[\d,]+\.\d{2})/)?.[1];
    const usdMin = text.match(/本期最低还款额：[\s\S]{0,300}?[＄$]\s*(-?[\d,]+\.\d{2})/)?.[1];
    if (usdAmount != null) {
      const usdBill = buildBill({
        bankName: '浦发银行',
        cardLast4: UNKNOWN_CARD_TAIL,
        holderName: pickHolder(text),
        amount: parseAmount(usdAmount) ?? 0,
        minAmount: usdMin == null ? 0 : parseAmount(usdMin),
        currency: 'USD',
        statementDate,
        dueDate,
      });
      if (usdBill) bills.push(usdBill);
    }
    return bills;
  },
};
