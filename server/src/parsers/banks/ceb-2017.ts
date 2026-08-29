import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, mergeAccountBillsByCurrency, parseAmount, parseDate } from '../_util';

/**
 * 光大银行信用卡电子对账单解析器（2017 PDF 附件模板）
 * 与 ceb2019（正文 text 版）/ceb2016（正文 HTML 版）差异：账单在 PDF 附件中，
 * 正文仅一段通知信（无账单数据）。
 * 实测邮件（cebbank@cardcenter.cebbank.com，标题"光大银行信用卡电子对账单20170112"）：
 *   PDF: 账单日 Statement Date 2017-01-12 / 到期还款日 Payment Due Date 2017-01-31
 *        人民币本期应还款额 RMB Statement Balance ￥982.65
 *        卡号: 账号 Account Number : 46242700****7872 京东白条卡
 *        最低还款额在人民币明细区块尾部: 本期最低还款额 Minimum Payment Due 49.13
 *        明细流式连排: 2016/12/17 2016/12/17 7872 网上支付 京东支付 21.90
 */
export const ceb2017Parser: BankParser = {
  id: 'ceb2017',
  bankName: '光大银行',
  priority: 85,
  senderPatterns: ['@cardcenter.cebbank.com', '@cardservice.cebbank.com'],
  subjectPatterns: [/光大.*电子账单/, /光大.*电子对账单/],

  parse(mail: MailContext): ParsedBill[] {
    if (!mail.pdfText) return [];
    const pdf = mail.pdfText;

    const stmtRaw = pdf.match(/账单日\s*\n?\s*Statement Date\s+(\d{4}-\d{2}-\d{2})/)?.[1];
    const dueRaw = pdf.match(/到期还款日\s*\n?\s*Payment Due Date\s+(\d{4}-\d{2}-\d{2})/)?.[1];
    const amtRaw = pdf.match(/RMB Statement Balance\s+￥(-?[\d,]+\.\d{2})/)?.[1];
    // 最低还款额在人民币明细区块尾部（首个匹配即人民币区块，美元区块在后）
    const minRaw = pdf.match(/Minimum Payment Due\s+(-?[\d,]+\.\d{2})/)?.[1];
    if (!stmtRaw || !dueRaw || amtRaw == null) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amtRaw);
    const minAmount = minRaw != null ? parseAmount(minRaw) : null;
    if (!statementDate || !dueDate || amount == null) return [];

    // 卡号：人民币区块先于美元区块出现（同卡重复），取首个
    const cardM = pdf.match(/Account Number\s*:?\s*(\d{8})\*{4}(\d{4})/);
    if (!cardM) return [];

    const bill = buildBill({
      bankName: '光大银行',
      cardLast4: cardM[2]!,
      holderName: pdf.match(/^([\u4e00-\u9fa5·]{2,10})\s*(?:先生|女士)?\s*[（(]收[）)]/m)?.[1] ?? null,
      amount,
      minAmount,
      currency: 'CNY',
      statementDate,
      dueDate,
      cardNoFull: `${cardM[1]}****${cardM[2]}`,
    });
    if (!bill) return [];
    const bills = [bill];
    const usdAmountRaw = pdf.match(/USD Statement Balance\s+\$?(-?[\d,]+\.\d{2})/)?.[1];
    const usdIdx = pdf.indexOf('美元账户');
    if (usdAmountRaw != null && usdIdx >= 0) {
      const usdSection = pdf.slice(usdIdx);
      const usdCard = usdSection.match(/Account Number\s*:?\s*(\d{8})\*{4}(\d{4})/) ?? cardM;
      const usdMinRaw = usdSection.match(/Minimum Payment Due\s+(-?[\d,]+\.\d{2})/)?.[1];
      const usdBill = buildBill({
        bankName: '光大银行',
        cardLast4: usdCard[2]!,
        holderName: bill.holderName,
        amount: parseAmount(usdAmountRaw) ?? 0,
        minAmount: usdMinRaw == null ? 0 : parseAmount(usdMinRaw),
        currency: 'USD',
        statementDate,
        dueDate,
        cardNoFull: `${usdCard[1]}****${usdCard[2]}`,
      });
      if (usdBill) bills.push(usdBill);
    }
    for (const candidate of bills) {
      const transactions = parseCeb2017Transactions(pdf, candidate.currency as 'CNY' | 'USD')
        .filter((transaction) => transaction.cardLast4 === candidate.cardLast4);
      if (transactions.length > 0) candidate.transactions = transactions;
    }
    return mergeAccountBillsByCurrency(bills);
  },
};

/**
 * 光大 2017 PDF 明细（流式连排，同 ceb2019 格式）："交易日 记账日 卡尾 描述 金额"。
 * 仅取人民币区块（切片到美元账户），金额带"(存入)"前缀为还款/冲抵（取负）。
 */
function parseCeb2017Transactions(pdf: string, currency: 'CNY' | 'USD'): Array<ParsedTransaction & { cardLast4?: string }> {
  const usdIdx = pdf.indexOf('美元账户');
  const section = currency === 'USD'
    ? usdIdx >= 0 ? pdf.slice(usdIdx) : ''
    : usdIdx > 0 ? pdf.slice(0, usdIdx) : pdf;
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  for (const m of section.matchAll(
    /(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{4})\s+((?:(?!\d{4}\/\d{2}\/\d{2})[\s\S])+?)\s+(?:[（(]存入[）)])?(-?[\d,]+\.\d{2})/g,
  )) {
    const desc = m[4]!.replace(/\s+/g, ' ').trim();
    if (!desc || /Closing/.test(desc)) continue;
    const value = parseAmount(m[5]!);
    if (value == null) continue;
    txns.push({
      date: m[1],
      description: desc,
      amount: /[（(]存入[）)]/.test(m[0]) ? -value : value,
      currency,
      cardLast4: m[3],
    });
  }
  return txns;
}
