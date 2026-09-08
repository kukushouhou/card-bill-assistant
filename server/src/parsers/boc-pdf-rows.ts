import type { MailContext, ParsedTransaction, PdfTextPage } from './types';
import { normalizeCurrency, parseAmount } from './_util';

type Item = PdfTextPage['items'][number];
const datePattern = '(?:\\d{4}[-/]\\d{2}[-/]\\d{2}|\\d{2}/\\d{2})';
const pair = new RegExp(`^(${datePattern})\\s+(${datePattern})(?:\\s+(\\d{4})\\b)?`);
const normalizeDate = (text: string) => text.replaceAll('/', '-');
const key = (a: string, b: string, tail?: string | null) => `${normalizeDate(a)}:${normalizeDate(b)}:${tail ?? ''}`;

/** 金额取 PDF 原始列位置；绝不以还款合计、商户描述或汇率猜测借贷方向。 */
export function bocPdfTransactions(mail: MailContext): ParsedTransaction[] | null {
  if (!mail.pdfPages?.length || !mail.pdfText) return null;
  const positioned: Array<{ date: string; posted: string; tail: string | null; owner?: string; amount: number; currency: string; waiver?: string }> = [];
  let owner: string | undefined, currency = 'CNY', depositX: number | undefined, expenseX: number | undefined, attachment = -1;
  for (const page of mail.pdfPages) {
    if (page.attachment !== attachment) { attachment = page.attachment; owner = undefined; depositX = undefined; expenseX = undefined; currency = 'CNY'; }
    const lines: Array<{ y: number; items: Item[] }> = [];
    for (const item of [...page.items].filter((item) => item.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x)) {
      const last = lines.at(-1);
      if (last && Math.abs(last.y - item.y) < 2) last.items.push(item);
      else lines.push({ y: item.y, items: [item] });
    }
    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
      const text = line.items.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim();
      const card = text.match(/卡号[：:]\s*(\d{4})[）)]?/);
      if (card) owner = card[1];
      const cur = text.match(/(?:人民币|外币|美元)\s*\/\s*([A-Z]{3})|\b(RMB|USD)\s+Transaction/);
      if (cur) currency = normalizeCurrency(cur[1] ?? cur[2]);
      for (const item of line.items) {
        if (/^Deposit\b/.test(item.text)) depositX = item.x;
        if (/^Expenditure\b/.test(item.text)) expenseX = item.x;
      }
      const head = text.match(pair);
      if (!head) continue;
      if (depositX == null || expenseX == null) {
        if (owner) throw new Error('中行 PDF 交易区缺少存入／支出列，无法确定金额方向');
        continue;
      }
      const amounts = line.items.filter((item) => item.x >= depositX! - 6 && /^-?[\d,]+\.\d{2}$/.test(item.text.trim()));
      if (!amounts.length && /年费/.test(text) && /减免|免除/.test(text)) {
        positioned.push({ date: head[1]!, posted: head[2]!, tail: head[3] ?? null, owner, currency, amount: 0,
          waiver: text.slice(head[0].length).trim() });
        continue;
      }
      if (amounts.length !== 1) throw new Error('中行 PDF 交易行的存入／支出金额无法唯一确定');
      const amountItem = amounts[0]!;
      const value = parseAmount(amountItem.text)!;
      positioned.push({ date: head[1]!, posted: head[2]!, tail: head[3] ?? null, owner, currency,
        amount: Math.abs(value) * (amountItem.x < (depositX + expenseX) / 2 ? -1 : 1) });
    }
  }
  const textHeads = [...mail.pdfText.matchAll(new RegExp(`(${datePattern})\\s+(${datePattern})(?:\\s+(\\d{4})\\b)?`, 'g'))];
  let cursor = 0;
  return positioned.map((row) => {
    let found = -1;
    for (let index = cursor; index < textHeads.length; index++) {
      const h = textHeads[index]!;
      if (key(h[1]!, h[2]!, h[3]) === key(row.date, row.posted, row.tail)) { found = index; break; }
    }
    if (found < 0) throw new Error('中行 PDF 交易文字与表格行不一致');
    const h = textHeads[found]!;
    cursor = found + 1;
    if (row.waiver) return { date: row.date, description: row.waiver, amount: 0, currency: row.currency,
      cardLast4: row.tail, ...(row.owner ? { statementAccountCardLast4: row.owner } : {}) };
    const segment = mail.pdfText!.slice(h.index! + h[0].length, textHeads[found + 1]?.index ?? mail.pdfText!.length);
    const amounts = [...segment.matchAll(/-?[\d,]+\.\d{2}(?!\d)/g)];
    const end = amounts.find((m) => Math.abs(parseAmount(m[0]) ?? NaN) === Math.abs(row.amount));
    if (!end) throw new Error('中行 PDF 入账金额与原文不一致');
    const description = segment.slice(0, end.index).replace(/\s+/g, ' ').trim();
    if (!description) throw new Error('中行 PDF 明细缺少描述');
    return { date: row.date, description, amount: row.amount, currency: row.currency, cardLast4: row.tail,
      ...(row.owner ? { statementAccountCardLast4: row.owner } : {}) };
  });
}
