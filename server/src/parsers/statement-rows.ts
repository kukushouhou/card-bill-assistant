import { parseDocument } from 'htmlparser2';
import type { MailContext, ParsedBill, ParsedTransaction } from './types';
import { normalizeCurrency, parseAmount } from './_util';

type Node = ReturnType<typeof parseDocument>['children'][number];
export interface StatementRow { cells: string[]; offset: number }
export interface StatementTable { text: string; rows: StatementRow[] }
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const block = /^(?:br|p|div|tr|td|th|table|li|h[1-6])$/;

/** 保留单元格边界、空金额列和区块顺序，不受邮件 text 部分的自动折行影响。 */
export function statementTable(html: string): StatementTable {
  const doc = parseDocument(html);
  const chunks: string[] = [];
  const rows: StatementRow[] = [];
  let length = 0;
  const append = (s: string) => { chunks.push(s); length += s.length; };
  const cellText = (node: Node): string => {
    if (node.type === 'text') return node.data;
    if ('name' in node && /^(script|style)$/.test(node.name)) return '';
    if (!('children' in node)) return '';
    return node.children.map(cellText).join('') + ('name' in node && block.test(node.name) ? '\n' : '');
  };
  const visit = (node: Node) => {
    if (node.type === 'text') { append(node.data); return; }
    if ('name' in node && /^(script|style)$/.test(node.name)) return;
    if (!('children' in node)) return;
    if ('name' in node && node.name === 'tr') {
      const cells = node.children.filter((child) => 'name' in child && /^(td|th)$/.test(child.name));
      rows.push({ cells: cells.map((cell) => compact(cellText(cell))), offset: length });
    }
    for (const child of node.children) visit(child);
    if ('name' in node && block.test(node.name)) append('\n');
  };
  for (const node of doc.children) visit(node);
  return { text: chunks.join(''), rows };
}

export function isTransactionDate(value: string): boolean {
  return /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{8}|\d{6}|\d{1,2}[-/]\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(value);
}

/** 交易区里每个完整日期对都须被读取；不能把匹配失败当作没有交易。 */
export function assertCompleteRecords(text: string, consumed: number): void {
  const formats = ['\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}', '\\d{8}', '\\d{6}', '\\d{2}/\\d{2}'];
  // 两列日期采用同一格式，避免把页脚编号与其后的有效期误作交易。
  const pairs = formats.map((date) => `${date}\\s+${date}`).join('|');
  const expected = [...text.matchAll(new RegExp(`\\b(?:${pairs})\\b`, 'g'))].length;
  if (expected !== consumed) throw new Error('交易区块存在未完整读取的记录');
}

function money(value: string): number | null {
  // 优惠说明里的数字不是入账金额。
  const clean = value.replace(/[（(]已立减[^）)]*[）)]/g, '').replace(/^(-)\s*([￥¥＄$])/, '$2$1').trim();
  const m = clean.match(/^(?:[￥¥＄$]|[A-Z]{3}|人民币|美元|[（(]存入[）)])?\s*[:：]?\s*([-+]?\s*[\d,]+\.\d{2})(?:\s*\/?\s*(?:[A-Z]{3}|人民币|美元))?$/i);
  return m ? parseAmount(m[1]!.replace(/\s+/g, '')) : null;
}

function currency(value: string): string {
  return normalizeCurrency(value.match(/\b(?:CNY|RMB|USD|HKD|EUR|JPY|AUD|CAD)\b/i)?.[0]?.toUpperCase()
    ?? (/[＄$]|美元/.test(value) ? 'USD' : 'CNY'));
}
const fieldCurrency = (value: string, preceding: string) => currency(/[A-Z]{3}|[＄$￥¥]|人民币|美元/.test(value) ? value : preceding);

export type DetailLayout = 'abc' | 'five' | 'citic' | 'ccb' | 'boc' | 'bocom' | 'hxb' | 'cib' | 'cgb' | 'ceb';

