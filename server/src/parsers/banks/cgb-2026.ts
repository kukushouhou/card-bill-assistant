import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, mailText, normalizeCurrency, parseAmount, parseDate, pickHolder } from '../_util';

/**
 * 广发银行信用卡电子账单解析器（多卡表格，每行一张卡）
 * 实测邮件特征（creditcard@cgbchina.com.cn）：
 *   标题: 广发信用卡 2026年07月电子账单 / 广发信用卡2025年05月个人补寄对账单（账单在 PDF 附件）
 *   正文: 账单周期:2026/06/27-2026/07/26 账单日:2026/07/26
 *         卡号末四位 本期账单金额 最低还款额 最后还款日 入账货币 存款 卡片消费额度
 *         1119（6736附）/ 3,810.78 191.00 2026/08/15 人民币 0.00 97,000.00（多行，"无欠款"行跳过）
 *   旧版变体（2023 text 版）: "当期账单周期：2023/06/27至2023/07/26"（全角冒号 + "至"分隔），
 *         明细区多笔连排混行（"卡号：6225********2620 2023/07/24 2023/07/24 刷卡次数免年费 RMB: 80.00 ..."）
 *   补寄对账单（2025/2026）: 正文仅告知语无金额，账单全部在 PDF 附件（pdfText），
 *         "账单周期 2025/04/27 - 2025/05/26"（无冒号、" - "分隔）、附卡标记"6736 附"带空格、
 *         明细每行完整（"2025/05/26 2025/05/26 (消费)xxx 285.00 人民币 285.00 人民币"）
 */
export const cgb2026Parser: BankParser = {
  id: 'cgb2026',
  bankName: '广发银行',
  senderPatterns: ['@cgbchina.com.cn'],
  subjectPatterns: [/广发.*电子账单/, /广发信用卡.*账单/],

  parse(mail: MailContext): ParsedBill[] {
    // 补寄对账单正文无金额，账单在 PDF 附件：正文与 pdfText 拼接后统一解析（正文周期行优先命中）
    const text = [mailText(mail), mail.pdfText].filter(Boolean).join('\n');
    if (!text) return [];

    // 账单周期三种写法：半角冒号"-"紧连 / 全角冒号"至" / PDF" - "松散
    const cycle = text.match(/账单周期[：:]?\s*(\d{4}\/\d{2}\/\d{2})\s*(?:-|至)\s*(\d{4}\/\d{2}\/\d{2})/);
    const statementDate = cycle ? parseDate(cycle[2]!) : null;
    if (!statementDate) return [];

    const holderName = pickHolder(text);
    const bills: ParsedBill[] = [];
    // 卡行：卡号(可带附属卡标记"6736附"/"6736 附") 本期账单金额 最低还款额 最后还款日 入账货币
    const memberTails = new Map<ParsedBill, string[]>();
    for (const m of text.matchAll(
      /(\d{4})(?:\s*[（(]?\s*(\d{4})\s*附\s*[）)]?)?\s+([\d,]+\.\d{2}|无欠款)\s+([\d,]+\.\d{2}|无欠款)\s+(\d{4}\/\d{2}\/\d{2})\s+(人民币|美元)/g,
    )) {
      const amount = m[3] === '无欠款' ? 0 : parseAmount(m[3]!);
      const minAmount = m[4] === '无欠款' ? 0 : parseAmount(m[4]!);
      const dueDate = parseDate(m[5]!);
      if (amount == null || minAmount == null || !dueDate) continue;
      const bill = buildBill({
        bankName: '广发银行',
        cardLast4: m[1]!,
        holderName,
        amount,
        minAmount,
        currency: normalizeCurrency(m[6]),
        statementDate,
        dueDate,
      });
      if (bill) {
        bills.push(bill);
        memberTails.set(bill, [m[1]!, ...(m[2] ? [m[2]] : [])]);
      }
    }
    // 明细区按 "卡号：6225********2620"（可带"（附属卡）"尾巴）切块归属，交易行流式匹配：
    // "2026/07/24 2026/07/24 刷卡次数免年费 RMB: 200.00 0.00 人民币 0.00 人民币"（现役/PDF 双币种）
    // "2023/07/16 2023/07/16 (费用)逾期还款违约金 ... 20.00 人民币 20.00"（2023 text 版单币种），
    // 取入账金额；末尾币种可选以兼容两种排版
    const byTail = new Map<string, ParsedTransaction[]>();
    const heads = [...text.matchAll(/卡号：\d{4}\*{6,}(\d{4})/g)];
    for (let i = 0; i < heads.length; i++) {
      const tail = heads[i]![1]!;
      const seg = text.slice((heads[i]!.index ?? 0) + heads[i]![0].length, heads[i + 1]?.index ?? text.length);
      const list = byTail.get(tail) ?? [];
      for (const m of seg.matchAll(
        /(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(.+?)\s+(?:RMB:\s*[\d,.]+\s+)?(-?[\d,]+\.\d{2})\s+(人民币|美元)\s+(-?[\d,]+\.\d{2})(?:\s+(人民币|美元))?/g,
      )) {
        const value = parseAmount(m[6]!);
        const originalValue = parseAmount(m[4]!);
        if (value == null) continue;
        list.push({
          date: m[1],
          description: m[3]!.trim(),
          amount: value,
          currency: normalizeCurrency(m[7] ?? m[5]),
          originalAmount: originalValue,
          originalCurrency: normalizeCurrency(m[5]),
          cardLast4: tail,
        });
      }
      if (list.length > 0) byTail.set(tail, list);
    }
    for (const bill of bills) {
      const tails = memberTails.get(bill) ?? [bill.cardLast4];
      bill.cardLast4s = tails;
      const own = tails.flatMap((tail) => byTail.get(tail) ?? [])
        .filter((transaction) => normalizeCurrency(transaction.currency) === bill.currency);
      if (own.length > 0) bill.transactions = own;
    }
    return bills;
  },
};
