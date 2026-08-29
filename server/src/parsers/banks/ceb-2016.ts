import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, mailText, mergeAccountBillsByCurrency, parseAmount, parseDate, pickHolder } from '../_util';

/**
 * 光大银行信用卡电子对账单解析器（2016-2019 HTML 旧版模板）
 * 与现役 ceb2026 差异：HTML 拍平后所有标签与所有值分行输出（先标签区后值区），
 * 卡号为 19 位（8 位 + **** + 7 位），卡区块为 5 行组（卡号/卡名/余额/应还/最低）。
 * 实测邮件特征（cebbank@cardcenter.cebbank.com，标题"光大银行信用卡电子对账单YYYYMMDD"）：
 *   引导句: 特为您呈上2016年04月13日至2016年05月12日信用卡账户变动情况。
 *           您最晚于2016年05月31日还款（账期期末即出账日）
 *   卡区块（拍平分行）:
 *     00062597****9409975 / 光大白条信用卡 / 2,309.32 / 2,309.32 / 115.47
 *     （卡号 / 卡名 / 本期余额 / 本期应还款额 / 本期最小还款额，多卡多组，后跟"总计"行）
 *   美元账户区块结构相同（同卡重复），仅取人民币区块。
 */
export const ceb2016Parser: BankParser = {
  id: 'ceb2016',
  bankName: '光大银行',
  priority: 80,
  senderPatterns: ['@cardcenter.cebbank.com', '@cardservice.cebbank.com'],
  subjectPatterns: [/光大.*电子账单/, /光大.*电子对账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // 引导句：账期起止 + 到期还款日（出账日 = 账期期末）
    const lead = text.match(
      /特为您呈上(\d{4}年\d{1,2}月\d{1,2}日)至(\d{4}年\d{1,2}月\d{1,2}日)信用卡账户变动情况[，。]?\s*您最晚于(\d{4}年\d{1,2}月\d{1,2}日)还款/,
    );
    if (!lead) return [];
    const statementDate = parseDate(lead[2]!);
    const dueDate = parseDate(lead[3]!);
    if (!statementDate || !dueDate) return [];

    const holderName = pickHolder(text);
    const bills: ParsedBill[] = [];
    for (const currency of ['CNY', 'USD'] as const) {
      const marker = currency === 'CNY' ? '人民币账户' : '美元账户';
      const start = text.indexOf(marker);
      if (start < 0) continue;
      const detailMarker = `${marker}交易明细`;
      const detailStart = text.indexOf(detailMarker, start);
      const otherMarker = currency === 'CNY' ? text.indexOf('美元账户', start + marker.length) : -1;
      const summaryEndCandidates = [detailStart, otherMarker].filter((index) => index > start);
      const section = text.slice(start, summaryEndCandidates.length ? Math.min(...summaryEndCandidates) : text.length);
      const seen = new Set<string>();
      for (const m of section.matchAll(
        /^[ \t]*(\d{8})\*{4}\d*(\d{4})[ \t]*$\s*\n\s*[^\n\d]+?[ \t]*$\s*\n\s*(?:[（(]存款[）)]\s*)?(-?[\d,]+\.\d{2})[ \t]*$\s*\n\s*(?:[（(]存款[）)]\s*)?(-?[\d,]+\.\d{2})[ \t]*$\s*\n\s*(?:[（(]存款[）)]\s*)?(-?[\d,]+\.\d{2})/gm,
      )) {
        if (seen.has(m[2]!)) continue;
        const amount = parseAmount(m[4]!);
        const minAmount = parseAmount(m[5]!);
        if (amount == null || minAmount == null) continue;
        seen.add(m[2]!);
        const bill = buildBill({
          bankName: '光大银行',
          cardLast4: m[2]!,
          holderName,
          amount,
          minAmount,
          currency,
          statementDate,
          dueDate,
        });
        if (bill) bills.push(bill);
      }
      const transactions = parseCeb2016Transactions(text, currency);
      for (const bill of bills.filter((candidate) => candidate.currency === currency)) {
        const own = transactions.filter((transaction) => transaction.cardLast4 === bill.cardLast4);
        if (own.length > 0) bill.transactions = own;
      }
    }
    return mergeAccountBillsByCurrency(bills);
  },
};

function parseCeb2016Transactions(text: string, currency: 'CNY' | 'USD'): ParsedTransaction[] {
  const marker = currency === 'CNY' ? '人民币账户交易明细' : '美元账户交易明细';
  const start = text.indexOf(marker);
  if (start < 0) return [];
  const other = currency === 'CNY' ? text.indexOf('美元账户交易明细', start + marker.length) : -1;
  const section = text.slice(start, other > start ? other : text.length);
  const transactions: ParsedTransaction[] = [];
  for (const match of section.matchAll(
    /(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{4})\s+((?:(?!\d{4}\/\d{2}\/\d{2})[\s\S])+?)\s+(?:[（(]存入[）)])?(-?[\d,]+\.\d{2})/g,
  )) {
    const description = match[4]!.replace(/\s+/g, ' ').trim();
    const value = parseAmount(match[5]!);
    if (!description || value == null || /Closing/.test(description)) continue;
    transactions.push({
      date: match[1],
      description,
      amount: /[（(]存入[）)]/.test(match[0]) ? -value : value,
      currency,
      cardLast4: match[3],
    });
  }
  return transactions;
}