/** 返回 null 表示没有 HTML 交易行，调用方继续使用相应的纯文本模板。 */
export function htmlTransactions(mail: MailContext, layout: DetailLayout): ParsedTransaction[] | null {
  if (!mail.html) return null;
  const table = statementTable(mail.html);
  const result: ParsedTransaction[] = [];
  let recognizedRows = 0;
  for (const row of table.rows) {
    const c = [...row.cells];
    while (c[0] === '') c.shift();
    if (!isTransactionDate(c[0] ?? '') || !isTransactionDate(c[1] ?? '')) continue;
    recognizedRows++;
    if (c.length < 4) throw new Error(`${layout} 交易表存在无法完整读取的记录`);
    if (layout === 'ccb') c[2] = (c[2] ?? '').replace(/^(\d{4})[／/]扫码$/, '$1');
    const before = table.text.slice(0, row.offset);
    let amount: number | null = null;
    let originalAmount: number | null = null;
    let originalCurrency: string | undefined;
    let cur = 'CNY';
    let tail: string | null = null;
    let description = '';
    let accountTail: string | undefined;
    if (layout === 'abc') {
      tail = /^\d{4}$/.test(c[2] ?? '') ? c[2]! : null;
      const amounts = c.map((value, index) => ({ value: money(value), index })).filter((a) => a.index >= 3 && a.value != null);
      const posted = amounts.at(-1);
      if (posted) { amount = -posted.value!; originalAmount = amounts.at(-2)?.value ?? null; cur = currency(c[posted.index]!);
        originalCurrency = currency(c[amounts.at(-2)?.index ?? posted.index]!); }
      description = c.slice(3, amounts[0]?.index ?? 3).join(' ');
    } else if (layout === 'five' || layout === 'hxb') {
      description = c[2] ?? '';
      const at = layout === 'five' ? 3 : 4;
      amount = money(c[at] ?? ''); cur = currency(c[at] ?? '');
      if (cur === 'CNY' && before.lastIndexOf('美元交易明细') > before.lastIndexOf('人民币交易明细')) cur = 'USD';
      const rawTail = c[layout === 'five' ? 4 : 3] ?? '';
      tail = /^\d{4}$/.test(rawTail) ? rawTail : null;
    } else if (layout === 'ceb') {
      tail = /^\d{4}$/.test(c[2] ?? '') ? c[2]! : null;
      description = c[3] ?? '';
      // 金额列为空的分期余额说明不是入账交易；描述内的应还与余额不能当成本行金额。
      if (c.slice(4).every((value) => !value) && (/本期应还款[\d,.]+[，,].*余额[\d,.]+.*余期/.test(description)
        || /^账单分期\s*[（(]分期[）)]\s*[\d,]+\.\d{2}$/.test(description))) continue;
      // 外币表在人民币金额列留空，实际美元金额位于其后的列。
      const monetary = c.slice(4).filter((value) => money(value) != null);
      amount = monetary.length === 1 ? money(monetary[0]!) : null;
      if (amount != null && /[（(]存入[）)]/.test(monetary[0]!)) amount = -Math.abs(amount);
      cur = before.lastIndexOf('美元账户') > before.lastIndexOf('人民币账户') ? 'USD' : 'CNY';
    } else if (layout === 'boc') {
      tail = /^\d{4}$/.test(c[2] ?? '') ? c[2]! : null;
      description = c[3] ?? '';
      const deposit = money(c[4] ?? ''), expenditure = money(c[5] ?? '');
      if (deposit != null && expenditure != null && deposit !== 0 && expenditure !== 0) throw new Error('中行明细同一行同时出现存入和支出');
      amount = deposit != null && deposit !== 0 ? -Math.abs(deposit) : expenditure != null ? Math.abs(expenditure) : deposit;
      accountTail = [...before.matchAll(/卡号[:：]\s*(\d{4})[）)]/g)].at(-1)?.[1];
      cur = before.lastIndexOf('美元交易明细') > before.lastIndexOf('人民币交易明细') ? 'USD' : 'CNY';
    } else if (layout === 'cgb') {
      description = c[2] ?? '';
      originalAmount = money(c[3] ?? ''); originalCurrency = currency(c[4] ?? '');
      amount = money(c[5] ?? ''); cur = currency(c[6] || c[4] || '');
      tail = [...before.matchAll(/卡号[:：]\s*\d{4}\*{6,}(\d{4})/g)].at(-1)?.[1] ?? null;
    } else if (layout === 'cib') {
      description = c[2] ?? '';
      const fields = c.slice(3).filter((value) => money(value) != null);
      amount = money(fields.at(-1) ?? ''); cur = currency(fields.at(-1) ?? '');
      if (fields.length > 1) { originalAmount = money(fields[0]!); originalCurrency = currency(fields[0]!); }
    } else {
      const hasTail = /^\d{4}$/.test(c[2] ?? '');
      tail = hasTail ? c[2]! : null;
      const start = hasTail ? 3 : 2;
      const fields = c.map((value, index) => ({ value: money(value), index })).filter((a) => a.index >= start && a.value != null);
      const posted = fields.at(-1), original = fields.at(-2);
      if (posted) {
        amount = posted.value;
        cur = fieldCurrency(c[posted.index] ?? '', c[posted.index - 1] ?? '');
        if (original) { originalAmount = original.value; originalCurrency = fieldCurrency(c[original.index] ?? '', c[original.index - 1] ?? ''); }
        let end = fields[0]!.index;
        if (/^(?:CNY|RMB|USD|HKD|EUR)$/.test(c[end - 1] ?? '')) end--;
        description = c.slice(start, end).filter(Boolean).join(' ');
      }
      if (layout === 'bocom' && amount != null) {
        const headings = before.replace(/[／/，,]/g, '、').replace(/\s+/g, '');
        const refund = headings.lastIndexOf('还款、退货'), charge = headings.lastIndexOf('消费、取现');
        if (refund < 0 && charge < 0) throw new Error('交通银行明细缺少借贷区块标识');
        amount = Math.abs(amount) * (refund > charge ? -1 : 1);
        if (!tail) tail = [...before.matchAll(/卡号末四位\s*(\d{4})/g)].at(-1)?.[1] ?? null;
      }
    }
    if (amount == null || !description.trim()) throw new Error(`${layout} 交易表存在无法完整读取的第 ${result.length + 1} 条明细`);
    result.push({ date: c[0]!.split(' ')[0], description: compact(description), amount: amount === 0 ? 0 : amount, currency: cur,
      cardLast4: tail, ...(accountTail ? { statementAccountCardLast4: accountTail } : {}),
      ...(originalAmount != null ? { originalAmount, originalCurrency: originalCurrency ?? cur } : {}) });
  }
  return recognizedRows ? result : null;
}

