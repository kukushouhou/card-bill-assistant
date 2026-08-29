import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { attachTransactions, buildBill, mailText, parseAmount, parseDate, pickHolder } from '../_util';
import { addDays } from '../../lib/dates';

/**
 * 中行 PDF 交易行金额提取：行尾金额可带 CHN/HN/N 币种国别碎片前缀。
 * 形如 '微信-xxxCHN 1085.00' / 'CHN 240.00' / 'HN 488.00' / 'N 0.50' / 'BOCNET 651.60'
 */
function bocLineAmount(l: string): { desc: string; amount: number } | null {
  const m = l.match(/^(.*?)\s*(?:CHN|HN|N)?\s*(-?[\d,]+\.\d{2})$/);
  if (!m) return null;
  const value = parseAmount(m[2]);
  if (value == null) return null;
  return { desc: (m[1] ?? '').trim(), amount: value };
}

/**
 * 中行 PDF 明细解析：按 '卡号：XXXX' 分节，节内解析 '交易日 记账日 卡尾 摘要...金额'（摘要与金额可跨行）。
 * 还款识别：PDF 中文为自定义字体编码（乱码），无法按描述区分借贷方向，
 * 用节内汇总行第 3 值（存入/还款合计）精确匹配 + BOCNET 渠道兜底 → 记负数。
 * 局限：多笔还款合计拆分、退货冲抵等场景符号可能不准；年费描述乱码无法检测。
 */
function parseBocTransactions(text: string): Array<ParsedTransaction & { cardLast4?: string }> {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const sectionStarts: Array<{ tail: string; idx: number }> = [];
  lines.forEach((l, idx) => {
    const m = l.match(/卡号：(\d{4})/);
    if (m) sectionStarts.push({ tail: m[1], idx });
  });
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  for (let s = 0; s < sectionStarts.length; s++) {
    const { tail } = sectionStarts[s]!;
    const from = sectionStarts[s]!.idx;
    const to = s + 1 < sectionStarts.length ? sectionStarts[s + 1]!.idx : lines.length;
    // 节内汇总行：'.../RMB .../DEBT 上期 消费 存入(还款)合计 [DEBT] 本期 可用'，第 3 值为还款合计
    let payments: number | null = null;
    for (let i = from; i < to; i++) {
      const sm = (lines[i] ?? '').match(/\/RMB\s+\S+\/DEBT\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/);
      if (sm) {
        payments = parseAmount(sm[3]);
        break;
      }
    }
    for (let i = from; i < to; i++) {
      const head = (lines[i] ?? '').match(/^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(\d{4})(.*)$/);
      if (!head) continue;
      const desc: string[] = [];
      let amount: number | null = null;
      const rest = (head[4] ?? '').trim();
      if (rest) {
        const am = bocLineAmount(rest);
        if (am) {
          amount = am.amount;
          if (am.desc) desc.push(am.desc);
        } else {
          desc.push(rest);
        }
      }
      let j = i + 1;
      while (amount == null && j < to && j <= i + 3 && !/^\d{4}-\d{2}-\d{2}\s/.test(lines[j] ?? '')) {
        const am = bocLineAmount(lines[j] ?? '');
        if (am) {
          amount = am.amount;
          if (am.desc) desc.push(am.desc);
          break;
        }
        if (lines[j]) desc.push(lines[j]);
        j++;
      }
      if (amount == null || desc.length === 0) continue;
      const description = desc.join(' ').trim();
      const isPayment = /BOCNET/i.test(description) || (payments != null && amount === payments);
      txns.push({ date: head[1], description, amount: isPayment ? -amount : amount, currency: 'CNY', cardLast4: tail });
      i = Math.max(i, j - 1);
    }
  }
  return txns;
}

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
    // 卡行：BIN 产品码 **** 末四位 人民币应还 最低还款
    for (const m of text.matchAll(/(\d{4})\s+(\d{4})\s*\*{4}\s*(\d{4})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/g)) {
      const amount = parseAmount(m[4]);
      const minAmount = parseAmount(m[5]);
      if (amount == null || minAmount == null) continue;
      const bill = buildBill({
        bankName: '中国银行',
        cardLast4: m[3],
        holderName,
        amount,
        minAmount,
        currency: 'CNY',
        statementDate,
        dueDate,
        cardNoFull: `${m[1]}${m[2]}******${m[3]}`,
      });
      if (bill) bills.push(bill);
    }
    attachTransactions(bills, parseBocTransactions(text));
    return bills;
  },
};
