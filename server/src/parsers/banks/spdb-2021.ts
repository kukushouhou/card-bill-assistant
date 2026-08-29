import type { BankParser, MailContext, ParsedBill } from '../types';
import { buildBill, mailText, parseAmount, parseDate, pick, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';
import { addDays } from '../../lib/dates';

/**
 * 浦发银行信用卡电子账单解析器（2021-2024 旧版模板）
 * 旧邮件特征（estmtservice@eb.spdbccc.com.cn）：
 *   标题: 浦发银行-信用卡电子账单
 *   正文: 尊敬的 XX 先生 : / 请 点击 开启您个人信用卡电子对账单。
 *         本期应还款总额： ￥629.29 / 本期最低还款额： ￥62.93
 *         到期还款日： 2022/01/17
 *   与新版差异：正文无首行 "YYYYMMDD 客户号 账单编号"（即无出账日），
 *   按浦发"到期还款日为账单日后第 20 天"规则倒推出账日
 *   账户级账单无卡号，cardLast4 用 '----'（与主解析器一致）
 */
export const spdb2021Parser: BankParser = {
  id: 'spdb2021',
  bankName: '浦发银行',
  priority: 90,
  senderPatterns: ['estmtservice@eb.spdbccc.com.cn'],
  subjectPatterns: [/浦发银行.*电子账单/, /浦发.*信用卡.*对账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const dueRaw = pick(text, [/到期还款日：\s*(\d{4}\/\d{2}\/\d{2})/]);
    const amountRaw = pick(text, [/本期应还款总额：\s*(?:\[[^\]]*\]\s*)*￥\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/本期最低还款额：\s*(?:\[[^\]]*\]\s*)*￥\s*(-?[\d,]+\.\d{2})/]);
    if (!dueRaw || !amountRaw) return [];

    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!dueDate || amount == null) return [];
    // 旧模板无出账日：到期还款日 = 账单日后第 20 天（2026 实测样本同规则），倒推得出
    const statementDate = addDays(dueDate, -20);

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
    return bill ? [bill] : [];
  },
};
