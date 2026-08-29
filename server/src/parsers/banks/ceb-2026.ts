import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, cardTailLine, dateLine, mailText, mergeAccountBillsByCurrency, parseAmount, parseDate, pick, pickHolder } from '../_util';

/**
 * 光大银行信用卡电子账单解析器（多卡表格：卡号/卡名/本期余额/应还款额/最低还款额）
 * 实测邮件特征（cebbank@cardcenter.cebbank.com）：
 *   标题: 光大信用卡电子账单
 *   正文: 账单日 Statement Date 2026/08/12 / 到期还款日 Payment Due Date 2026/08/31
 *         卡行: 40625406****6605 VISA阳光商旅信用卡 9.07 9.07 0.18（多行，余额可为"(存款)110.00"）
 */
export const ceb2026Parser: BankParser = {
  id: 'ceb2026',
  bankName: '光大银行',
  senderPatterns: ['@cardcenter.cebbank.com', '@cardservice.cebbank.com'],
  subjectPatterns: [/光大.*电子账单/, /光大.*电子对账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // HTML 拍平后标签与值间隔大量空行，中英文标签间也用 \s* 兼容
    const stmtRaw = pick(text, [/账单日\s*Statement Date\s*(\d{4}\/\d{2}\/\d{2})/]);
    const dueRaw = pick(text, [/到期还款日\s*Payment Due Date\s*(\d{4}\/\d{2}\/\d{2})/]);
    if (!stmtRaw || !dueRaw) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    if (!statementDate || !dueDate) return [];

    const holderName = pickHolder(text);
    const bills: ParsedBill[] = [];
    const tableHeads = [...text.matchAll(/账号\s*Account Number[\s\S]{0,500}?Minimum Payment Due/g)];
    const summarySegments = tableHeads.length > 0
      ? tableHeads.map((head, index) => {
          const start = (head.index ?? 0) + head[0].length;
          const details = text.indexOf('· 交易明细', start);
          return {
            currency: index === 0 ? 'CNY' : 'USD',
            text: text.slice(start, details > start ? details : tableHeads[index + 1]?.index ?? text.length),
          };
        })
      : [{ currency: 'CNY', text }];
    for (const summary of summarySegments) {
      const seen = new Set<string>();
      for (const m of summary.text.matchAll(
        /(\d{8})\*{4}(\d{4})\s*([^\n\d]+?)\s*\(?(?:存款)?\)?\s*(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/g,
      )) {
        if (seen.has(m[2])) continue;
        const amount = parseAmount(m[5]);
        const minAmount = parseAmount(m[6]);
        if (amount == null || minAmount == null) continue;
        seen.add(m[2]);
        const bill = buildBill({
          bankName: '光大银行',
          cardLast4: m[2],
          holderName,
          amount,
          minAmount,
          currency: summary.currency,
          statementDate,
          dueDate,
          cardNoFull: `${m[1]}****${m[2]}`,
        });
        if (bill) bills.push(bill);
      }
    }
    attachCebTransactions(text, bills);
    return mergeAccountBillsByCurrency(bills);
  },
};

/**
 * 光大明细行组（分行单元格）：MM/DD / MM/DD / 卡尾 / 交易说明 / 金额。
 * 金额可带 "(存入)" 前缀（还款/冲抵取负），如 "(存入)1,194.62"。
 */
function attachCebTransactions(text: string, bills: ParsedBill[]): void {
  if (bills.length === 0) return;
  const accountHeads = [...text.matchAll(/账号\s*Account Number[：:]?\s*(\d{8})\*{4}(\d{4})/g)];
  for (let accountIndex = 0; accountIndex < accountHeads.length; accountIndex++) {
    const head = accountHeads[accountIndex]!;
    const ownerTail = head[2]!;
    const segment = text.slice(head.index ?? 0, accountHeads[accountIndex + 1]?.index ?? text.length);
    const currency = /Amount\(USD\)|美元账户\s*USD Account/.test(segment) ? 'USD' : 'CNY';
    const bill = bills.find((candidate) => candidate.cardLast4 === ownerTail && candidate.currency === currency);
    if (!bill) continue;
    const lines = segment.split('\n').map((line) => line.trim()).filter(Boolean);
    const transactions: ParsedTransaction[] = [];
    for (let i = 0; i + 3 < lines.length; i++) {
      const date = dateLine(lines[i] ?? '');
      const postDate = date ? dateLine(lines[i + 1] ?? '') : null;
      if (!date || !postDate || !/^\d{2}\/\d{2}$/.test(date)) continue;
      const explicitTail = cardTailLine(lines[i + 2] ?? '');
      const descriptionStart = i + (explicitTail ? 3 : 2);
      const description: string[] = [];
      let amountIndex = descriptionStart;
      for (; amountIndex < Math.min(lines.length, descriptionStart + 8); amountIndex++) {
        if (/^(?:[（(]存入[）)])?\s*-?[\d,]+\.\d{2}$/.test(lines[amountIndex] ?? '')) break;
        description.push(lines[amountIndex]!);
      }
      const amountLine = lines[amountIndex] ?? '';
      const amountMatch = amountLine.match(/^(?:[（(]存入[）)])?\s*(-?[\d,]+\.\d{2})$/);
      const value = amountMatch ? parseAmount(amountMatch[1]) : null;
      if (value == null || description.length === 0) continue;
      transactions.push({
        date,
        description: description.join(' '),
        amount: /[（(]存入[）)]/.test(amountLine) ? -value : value,
        currency,
        cardLast4: explicitTail,
      });
      i = amountIndex;
    }
    if (transactions.length > 0) bill.transactions = transactions;
  }
}
