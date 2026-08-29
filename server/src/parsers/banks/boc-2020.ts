import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { attachTransactions, buildBill, mailText, parseAmount, parseDate, pick } from '../_util';

/**
 * 中行旧版明细（2020-2021 正文 HTML）：行组 交易日/记账日/卡尾/摘要/[存入|空]/[空|支出]。
 * 存入/支出两列在拍平后仅剩"摘要与金额之间的空行数"可区分：
 * 隔 1 个空行 = 存入列（还款/退款，记负）；隔 ≥2 个空行 = 支出列（消费，记正）。
 * 实测 2021 样本：7557 卡存入 20.00+286.42+436.00=742.42、3798 卡存入 3,271.56+0.98=3,272.54，
 * 均与各卡"本期存入金额"汇总精确一致。
 * 无卡尾行（存款利息等账户级调整）跳过；他卡转账还款的卡尾（借记卡尾号）无对应账单自然丢弃。
 */
function parseHtmlTransactions(text: string): Array<ParsedTransaction & { cardLast4?: string }> {
  const lines = text.split('\n').map((l) => l.trim()); // 保留空行以判存入/支出列
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  for (let i = 0; i + 8 < lines.length; i++) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lines[i] ?? '')) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lines[i + 2] ?? '')) continue;
    const tail = lines[i + 4] ?? '';
    const desc = lines[i + 6] ?? '';
    if (!/^\d{4}$/.test(tail) || !desc) continue;
    // 摘要行后第一个非空行应为金额；与摘要间隔 1 空行 = 存入列，≥2 空行 = 支出列
    let j = i + 7;
    while (j < lines.length && (lines[j] ?? '') === '') j++;
    const amtM = (lines[j] ?? '').match(/^(-?[\d,]+\.\d{2})$/);
    if (!amtM) continue;
    const value = parseAmount(amtM[1]);
    if (value == null) continue;
    const isDeposit = j - (i + 7) <= 1;
    txns.push({ date: lines[i], description: desc, amount: isDeposit ? -value : value, cardLast4: tail });
    i = j;
  }
  return txns;
}

/**
 * 中行 2022 版 PDF（中文可读，与 2026 乱码 PDF 结构不同）：
 *   摘要: "2022-01-24 2022-01-04 欠款 RMB 3,828.88 RMB 383.00"（还款日 账单日 应还 最低）
 *   卡号: "信用卡卡号/Credit Card No. 4096 **** **** 0289"（单卡副卡账单）
 *   明细: "12/31 01/01 0289" 日期行 + 描述行 + 行尾金额行（"商户 CHN 1,887.94"，描述可跨行）
 */
function parsePdf2022(pdfText: string): ParsedBill[] {
  const summary = pdfText.match(
    /(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+欠款\s*RMB\s*(-?[\d,]+\.\d{2})\s+RMB\s*(-?[\d,]+\.\d{2})/,
  );
  const cardM = pdfText.match(/Credit Card No\.\s*(\d{4})\s*\*{4}\s*\*{4}\s*(\d{4})/);
  if (!summary || !cardM) return [];
  const dueDate = parseDate(summary[1]);
  const statementDate = parseDate(summary[2]);
  const amount = parseAmount(summary[3]);
  const minAmount = parseAmount(summary[4]);
  if (!dueDate || !statementDate || amount == null || minAmount == null) return [];

  const bill = buildBill({
    bankName: '中国银行',
    cardLast4: cardM[2],
    holderName: pick(pdfText, [/客户姓名\/Customer Name\s*([\u4e00-\u9fa5·]{2,4})\s*先生/]),
    amount,
    minAmount,
    currency: 'CNY',
    statementDate,
    dueDate,
    cardNoFull: `${cardM[1]}********${cardM[2]}`,
  });
  if (!bill) return [];

  const lines = pdfText.split('\n').map((l) => l.trim()).filter(Boolean);
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const head = (lines[i] ?? '').match(/^(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(\d{4})$/);
    if (!head) continue;
    const desc: string[] = [];
    let amount: number | null = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      // 遇到下一笔的日期头行仍未见金额 → 放弃当前残缺交易
      if (/^\d{2}\/\d{2}\s+\d{2}\/\d{2}\s+\d{4}$/.test(lines[j] ?? '')) break;
      const am = (lines[j] ?? '').match(/^(.*?)(?:CHN|HN|N)?\s*(-?[\d,]+\.\d{2})$/);
      if (am) {
        amount = parseAmount(am[2]);
        // 金额行前缀含中文/字母的并入描述（如 "商户 CHN 1,887.94"），纯符号前缀（"/ /"）丢弃
        if (am[1] && /[\u4e00-\u9fa5A-Za-z]/.test(am[1])) desc.push(am[1].trim());
        break;
      }
      desc.push(lines[j] ?? '');
    }
    if (amount == null || desc.length === 0) continue;
    txns.push({ date: head[1], description: desc.join(' ').trim(), amount, cardLast4: head[3] });
    i = j;
  }
  if (txns.length > 0) bill.transactions = txns;
  return [bill];
}

/**
 * 中国银行信用卡电子账单解析器（2020-2022 旧模板）
 * 2020（PersonalService@bank-of-china.com "中国银行银行卡电子账单"）与
 * 2021（boczhangdan@bankofchina.com）账单在正文 HTML：
 *   摘要: 到期还款日 Due Date 账单日 Statement Date 本期人民币欠款总计 …
 *         值序列 "2020-08-24 2020-08-04 10,949.22"（还款日 账单日 人民币总计）
 *   卡表: 62590943****2010 / 6,240.92 / 625.00（前8位+****+末4位、应还、最低，多卡多行）
 * 2022 账单在 PDF 附件（中文可读，见 parsePdf2022）。
 * 2026 版为乱码 PDF（Current FCY Total 标签 + 空格分列卡表），结构不同由主解析器处理。
 */
export const boc2020Parser: BankParser = {
  id: 'boc2020',
  bankName: '中国银行',
  priority: 90,
  senderPatterns: ['boczhangdan@bankofchina.com', 'PersonalService@bank-of-china.com'],
  subjectPatterns: [/中国银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    // 2022：账单在 PDF 附件（中文可读版）
    if (mail.pdfText) {
      const pdfBills = parsePdf2022(mail.pdfText);
      if (pdfBills.length > 0) return pdfBills;
    }

    // 2020-2021：账单在正文 HTML
    const text = mailText(mail);
    if (!text) return [];
    const summary = text.match(
      /Due Date\s*[\s\S]{0,400}?(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(-?[\d,]+\.\d{2})/,
    );
    if (!summary) return [];
    const dueDate = parseDate(summary[1]);
    const statementDate = parseDate(summary[2]);
    if (!dueDate || !statementDate) return [];

    const holderName = pick(text, [/([\u4e00-\u9fa5·]{2,4})\s*\n?\s*先生/]);
    const bills: ParsedBill[] = [];
    for (const m of text.matchAll(/(\d{8})\*{4}(\d{4})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/g)) {
      const amount = parseAmount(m[3]);
      const minAmount = parseAmount(m[4]);
      if (amount == null || minAmount == null) continue;
      const bill = buildBill({
        bankName: '中国银行',
        cardLast4: m[2],
        holderName,
        amount,
        minAmount,
        currency: 'CNY',
        statementDate,
        dueDate,
        cardNoFull: `${m[1]}******${m[2]}`,
      });
      if (bill) bills.push(bill);
    }
    attachTransactions(bills, parseHtmlTransactions(text));
    return bills;
  },
};
