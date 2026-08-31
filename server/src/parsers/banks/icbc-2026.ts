import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, cardTailLine, dateLine, flattenHtml, mailText, mergeAccountBillsByCurrency, normalizeCurrency, parseAmount, parseDate, pick, pickHolder } from '../_util';

/**
 * 工商银行信用卡对账单解析器
 * 实测邮件特征（webmaster@icbc.com.cn）：
 *   标题: 中国工商银行客户对账单(ICBC Peony Card Bank Statement)
 *   正文: 贷记卡到期还款日 2026年8月25日 / 对账单生成日 2026年07月31日
 *   标准版需还款明细: 7640(牡丹贷记卡) 人民币(本位币) 8,411.90/RMB 1,429.79/RMB 81,000.00/RMB（多卡多行）
 *   零账单版本期交易汇总: 1498 -3.50/RMB 3.50/RMB 0.00/RMB 0.00/RMB（上期余额/收入/支出/本期余额，无应还款字段）
 */
export const icbc2026Parser: BankParser = {
  id: 'icbc2026',
  bankName: '工商银行',
  senderPatterns: ['webmaster@icbc.com.cn'],
  subjectPatterns: [/工商银行.*对账单/, /ICBC.*Statement/i],
  businessRelationships: true,

  parse(mail: MailContext): ParsedBill[] {
    const text = [mailText(mail), mail.attachText ? flattenHtml(mail.attachText) : ''].filter(Boolean).join('\n');
    if (!text) return [];

    const dueRaw = pick(text, [/贷记卡到期还款日\s*(\d{4}年\d{1,2}月\d{1,2}日)/]);
    const stmtRaw = pick(text, [/对账单生成日\s*(\d{4}年\d{1,2}月\d{1,2}日)/]);
    const dueDate = dueRaw ? parseDate(dueRaw) : null;
    const statementDate = stmtRaw ? parseDate(stmtRaw) : null;
    if (!dueDate || !statementDate) return [];

    const holderName = pickHolder(text);
    const bills: ParsedBill[] = [];
    // 需还款明细：币种以金额后的三位代码为准，可同时出现多种外币。
    for (const m of text.matchAll(
      /(\d{4})\([^)]{0,20}\)\s*[^\n]{1,30}?\s*(-?[\d,]+\.\d{2})\/([A-Z]{3})\s*(-?[\d,]+\.\d{2})\/\3/g,
    )) {
      const amount = parseAmount(m[2]);
      const minAmount = parseAmount(m[4]);
      if (amount == null) continue;
      const bill = buildBill({
        bankName: '工商银行',
        cardLast4: m[1],
        holderName,
        amount,
        minAmount,
        currency: normalizeCurrency(m[3]),
        statementDate,
        dueDate,
      });
      if (bill) bills.push(bill);
    }
    // 零账单版兜底：本期交易汇总行（卡号后四位 上期余额 本期收入 本期支出 本期余额），本期余额即应还款额
    if (bills.length === 0) {
      for (const m of text.matchAll(
        /(\d{4})\s+(-?[\d,]+\.\d{2})\/([A-Z]{3})\s+(-?[\d,]+\.\d{2})\/\3\s+(-?[\d,]+\.\d{2})\/\3\s+(-?[\d,]+\.\d{2})\/\3/g,
      )) {
        const amount = parseAmount(m[6]);
        if (amount == null) continue;
        const bill = buildBill({
          bankName: '工商银行',
          cardLast4: m[1],
          holderName,
          amount,
          minAmount: amount > 0 ? amount : 0,
          currency: normalizeCurrency(m[3]),
          statementDate,
          dueDate,
        });
        if (bill) bills.push(bill);
      }
    }
    const mobileTails = new Set(
      [...text.matchAll(/尾号为\s*(\d{4})\s*的信用卡为[^\n]{0,30}?手机信用卡/g)].map((match) => match[1]!),
    );
    attachIcbcTransactions(text, bills, holderName, statementDate, dueDate, mobileTails);
    const merged = mergeAccountBillsByCurrency(bills);
    const allActualTails = Array.from(new Set([
      ...merged.map((bill) => bill.cardLast4),
      ...merged.flatMap((bill) => (bill.transactions ?? [])
        .map((transaction) => transaction.cardLast4)
        .filter((tail): tail is string => !!tail && !mobileTails.has(tail))),
    ]));
    for (const bill of merged) {
      const actualTails = [bill.cardLast4, ...allActualTails.filter((tail) => tail !== bill.cardLast4)];
      bill.cardLast4s = actualTails.length > 1 ? actualTails : undefined;
      bill.businessCards = {
        primaryCardLast4: bill.cardLast4,
        secondaryCardLast4s: actualTails.filter((tail) => tail !== bill.cardLast4),
        mobileCardLast4s: [...mobileTails],
      };
    }
    return merged;
  },
};

