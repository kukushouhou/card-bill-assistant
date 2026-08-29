import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, mailText, mergeAccountBillsByCurrency, parseAmount, parseDate } from '../_util';

/**
 * 光大银行信用卡电子账单旧版解析器（2019-2026 纯文本模板）
 * 与现役 ceb2026（HTML 标签与值同区，如"账单日 Statement Date 2026/08/12"）差异：
 * text 版标签与值分离，实测邮件（cebbank@cardcenter.cebbank.com，标题"光大信用卡电子账单（YYYY年MM月DD日）"）：
 *   摘要值行: "RMB Minimum Payment Due 2023/01/12 2023/01/31 ￥4,400.00 ￥3,156.46 ￥157.82"
 *             （账单日 到期还款日 信用额度 本期应还款额 本期最低还款额）
 *   卡行: "40625406****6605 532.24 532.24 26.61"（无卡名；余额可带"(存款)"前缀，可跨行断裂）
 *   明细: "2022/12/13 2022/12/13 6605 其他消费 财付通 我养你 GO 4.90"流式连排，
 *         金额带"(存入)"前缀为还款/冲抵（取负）
 */
export const ceb2019Parser: BankParser = {
  id: 'ceb2019',
  bankName: '光大银行',
  priority: 90,
  senderPatterns: ['@cardcenter.cebbank.com', '@cardservice.cebbank.com'],
  subjectPatterns: [/光大.*电子账单/, /光大.*电子对账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    // 摘要值行：账单日 到期还款日 信用额度 应还合计 最低合计（标签区尾 + 5 个值）。
    // 2026-06 起新版摘要无最低还款额标签（美元应还替代，尾值 $），兼容两种。
    const head = text.match(
      /(?:Minimum Payment Due|USD Statement Balance)\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+￥[\d,]+\.\d{2}\s+￥[\d,]+\.\d{2}(?:\s+[￥$][\d,]+\.\d{2})?/,
    );
    if (!head) return [];
    const statementDate = parseDate(head[1]!);
    const dueDate = parseDate(head[2]!);
    if (!statementDate || !dueDate) return [];

    const bills: ParsedBill[] = [];
    const seen = new Set<string>();
    // 卡行：卡号 余额[(存款)前缀] 应还款额 最低还款额。
    // 新版（2026-06 起）美元账户区块先于人民币出现且同卡重复，切片仅取人民币区块。
    let cardSection = text;
    const rmbIdx = text.indexOf('人民币账户');
    if (rmbIdx >= 0) {
      const detailIdx = text.indexOf('人民币账户交易明细', rmbIdx);
      cardSection = text.slice(rmbIdx, detailIdx > rmbIdx ? detailIdx : undefined);
    }
    for (const m of cardSection.matchAll(
      /(\d{8})\*{4}(\d{4})\s+(?:[（(]存款[）)]\s*)?(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/g,
    )) {
      if (seen.has(m[2]!)) continue;
      const amount = parseAmount(m[4]!);
      const minAmount = parseAmount(m[5]!);
      if (amount == null || minAmount == null) continue;
      seen.add(m[2]!);
      const bill = buildBill({
        bankName: '光大银行',
        cardLast4: m[2]!,
        holderName: pickCebHolder(text),
        amount,
        minAmount,
        currency: 'CNY',
        statementDate,
        dueDate,
        cardNoFull: `${m[1]}****${m[2]}`,
      });
      if (bill) bills.push(bill);
    }
    const usdIdx = text.indexOf('美元账户');
    if (usdIdx >= 0) {
      const usdEnd = rmbIdx > usdIdx ? rmbIdx : text.length;
      const usdSection = text.slice(usdIdx, usdEnd);
      for (const m of usdSection.matchAll(
        /(\d{8})\*{4}(\d{4})\s+(?:[（(]存款[）)]\s*)?(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/g,
      )) {
        const amount = parseAmount(m[4]!);
        const minAmount = parseAmount(m[5]!);
        if (amount == null || minAmount == null) continue;
        const bill = buildBill({
          bankName: '光大银行',
          cardLast4: m[2]!,
          holderName: pickCebHolder(text),
          amount,
          minAmount,
          currency: 'USD',
          statementDate,
          dueDate,
          cardNoFull: `${m[1]}****${m[2]}`,
        });
        if (bill) bills.push(bill);
      }
    }
    if (bills.length === 0) return [];
    attachCeb2019Transactions(text, bills);
    return mergeAccountBillsByCurrency(bills);
  },
};

/** 光大 text 版抬头"张三  先生（收）"提取持卡人 */
function pickCebHolder(text: string): string | null {
  const m = text.match(/^([\u4e00-\u9fa5·]{2,10})\s*(?:先生|女士)?\s*[（(]收[）)]/m);
  return m ? m[1]! : null;
}

/**
 * 光大 text 版明细（流式连排）："交易日 记账日 卡尾 描述 金额"，可跨行断裂。
 * 描述用"未消化日期"的温和通配（允许跨行、不吞下一笔的日期），金额带"(存入)"前缀取负。
 */
function attachCeb2019Transactions(text: string, bills: ParsedBill[]): void {
  const rmbIdx = text.indexOf('人民币账户');
  const usdIdx = text.indexOf('美元账户');
  const sections = [
    ...(usdIdx >= 0 ? [{ currency: 'USD', text: text.slice(usdIdx, rmbIdx > usdIdx ? rmbIdx : text.length) }] : []),
    { currency: 'CNY', text: rmbIdx >= 0 ? text.slice(rmbIdx) : text },
  ];
  for (const section of sections) {
    const byTail = new Map<string, ParsedTransaction[]>();
    for (const m of section.text.matchAll(
      /(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{4})\s+((?:(?!\d{4}\/\d{2}\/\d{2})[\s\S])+?)\s+(?:[（(]存入[）)])?(-?[\d,]+\.\d{2})/g,
    )) {
      const desc = m[4]!.replace(/\s+/g, ' ').trim();
      if (!desc || /Closing/.test(desc)) continue;
      const value = parseAmount(m[5]!);
      if (value == null) continue;
      const list = byTail.get(m[3]!) ?? [];
      list.push({
        date: m[1],
        description: desc,
        amount: /[（(]存入[）)]/.test(m[0]) ? -value : value,
        currency: section.currency,
        cardLast4: m[3],
      });
      byTail.set(m[3]!, list);
    }
    for (const bill of bills.filter((candidate) => candidate.currency === section.currency)) {
      const transactions = byTail.get(bill.cardLast4);
      if (transactions?.length) bill.transactions = transactions;
    }
  }
}
