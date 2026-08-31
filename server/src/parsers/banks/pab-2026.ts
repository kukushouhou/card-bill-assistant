import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { applyTransactionTails, buildBill, dateLine, mailText, parseAmount, parseDate, pick, pickHolder, propagateAccountBillTails, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 平安银行信用卡电子账单解析器（2021 起账户级账单模板）
 * 实测邮件特征（creditcard@service.pingan.com，2021-2026 同构）：
 *   标题: 平安白金/平安信用卡电子账单
 *   正文: 本期应还金额 ￥ 1,756.01 $ 0.00（币种符号与金额分行，2021 版 ￥ 与金额也分行）
 *         本期最低应还金额 ￥ 732.79 $ 0.00
 *         本期账单日 2026-08-18 / 本期还款日 2026-09-06
 *   明细区（"人民币账户交易明细" 起）按卡分区块：
 *     "平安银行京喜白金联名信用卡（1765）"（卡尾全角括号；好车主卡（金卡）（8837）为嵌套括号）
 *     "主卡 Main Card" / "附卡 Sup Card 附卡人：XXX"
 *     "合计：￥ x" 后跟 4 行组：日期/日期/交易说明/￥金额
 *     "分期 Installment" / "其他 Other" 区块无卡号（账户级）→ 解析阶段卡号留空，合账再挂优先显示卡
 *   卡尾从卡区块头提取，多卡为合并账单（applyTransactionTails）。
 */
export const pab2026Parser: BankParser = {
  id: 'pab2026',
  bankName: '平安银行',
  senderPatterns: ['creditcard@service.pingan.com'],
  subjectPatterns: [/平安.*电子账单/],
  businessRelationships: true,

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const stmtRaw = pick(text, [/本期账单日\s*(\d{4}-\d{2}-\d{2})/]);
    const dueRaw = pick(text, [/本期还款日\s*(\d{4}-\d{2}-\d{2})/]);
    const amounts = text.match(/本期应还金额\s*￥\s*(-?[\d,]+\.\d{2})\s*\$\s*(-?[\d,]+\.\d{2})/);
    const minimums = text.match(/本期最低应还金额\s*￥\s*(-?[\d,]+\.\d{2})\s*\$\s*(-?[\d,]+\.\d{2})/);
    const cnyMinimum = minimums?.[1]
      ?? pick(text, [/本期最低应还金额\s*￥\s*(-?[\d,]+\.\d{2})/]);
    if (!stmtRaw || !dueRaw || !amounts) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amounts[1]);
    if (!statementDate || !dueDate || amount == null) return [];

    const bill = buildBill({
      bankName: '平安银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount,
      minAmount: cnyMinimum ? parseAmount(cnyMinimum) : null,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];
    const usdBill = buildBill({
      bankName: '平安银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount: parseAmount(amounts[2]) ?? 0,
      minAmount: minimums ? parseAmount(minimums[2]) : 0,
      currency: 'USD',
      statementDate,
      dueDate,
    });

    // 明细区按卡区块归属：卡头行切卡；分期/其他账户级区块卡号留空（合账再挂优先显示卡）
    const sectionStart = text.indexOf('人民币账户交易明细');
    const txns: ParsedTransaction[] = [];
    const holderMap: Record<string, string> = {};
    const primaryTails: string[] = [];
    const primaryByProduct = new Map<string, string>();
    const supplementary = new Map<string, { holderName: string | null; primaryCardLast4: string | null }>();
    if (sectionStart >= 0) {
      const lines = text.slice(sectionStart).split('\n').map((l) => l.trim()).filter(Boolean);
      let currentTail: string | null = null;
      let currentProduct = '';
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // 卡区块头："平安银行……信用卡……（1765）"，嵌套括号（金卡）（8837）取末尾括号
        const headM = line.match(/^(平安银行.*)[（(](\d{4})[）)]$/);
        if (headM) {
          currentTail = headM[2] ?? null;
          currentProduct = (headM[1] ?? '').replace(/\s+/g, '');
          continue;
        }
        if (/^主卡/.test(line)) {
          if (currentTail) {
            if (!primaryTails.includes(currentTail)) primaryTails.push(currentTail);
            if (currentProduct) primaryByProduct.set(currentProduct, currentTail);
          }
          continue;
        }
        // 附卡区块：「附卡 Sup Card 附卡人：XXX」——仅区块写明时入映射，不得用抬头覆盖
        const suppM = line.match(/^附卡.*附卡人[：:]\s*([\u4e00-\u9fa5·]{2,10})/);
        if (suppM && currentTail) {
          holderMap[currentTail] = suppM[1]!;
          supplementary.set(currentTail, {
            holderName: suppM[1]!,
            primaryCardLast4: primaryByProduct.get(currentProduct) ?? null,
          });
          continue;
        }
        if (/^附卡/.test(line) && currentTail) {
          supplementary.set(currentTail, {
            holderName: null,
            primaryCardLast4: primaryByProduct.get(currentProduct) ?? null,
          });
          continue;
        }
        // 账户级区块（分期/其他）：解析阶段卡号留空
        if (/^(分期|其他)/.test(line)) {
          currentTail = null;
          continue;
        }
        // 4 行组交易：日期/日期/交易说明/￥金额
        const d1 = dateLine(line);
        const d2 = d1 ? dateLine(lines[i + 1] ?? '') : null;
        if (!d1 || !d2 || !/^\d{4}-\d{2}-\d{2}$/.test(d1)) continue;
        const desc = lines[i + 2] ?? '';
        const amountM = (lines[i + 3] ?? '').match(/^￥\s*(-?[\d,]+\.\d{2})$/);
        const value = amountM ? parseAmount(amountM[1]) : null;
        if (!desc || value == null) continue;
        txns.push({ date: d1, description: desc, amount: value, currency: 'CNY', cardLast4: currentTail });
        i += 3;
      }
    }
    applyTransactionTails(bill, txns);
    if (primaryTails.length > 0) {
      const primaryTail = primaryTails.includes(bill.cardLast4) ? bill.cardLast4 : primaryTails[0]!;
      const actualTails = Array.from(new Set([
        ...primaryTails,
        ...(bill.cardLast4s ?? []),
        ...supplementary.keys(),
      ]));
      bill.cardLast4 = primaryTail;
      bill.cardLast4s = actualTails.length > 1 ? actualTails : undefined;
      bill.businessCards = {
        primaryCardLast4: primaryTail,
        ...(primaryTails.length > 1
          ? { additionalPrimaryCardLast4s: primaryTails.filter((tail) => tail !== primaryTail) }
          : {}),
        supplementaryCards: [...supplementary].map(([cardLast4, relation]) => ({
          cardLast4,
          holderName: relation.holderName,
          ...(relation.primaryCardLast4 ? { primaryCardLast4: relation.primaryCardLast4 } : {}),
        })),
      };
    }
    if (Object.keys(holderMap).length > 0) bill.holderMap = holderMap;
    const bills = usdBill ? [bill, usdBill] : [bill];
    propagateAccountBillTails(bills);
    if (bill.businessCards) {
      for (const accountBill of bills) accountBill.businessCards = bill.businessCards;
    }
    return bills;
  },
};
