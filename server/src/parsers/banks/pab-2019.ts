import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { applyTransactionTails, buildBill, dateLine, mailText, parseAmount, parseDate, pick, pickHolder, propagateAccountBillTails, UNKNOWN_CARD_TAIL } from '../_util';

/**
 * 平安银行信用卡电子账单解析器（2019-2020 旧模板）
 * 实测邮件特征（creditcard@service.pingan.com）：
 *   标题: 平安白金信用卡电子账单
 *   正文: 本期账单日 2019-10-18 / 本期还款日 2019-11-06（字段名与 2026 版相同）
 *         本期应还金额 本期最低应还金额（两个标签先出现，金额在后且￥符号独立成行）：
 *         ￥6,762.83 $0.00 ￥676.28 $0.00（应还/外币/最低/外币 4 值连续）
 *   明细：卡区块头 "平安腾讯视频VIP信用卡金卡********4856 合计金额：￥6,874.00"（含卡尾），
 *         行组 日期/日期/交易说明/￥/金额（￥ 与金额分行，2026 版为同行）。
 * 卡尾取明细区块头（4856）；"其他 Other" 区块解析阶段卡号留空，合账再挂优先显示卡。
 */
export const pab2019Parser: BankParser = {
  id: 'pab2019',
  bankName: '平安银行',
  priority: 90,
  senderPatterns: ['creditcard@service.pingan.com'],
  subjectPatterns: [/平安.*电子账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];

    const stmtRaw = pick(text, [/本期账单日\s*(\d{4}-\d{2}-\d{2})/]);
    const dueRaw = pick(text, [/本期还款日\s*(\d{4}-\d{2}-\d{2})/]);
    if (!stmtRaw || !dueRaw) return [];
    // 金额 4 值连续序列：￥应还 $外币 ￥最低 $外币（信用额度/账务说明区无 $ 不会误匹配）
    const amtM = text.match(/￥\s*(-?[\d,]+\.\d{2})\s*\$\s*(-?[\d,]+\.\d{2})\s*￥\s*(-?[\d,]+\.\d{2})\s*\$\s*(-?[\d,]+\.\d{2})/);
    if (!amtM) return [];

    const statementDate = parseDate(stmtRaw);
    const dueDate = parseDate(dueRaw);
    const amount = parseAmount(amtM[1]);
    const minAmount = parseAmount(amtM[3]);
    if (!statementDate || !dueDate || amount == null || minAmount == null) return [];

    const bill = buildBill({
      bankName: '平安银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount,
      minAmount,
      currency: 'CNY',
      statementDate,
      dueDate,
    });
    if (!bill) return [];
    const usdBill = buildBill({
      bankName: '平安银行',
      cardLast4: UNKNOWN_CARD_TAIL,
      holderName: pickHolder(text),
      amount: parseAmount(amtM[2]) ?? 0,
      minAmount: parseAmount(amtM[4]) ?? 0,
      currency: 'USD',
      statementDate,
      dueDate,
    });

    // 卡尾：明细区块头 "平安……信用卡金卡********4856 合计金额：￥x"
    const tail = pick(text, [/信用卡[^\n*]*\*{4,}\s*(\d{4})\s*合计金额/]);
    const txns: ParsedTransaction[] = [];
    const sectionStart = text.indexOf('人民币账户交易明细');
    if (sectionStart >= 0) {
      const lines = text.slice(sectionStart).split('\n').map((l) => l.trim()).filter(Boolean);
      let currentTail: string | null = tail ?? null;
      for (let i = 0; i + 3 < lines.length; i++) {
        if (/^(分期|其他)/.test(lines[i] ?? '')) {
          currentTail = null;
          continue;
        }
        const d1 = dateLine(lines[i] ?? '');
        const d2 = d1 ? dateLine(lines[i + 1] ?? '') : null;
        if (!d1 || !d2 || !/^\d{4}-\d{2}-\d{2}$/.test(d1)) continue;
        const desc = lines[i + 2] ?? '';
        let value: number | null = null;
        let skip = 3;
        const inline = (lines[i + 3] ?? '').match(/^￥\s*(-?[\d,]+\.\d{2})$/);
        if (inline) {
          value = parseAmount(inline[1]);
        } else if ((lines[i + 3] ?? '') === '￥') {
          // 旧版：￥ 与金额分行
          const split = (lines[i + 4] ?? '').match(/^(-?[\d,]+\.\d{2})/);
          if (split) {
            value = parseAmount(split[1]);
            skip = 4;
          }
        }
        if (!desc || value == null) continue;
        txns.push({ date: d1, description: desc, amount: value, currency: 'CNY', cardLast4: currentTail });
        i += skip;
      }
    }
    applyTransactionTails(bill, txns);
    const bills = usdBill ? [bill, usdBill] : [bill];
    propagateAccountBillTails(bills);
    return bills;
  },
};
