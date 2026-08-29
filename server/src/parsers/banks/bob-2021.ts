import type { BankParser, MailContext, ParsedBill } from '../types';
import { buildBill, mailText, parseAmount, parseDate, pick, pickHolder, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 北京银行信用卡电子账单解析器（2021-2022 旧模板）
 * 实测邮件特征（service@ebill.bankofbeijing.com.cn）：
 *   标题: 北京银行-信用卡电子账单
 *   正文（极短，字段名带空格、冒号全角/半角混用）：
 *     最 后 还 款 日: 2022-02-09 账    单    日 : 2022-01-20
 *     本期应还款金额: ￥2,741.50 本期最低还款金额: ￥274.15（￥ 前缀，2026 版为"元"后缀）
 *   无卡号、无交易明细（详情在链接跳转页，不可解析）。
 */
export const bob2021Parser: BankParser = {
  id: 'bob2021',
  bankName: '北京银行',
  priority: 90,
  senderPatterns: ['service@ebill.bankofbeijing.com.cn'],
  subjectPatterns: [/北京银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const stmtRaw = pick(text, [/账\s*单\s*日\s*[：:]\s*(\d{4}-\d{2}-\d{2})/]);
    const dueRaw = pick(text, [/最\s*后\s*还\s*款\s*日\s*[：:]\s*(\d{4}-\d{2}-\d{2})/]);
    const amountRaw = pick(text, [/本期应还款金额\s*[：:]\s*￥\s*(-?[\d,]+\.\d{2})/]);
    const minRaw = pick(text, [/本期最低还款金额\s*[：:]\s*￥\s*(-?[\d,]+\.\d{2})/]);
    if (!stmtRaw || !dueRaw || !amountRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amountRaw);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '北京银行',
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