/**
 * 工行明细行组（分行单元格）：卡尾 / 交易日 / 记账日 / [类型] 描述... / 交易金额 / 记账金额
 * 记账金额带 (存入) 后缀 → 冲抵取负；带 (支出) 或无后缀 → 正。
 */
function attachIcbcTransactions(
  text: string,
  bills: ParsedBill[],
  holderName: string | null,
  statementDate: Date,
  dueDate: Date,
  mobileTails: Set<string>,
): void {
  const lines = text.split('\n').map((l) => l.trim());
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  let i = 0;
  let tail: string | null = null;
  let dates: string[] = [];
  let desc: string[] = [];
  const reset = () => {
    tail = null;
    dates = [];
    desc = [];
  };
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (tail === null) {
      const t = cardTailLine(l);
      if (t && lines[i + 1] && dateLine(lines[i + 1] ?? '') && lines[i + 2] && dateLine(lines[i + 2] ?? '')) {
        tail = t;
        i += 2;
        dates = [lines[i - 1] ?? '', lines[i] ?? ''];
      }
      continue;
    }
    const amt = l.match(/^(-?[\d,]+\.\d{2})\/([A-Z]{3})(?:\((存入|支出)\))?$/);
    if (amt) {
      // 首个金额行为交易金额，紧随的金额行（若有）为记账金额，取记账金额并按存入/支出定向
      let value = parseAmount(amt[1]);
      let currency = normalizeCurrency(amt[2]);
      let flag = amt[3];
      const originalAmount = value;
      const originalCurrency = currency;
      const next = lines[i + 1]?.match(/^(-?[\d,]+\.\d{2})\/([A-Z]{3})(?:\((存入|支出)\))?$/);
      if (next) {
        value = parseAmount(next[1]);
        currency = normalizeCurrency(next[2]);
        flag = next[3];
        i += 1;
      }
      if (value != null && desc.length > 0) {
        const rawTail = tail ?? undefined;
        const description = desc.join(' ');
        const accountLevel = /(?:年费|分期)/.test(description) && !mobileTails.has(rawTail ?? '');
        txns.push({
          date: dates[0] ?? null,
          description,
          amount: flag === '存入' ? -value : value,
          currency,
          originalAmount,
          originalCurrency,
          cardLast4: accountLevel ? undefined : rawTail,
          sourceCardLast4: rawTail,
        });
      }
      reset();
      continue;
    }
    desc.push(l);
  }
  const ownerByCurrency = new Map<string, ParsedBill>();
  for (const bill of bills) if (!ownerByCurrency.has(bill.currency)) ownerByCurrency.set(bill.currency, bill);
  for (const currency of new Set(txns.map((transaction) => normalizeCurrency(transaction.currency)))) {
    if (ownerByCurrency.has(currency)) continue;
    const fallback = bills[0];
    if (!fallback) continue;
    const bill = buildBill({
      bankName: '工商银行',
      cardLast4: fallback.cardLast4,
      holderName,
      amount: 0,
      minAmount: 0,
      currency,
      statementDate,
      dueDate,
    });
    if (bill) {
      bills.push(bill);
      ownerByCurrency.set(currency, bill);
    }
  }
  for (const [currency, bill] of ownerByCurrency) {
    const own = txns.filter((transaction) => normalizeCurrency(transaction.currency) === currency);
    const tails = Array.from(new Set([
      bill.cardLast4,
      ...own.map((transaction) => transaction.cardLast4).filter((tail): tail is string => !!tail),
    ]));
    bill.cardLast4s = tails;
    if (own.length > 0) bill.transactions = own;
  }
}
