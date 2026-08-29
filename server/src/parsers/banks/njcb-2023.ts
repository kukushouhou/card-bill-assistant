import type { BankParser, MailContext, ParsedBill } from '../types';
import { buildBill, mailText, parseAmount, pick, UNKNOWN_CARD_TAIL } from '../_util';
import { addDays } from '../../lib/dates';

/**
 * 南京银行 N CARD 海报式电子账单解析器（2023-2025 旧模板）
 * 实测邮件特征（cc@message.njcb.com.cn）：
 *   标题: 南京银行N CARD账户电子账单
 *   正文（海报式 HTML，字段名与 2026 版完全不同，无"账 单 日"等字段）：
 *     张三 先生的N Card信用卡账单 / 2023-12（期次）
 *     415.00（本期应还总额）/ 2024年01月06日（到期还款日，拆行）/ 120.70（最低还款）
 *   无卡号、无交易明细（明细在图片中不可解析）。
 * 出账日无字段：真实卡规则为"出账日+25天=还款日"（实测 2039 卡 2025-05 起 12 日出账、
 * 次月 6/7 日还款），账单邮件在出账日次日（13 日）发送——取邮件日期会晚一天，
 * 故出账日 = 还款日 - 25 天。
 */
export const njcb2023Parser: BankParser = {
  id: 'njcb2023',
  bankName: '南京银行',
  priority: 90,
  senderPatterns: ['@message.njcb.com.cn'],
  subjectPatterns: [/南京银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // 到期还款日："2024年" "01" "月" "06" "日" 拆行散落（span 去标签后以空白分隔）
    const dueM = text.match(/(\d{4})年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (!dueM) return [];
    const dueDate = new Date(
      `${dueM[1]}-${String(dueM[2]).padStart(2, '0')}-${String(dueM[3]).padStart(2, '0')}T00:00:00+08:00`,
    );

    // 应还总额 = 还款日之前的最后一个金额；最低还款 = 还款日之后的第一个金额
    const idx = dueM.index ?? 0;
    const before = [...text.slice(0, idx).matchAll(/(-?[\d,]+\.\d{2})/g)];
    const amountM = before[before.length - 1];
    const minM = text.slice(idx + dueM[0].length).match(/(-?[\d,]+\.\d{2})/);
    if (!amountM || !minM) return [];
    const amount = parseAmount(amountM[1]);
    const minAmount = parseAmount(minM[1]);
    if (amount == null) return [];

    const bill = buildBill({
      bankName: '南京银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pick(text, [/([\u4e00-\u9fa5·]{2,4})\s*先?生?的N Card信用卡账单/]),
      amount,
      minAmount,
      currency: 'CNY',
      // 出账日无字段：还款日 - 25 天（真实卡规则 offset+25；邮件在出账日次日发送，取邮件日会晚一天）
      statementDate: addDays(dueDate, -25),
      dueDate,
    });
    return bill ? [bill] : [];
  },
};