/** 根据邮件内账户区块或唯一的同币种账户归属；绝不因卡尾变化丢弃交易。 */
export function attachStatementTransactions(bills: ParsedBill[], transactions: ParsedTransaction[]): void {
  for (const bill of bills) bill.transactions = [];
  for (const transaction of transactions) {
    const candidates = bills.filter((bill) => bill.currency === normalizeCurrency(transaction.currency ?? 'CNY'));
    const account = transaction.statementAccountCardLast4;
    const exact = candidates.filter((bill) => account ? bill.cardLast4 === account
      : [bill.cardLast4, ...(bill.cardLast4s ?? [])].includes(transaction.cardLast4 ?? ''));
    const target = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!target && candidates.length > 1 && candidates.every((bill) => bill.bankName === '建设银行')) {
      // 这里只借首项传递账户级明细，持久化时只关联邮件，不关联这张 Bill。
      candidates[0]!.transactions!.push({ ...transaction, statementShared: true });
      continue;
    }
    if (!target) throw new Error('交易明细无法唯一归入原文账单账户');
    target.transactions!.push({ ...transaction, statementAccountCardLast4: target.cardLast4 });
  }
}

/** 农行纯文本：只有成对日期才开始下一笔，描述中的单个日期不是分隔符。 */
export function abcTextTransactions(text: string): ParsedTransaction[] {
  const heads = [...text.matchAll(/\b(\d{8}|\d{6})\s+(\d{8}|\d{6})\b/g)]
    .filter((m) => m[1]!.length === m[2]!.length);
  const rows: ParsedTransaction[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const segment = text.slice(h.index! + h[0].length, heads[i + 1]?.index ?? text.length);
    const m = segment.match(/^\s*(?:(\d{4})\s+)?([\s\S]+?)\s+(-?[\d,]+\.\d{2})\s*\/\s*CNY\s+(-?[\d,]+\.\d{2})\s*\/\s*CNY/);
    if (!m) throw new Error('农行存在未完整读取的交易记录');
    rows.push({ date: h[1], cardLast4: m[1] ?? null, description: compact(m[2]!), amount: -(parseAmount(m[4]!) ?? 0), currency: 'CNY' });
  }
  return rows;
}

/** 五列纯文本按成对日期分记录；字段之间可以换行，也可以连续排版。 */
export function fiveColumnTextTransactions(text: string, amountRe: RegExp): ParsedTransaction[] {
  const date = '(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{8})';
  const heads = [...text.matchAll(new RegExp(`\\b(${date})\\s+(${date})\\b`, 'g'))];
  const amount = amountRe.source.replace(/^\^/, '').replace(/\$$/, '').replace('RMB:', 'RMB:\\s*');
  const record = new RegExp(`^\\s*([\\s\\S]+?)\\s+${amount}\\s+(\\d{4})(?:\\s|$)`);
  return heads.map((head, index) => {
    const segment = text.slice(head.index! + head[0].length, heads[index + 1]?.index ?? text.length);
    const match = segment.match(record);
    if (!match) throw new Error('交易区块存在无法完整读取的五列记录');
    const value = parseAmount(match[2]);
    if (value == null) throw new Error('交易区块入账金额无效');
    return { date: head[1], description: compact(match[1]!), amount: value,
      cardLast4: match[3] === '0000' ? null : match[3] };
  });
}
