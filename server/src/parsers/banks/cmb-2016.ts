import type { BankParser, MailContext, ParsedBill } from '../types';
import { buildBill, mailText, parseAmount, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';
import { dayOfMonthClamped, dayOf, shanghaiMidnight } from '../../lib/dates';

/**
 * 招商银行信用卡电子账单旧版解析器（2016-2020 摘要模板，无账单周期行）
 * 与现役 cmb2026 差异：正文无"周期 ￥额度 ￥应还 ￥最低 还款日"摘要行，仅有金额序列：
 *   2016 型（html 拍平分行）: "您 2016 年 06 月信用卡个人卡账单已出" / "06 月 26 日"（还款日）
 *            / ￥应还 ＄美元应还 ￥最低 ＄美元最低（明细为图片链接，正文无交易文字）
 *   2020 型: 标题"电子账单2020年1月"含账单年月，正文仅"MM/DD"还款日 + 同款 ￥/＄金额序列
 * 账单日正文未给出：取邮件发送日（账单日次日发出）锚定到账单年月内。
 * 2016 年部分图片账单正文无任何金额 → 返回空数组，由框架记为不可解析。
 * 正文无交易明细，招行费用行「0000 + 交易地空」特例无判定入口。
 */
export const cmb2016Parser: BankParser = {
  id: 'cmb2016',
  bankName: '招商银行',
  priority: 90,
  senderPatterns: ['@message.cmbchina.com', '@ccb.cmbchina.com'],
  subjectPatterns: [/招商银行.*电子账单/, /电子账单.*招商银行/],

  parse(mail: MailContext): ParsedBill[] {
    // 同发件人还有"每日信用管家"等推送，仅处理账单类标题
    if (!/电子账单/.test(mail.subject)) return [];
    const text = mailText(mail);
    if (!text) return [];

    // 账单年月：正文"您 YYYY 年 MM 月信用卡个人卡账单已出"（2016 型），退而取标题"YYYY年M月"（2020 型）
    const ym =
      text.match(/您\s*(\d{4})\s*年\s*(\d{1,2})\s*月信用卡个人卡账单已出/) ??
      mail.subject.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (!ym) return [];
    const year = Number(ym[1]);
    const month = Number(ym[2]);

    // 到期还款日：2016 型"MM 月 DD 日"，2020 型首个"MM/DD"；月号与账单月不符时视为次月（月末出账跨月）
    let dueDay: number | null = null;
    let dueYear = year;
    let dueMonth = month;
    const cn = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    const slash = text.match(/(\d{1,2})\/(\d{1,2})/);
    if (cn) {
      dueDay = Number(cn[2]);
      if (Number(cn[1]) !== month) ({ year: dueYear, month: dueMonth } = nextMonth(year, month));
    } else if (slash) {
      dueDay = Number(slash[2]);
      if (Number(slash[1]) !== month) ({ year: dueYear, month: dueMonth } = nextMonth(year, month));
    }
    if (dueDay == null) return [];
    const dueDate = dayOfMonthClamped(dueYear, dueMonth, dueDay);

    // 金额序列（拍平后 ￥应还 ＄应还 ￥最低 ＄最低）：人民币序列第 1 个为应还、第 2 个为最低
    const rmb: number[] = [];
    for (const m of text.matchAll(/[￥¥]\s*(-?[\d,]+\.\d{2})/g)) {
      const v = parseAmount(m[1]!);
      if (v != null) rmb.push(v);
    }
    if (rmb.length === 0) return [];
    const usd: number[] = [];
    for (const m of text.matchAll(/[＄$]\s*(-?[\d,]+\.\d{2})/g)) {
      const value = parseAmount(m[1]!);
      if (value != null) usd.push(value);
    }

    // 出账日：邮件发送日（上海时区）锚定到账单年月（跨月发出的月末账单取账单月内日期）
    const statementDate = dayOfMonthClamped(year, month, dayOf(shanghaiMidnight(mail.date)));

    const bill = buildBill({
      bankName: '招商银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount: rmb[0]!,
      minAmount: rmb.length > 1 ? rmb[1]! : null,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    const bills = bill ? [bill] : [];
    if (usd.length > 0) {
      const usdBill = buildBill({
        bankName: '招商银行',
        cardLast4: UNKNOWN_CARD_TAIL,
        holderName: pickHolder(text),
        amount: usd[0]!,
        minAmount: usd.length > 1 ? usd[1]! : null,
        currency: 'USD',
        statementDate,
        dueDate,
      });
      if (usdBill) bills.push(usdBill);
    }
    return bills;
  },
};

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}
