import type { BankParser, MailContext, ParsedBill } from '../types';
import {
  attachTransactions,
  buildBill,
  fiveLineTransactions,
  mailText,
  monthlyRuleDate,
  parseAmount,
  parseDate,
  pick,
  pickHolder,
} from '../_util';

/**
 * 湖南省农村信用社（福祥信用卡）电子账单解析器
 * 实测邮件特征（HNRCCcard@ebill.hnnxs.com）：
 *   标题: 湖南省农村信用社联合社信用卡电子账单
 *   正文: 账单日： 每月15日（规则型，实际出账日按账单月份取 15 号）
 *         到期还款日： 2026/09/09
 *         应还款总额（元）： 0.00 / 最低还款额（元）： 0.00
 *         福祥信用卡账户[尾数0107]2026年08月对账单
 */
export const hnnxs2026Parser: BankParser = {
  id: 'hnnxs2026',
  bankName: '湖南农信',
  senderPatterns: ['@ebill.hnnxs.com'],
  subjectPatterns: [/农村信用社.*电子账单/, /福祥信用卡.*账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const cardLast4 = pick(text, [/账户\[尾数(\d{4})\]/]);
    const periodM = text.match(/(\d{4})年(\d{2})月对账单/);
    const dayRaw = pick(text, [/账单日：\s*每月(\d{1,2})日/]);
    const dueRaw = pick(text, [/到期还款日：\s*(\d{4}\/\d{2}\/\d{2})/]);
    const amountRaw = pick(text, [/应还款总额（元）：\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/最低还款额（元）：\s*(-?[\d,]+\.\d{2})/]);
    if (!cardLast4 || !periodM || !dayRaw || !dueRaw || !amountRaw) return [];

    const statementDate = monthlyRuleDate(dayRaw, Number(periodM[1]), Number(periodM[2]));
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '湖南农信',
      cardLast4,
      holderName: pickHolder(text),
      amount,
      minAmount: minRaw ? parseAmount(minRaw) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];
    // 明细为 5 行组：交易日/记账日/摘要/金额/卡尾号；金额负数=转入（还款），正数=支出
    attachTransactions([bill], fiveLineTransactions(text, /^(-?[\d,]+\.\d{2})$/));
    return [bill];
  },
};
