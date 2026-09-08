import { bocPdfTransactions } from '../boc-pdf-rows';
import { htmlTransactions, attachStatementTransactions } from '../statement-rows';
import type { BankParser, MailContext, ParsedBill } from '../types';
import { buildBill, mailText, parseAmount, parseDate, pick } from '../_util';

/**
 * 中行 2022 版 PDF（中文可读，与 2026 乱码 PDF 结构不同）：
 *   摘要: "2022-01-24 2022-01-04 欠款 RMB 3,828.88 RMB 383.00"（还款日 账单日 应还 最低）
 *   卡号: "信用卡卡号/Credit Card No. 4096 **** **** 0289"（单卡副卡账单）
 *   明细: "12/31 01/01 0289" 日期行 + 描述行 + 行尾金额行（"商户 CHN 1,887.94"，描述可跨行）
 */
function parsePdf2022(pdfText: string, mail: MailContext): ParsedBill[] {
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

  const positioned = bocPdfTransactions(mail);
  if (positioned) attachStatementTransactions([bill], positioned);
  else if (/\d{2}\/\d{2}\s+\d{2}\/\d{2}\s+\d{4}/.test(pdfText)) throw new Error('中行 PDF 明细需要原附件的表格位置');
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
      const pdfBills = parsePdf2022(mail.pdfText, mail);
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
    const transactions = htmlTransactions(mail, 'boc');
    if (transactions) attachStatementTransactions(bills, transactions);
    else if (/\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}\s+\d{4}/.test(text)) {
      throw new Error('中行旧版交易明细需要原邮件的存入／支出表格列');
    }
    return bills;
  },
};
