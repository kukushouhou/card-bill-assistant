import type { MailContext, ParsedTransaction } from './types';
import { mailText, normalizeCurrency, parseAmount } from './_util';
import { isTransactionDate, statementTable } from './statement-rows';

/** 平安美元表比人民币表多出交易地点和原币列，按原始单元格读取。 */
export function pabUsdTransactions(mail: MailContext): ParsedTransaction[] {
  const table = mail.html ? statementTable(mail.html) : null;
  const text = table?.text ?? mailText(mail);
  const start = text.indexOf('美元账户交易明细');
  if (start < 0) return [];
  const transactions: ParsedTransaction[] = [];
  for (const row of table?.rows ?? []) {
    const cells = row.cells;
    if (row.offset < start || !isTransactionDate(cells[0] ?? '') || !isTransactionDate(cells[1] ?? '')) continue;
    const before = text.slice(start, row.offset);
    if (before.lastIndexOf('人民币账户交易明细') >= 0) break;
    const amountRaw = cells[5]?.match(/^[＄$]?\s*(-?[\d,]+\.\d{2})$/)?.[1];
    const amount = amountRaw ? parseAmount(amountRaw) : null;
    if (amount == null || !cells[2]) throw new Error('平安美元交易表存在未完整读取的记录');
    const heads = [...before.matchAll(/(?:\*{4,}|[（(])(\d{4})(?:[）)]|\s+合计金额)/g)];
    const head = heads.at(-1);
    const accountSection = [...before.matchAll(/(?:分期\s*Installment|其他\s*Other)/g)].at(-1);
    const tail = head && (!accountSection || head.index! > accountSection.index!) ? head[1]! : null;
    const original = cells[4]?.match(/^([A-Z]{3})\s*(-?[\d,]+\.\d{2})$/);
    if (cells[4] && !original) throw new Error('平安美元交易原币金额无法完整读取');
    transactions.push({ date: cells[0], description: cells[2], amount, currency: 'USD', cardLast4: tail,
      ...(original ? { originalAmount: parseAmount(original[2]), originalCurrency: normalizeCurrency(original[1]) } : {}) });
  }
  // 文本中明确有日期对时，不能把缺少表格当成没有交易。
  const usdSection = text.slice(start).split('人民币账户交易明细')[0]!;
  const expected = [...usdSection.matchAll(/\b\d{4}[-/]\d{2}[-/]\d{2}\s+\d{4}[-/]\d{2}[-/]\d{2}\b/g)].length;
  if (expected !== transactions.length) throw new Error('平安美元交易明细需要完整的原邮件表格');
  return transactions;
}
