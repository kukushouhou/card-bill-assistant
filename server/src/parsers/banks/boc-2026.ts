import { bocPdfTransactions } from '../boc-pdf-rows';
import { attachStatementTransactions } from '../statement-rows';
import type { BankParser, MailContext, ParsedBill } from '../types';
import { buildBill, mailText, parseAmount, parseDate, pickHolder } from '../_util';
import { addDays } from '../../lib/dates';

/**
 * 中国银行信用卡电子账单解析器（账单正文在 PDF 附件中，HTML 正文仅是送达通知）
 * 实测邮件特征（boczhangdan@bankofchina.com）：
 *   标题: 中国银行信用卡电子账单
 *   附件: 中国银行信用卡电子合并账单2026年08月账单.PDF（PDF 内中文字体为自定义编码会乱码，
 *         但数字/卡号/英文标签完好）
 *   PDF 摘要: Payment Due Date / Statement Closing Date / RMB Total 顺序输出值
 *             "2026-08-24 2026-08-04 5,534.55"（还款日 出账日 人民币总额）
 *   PDF 卡表: 6259 0611 **** 1831 2861.30 286.00（卡号/人民币应还/最低还款，多卡多行）
 */
export const boc2026Parser: BankParser = {
  id: 'boc2026',
  bankName: '中国银行',
  senderPatterns: ['boczhangdan@bankofchina.com'],
  subjectPatterns: [/中国银行.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mail.pdfText;
    if (!text) return [];

    // 摘要：FCY 总额标签后的三个值 = 还款日 出账日 人民币总额
    const summary = text.match(/Current FCY Total Balance Due\s*(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(-?[\d,]+\.\d{2})/);
    let dueDate: Date | null = null;
    let statementDate: Date | null = null;
    if (summary) {
      dueDate = parseDate(summary[1]!);
      statementDate = parseDate(summary[2]!);
    } else {
      // 零账单（"您本期无需还款"）：还款日值被银行省略，仅剩"账单日 人民币总额 0.00"
      // 还款日按实测规律推算 = 账单日 + 20 天（2020-08-04→08-24、2022-01-04→01-24），零欠款无逾期风险
      const zero = text.match(/Current FCY Total Balance Due\s*(\d{4}-\d{2}-\d{2})\s+(-?[\d,]+\.\d{2})/);
      if (zero) {
        statementDate = parseDate(zero[1]!);
        dueDate = statementDate ? addDays(statementDate, 20) : null;
      }
    }
    if (!dueDate || !statementDate) return [];

    const holderName = pickHolder(mailText(mail)); // PDF 持卡人中文乱码，从邮件 HTML 通知取（通常无姓名）
    const bills: ParsedBill[] = [];
    // 同一卡行可能同时给出人民币和外币；分别按币种收集应还／最低两列。
    for (const m of text.matchAll(/^(\d{4})\s+(\d{4})\s*\*{4}\s*(\d{4})\s+([^\n]+)$/gm)) {
      const byCurrency = new Map<string, number[]>();
      for (const field of m[4]!.matchAll(/(?:([A-Z]{3})\s+)?(-?[\d,]+\.\d{2})/g)) {
        const currency = field[1] === 'RMB' ? 'CNY' : field[1] ?? 'CNY';
        const values = byCurrency.get(currency) ?? [];
        const value = parseAmount(field[2]);
        if (value != null) values.push(value);
        byCurrency.set(currency, values);
      }
      for (const [currency, values] of byCurrency) {
        if (values.length !== 2) throw new Error('中行卡片应还与最低还款列不完整');
        const bill = buildBill({ bankName: '中国银行', cardLast4: m[3], holderName,
          amount: values[0]!, minAmount: values[1]!, currency, statementDate, dueDate,
          cardNoFull: m[1]! + m[2]! + '******' + m[3]! });
        if (bill) bills.push(bill);
      }
    }
    const transactions = bocPdfTransactions(mail);
    if (transactions) attachStatementTransactions(bills, transactions);
    else {
      // 仅文本调试输入无法提供借贷列，不再伪造方向。
      if (/\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}\s+\d{4}/.test(text)) throw new Error('中行 PDF 明细需要原附件的表格位置');
    }
    return bills;
  },
};
