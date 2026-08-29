import type { CurrentCycleTransactionParser, ParsedCurrentCycleTransaction } from '../types';
import { mailText, normalizeCurrency, parseAmount } from '../_util';
import { fromYmd } from '../../lib/dates';

/**
 * 招商银行“每日信用管家”解析器。
 * 该邮件只描述上一自然日发生的交易，不是正式账单，只能进入当前账期未出账明细。
 */
export const cmbdaily2026Parser: CurrentCycleTransactionParser = {
  id: 'cmbdaily2026',
  bankName: '招商银行',
  kind: 'current-cycle-transactions',
  senderPatterns: ['@message.cmbchina.com', '@ccb.cmbchina.com'],
  subjectPatterns: [/^每日信用管家$/],
  requireSender: true,

  parse(mail) {
    if (mail.subject.trim() !== '每日信用管家') return [];
    const text = mailText(mail);
    if (!text) return [];

    const lines = text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const transactions: ParsedCurrentCycleTransaction[] = [];
    let businessDate: string | null = null;

    for (let index = 0; index < lines.length; index++) {
      const dateMatch = lines[index]!.match(/(\d{4})\/(\d{2})\/(\d{2}).*(?:您的消费明细如下|消费(?:人民币)?)/);
      if (dateMatch) {
        businessDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
        continue;
      }
      if (!businessDate) continue;

      const timeMatch = lines[index]!.match(/^(\d{2}):(\d{2}):(\d{2})$/);
      if (!timeMatch) continue;
      const amountMatch = lines[index + 1]?.match(/^(CNY|USD|RMB|人民币)\s*(-?[\d,]+(?:\.\d{1,2})?)$/i);
      const detailLine = lines[index + 2];
      if (!amountMatch || !detailLine) continue;

      const amount = parseAmount(amountMatch[2]!);
      const midnight = fromYmd(businessDate);
      if (amount == null || !midnight) continue;
      const transactionAt = new Date(
        midnight.getTime()
          + Number(timeMatch[1]) * 3_600_000
          + Number(timeMatch[2]) * 60_000
          + Number(timeMatch[3]) * 1_000,
      );
      const detailMatch = detailLine.match(/^(?:尾号(\d{4})\s+)?(\S+)\s+(.+)$/);
      if (!detailMatch) continue;

      transactions.push({
        date: `${businessDate.replace(/-/g, '/')} ${timeMatch[0]}`,
        transactionAt,
        description: `${detailMatch[2]} ${detailMatch[3]}`.trim(),
        amount,
        currency: normalizeCurrency(amountMatch[1]),
        cardLast4: detailMatch[1] ?? null,
      });
      index += 2;
    }

    return transactions.length > 0 ? [{ bankName: '招商银行', transactions }] : [];
  },
};
