import type { BankParser, MailContext, ParsedBill, ParsedTransaction } from '../types';
import { buildBill, mailText, parseAmount, parseDate, pickHolder } from '../_util';

/**
 * 农业银行金穗信用卡电子对账单解析器（2019-2025 旧版模板）
 * 旧邮件特征（e-statement@creditcard.abchina.com，注意现役域名为 .com.cn）：
 *   标题: 中国农业银行金穗信用卡电子对账单（与现役相同）
 *   正文为"标签与值分行堆叠"结构（现役为"中文 English 值"同行排布）：
 *     卡号
 *     625336******1170
 *     账单周期
 *     20241214-20250113          ← YYYYMMDD 无分隔符（现役为 2026/07/20 带斜杠）
 *     到期还款日
 *     20250207
 *     Card No. / Statement Cycle / Payment Due Date（英文标签堆在值之后）
 *     New Balance / Min.Payment / Credit Limit
 *     人民币(CNY)
 *     -709.46 / -97.23 / 50000.00   ← 应还/最低/额度三行连排
 *   2019-2022 邮件 text 为 GBK 解码乱码（中文标签全毁），但卡号行/日期行/金额行/
 *   英文标签行结构完整保留 → 本解析器仅用行结构 + 英文标签定位，乱码与正常邮件通吃。
 *   明细为堆叠块（现役为单行连续流）：TDate/PDate/卡尾(可缺)/摘要1-2行/交易金额/CNY/入账金额/CNY。
 */

/** 在 [from, to) 行范围内找第一个匹配的行索引，未找到返回 -1 */
function findLineIdx(lines: string[], re: RegExp, from: number, to: number): number {
  for (let i = Math.max(0, from); i < Math.min(lines.length, to); i++) {
    if (re.test(lines[i]!)) return i;
  }
  return -1;
}

/**
 * 旧版明细解析：堆叠块 TDate/PDate(YYYYMMDD)/卡尾(可缺，如账单分期交易)/摘要 1-2 行/
 * 交易金额/CNY/入账金额/CNY。入账金额"支出为-"，与现役同口径取相反数
 * （正=消费/费用入账，负=还款/返还冲抵）。摘要行 2019-2022 为乱码，原样保留。
 */
function parseAbc2019Transactions(text: string): Array<ParsedTransaction & { cardLast4?: string }> {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const txns: Array<ParsedTransaction & { cardLast4?: string }> = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\d{8}$/.test(lines[i]!) || !/^\d{8}$/.test(lines[i + 1]!)) continue;
    let j = i + 2;
    let cardLast4: string | undefined;
    if (/^\d{4}$/.test(lines[j] ?? '')) {
      cardLast4 = lines[j];
      j++;
    }
    // 摘要行最多 2 行（交易摘要 + 交易地点），遇金额行或日期行（异常块）停止
    const desc: string[] = [];
    while (
      j < lines.length &&
      desc.length < 2 &&
      !/^-?[\d,]+\.\d{2}\/CNY$/.test(lines[j]!) &&
      !/^\d{8}$/.test(lines[j]!)
    ) {
      desc.push(lines[j]!);
      j++;
    }
    const a1 = (lines[j] ?? '').match(/^-?[\d,]+\.\d{2}\/CNY$/);
    const a2 = (lines[j + 1] ?? '').match(/^(-?[\d,]+\.\d{2})\/CNY$/);
    if (desc.length === 0 || !a1 || !a2) continue;
    const posted = parseAmount(a2[1]!);
    if (posted == null) continue;
    txns.push({ date: lines[i], description: desc.join(' '), amount: -posted, cardLast4 });
    i = j + 1;
  }
  return txns;
}

export const abc2019Parser: BankParser = {
  id: 'abc2019',
  bankName: '农业银行',
  priority: 90,
  // 旧域名 @creditcard.abchina.com（无 .cn）；现役域名 @creditcard.abchina.com.cn 亦含此子串，
  // 现役解析器 priority 更高优先尝试，本解析器仅作旧模板降级兜底
  senderPatterns: ['@creditcard.abchina.com'],
  subjectPatterns: [/农业银行.*对账单/, /金穗信用卡.*账单/],

  parse(mail: MailContext): ParsedBill[] {
    const text = mailText(mail);
    if (!text) return [];
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    // 卡号行（整行 625336******1170；现役模板卡号与标签同行，不会被整行正则命中）
    const cardIdx = findLineIdx(lines, /^\d{6}\*{6}\d{4}$/, 0, lines.length);
    if (cardIdx < 0) return [];
    const cardM = lines[cardIdx]!.match(/^(\d{6})\*{6}(\d{4})$/)!;

    // 账单周期行（YYYYMMDD-YYYYMMDD，现役带斜杠不会命中），出账日取周期末
    const cycleIdx = findLineIdx(lines, /^\d{8}-\d{8}$/, cardIdx, cardIdx + 6);
    if (cycleIdx < 0) return [];
    const cycleM = lines[cycleIdx]!.match(/^(\d{8})-(\d{8})$/)!;
    const statementDate = parseDate(cycleM[2]!);
    if (!statementDate) return [];

    // 到期还款日行（YYYYMMDD）：周期行后第一个 8 位数字行（中间隔一行中文/乱码标签）
    const dueIdx = findLineIdx(lines, /^\d{8}$/, cycleIdx + 1, cycleIdx + 6);
    if (dueIdx < 0) return [];
    const dueDate = parseDate(lines[dueIdx]!);
    if (!dueDate) return [];

    // 金额区：New Balance 英文标签行后的金额行组（应还/最低/额度三连；
    // 账务明细区英文标签为 New Charge/Account Balance，不会误中）
    const nbIdx = findLineIdx(lines, /^New\s*Balance$/i, 0, lines.length);
    if (nbIdx < 0) return [];
    const amounts: number[] = [];
    for (let i = nbIdx + 1; i < lines.length && i <= nbIdx + 12; i++) {
      const v = parseAmount(lines[i]!);
      if (v == null) continue;
      amounts.push(v);
      if (amounts.length === 2) break;
    }
    if (amounts.length === 0) return [];

    const bill = buildBill({
      bankName: '农业银行',
      cardLast4: cardM[2]!,
      holderName: pickHolder(text),
      amount: amounts[0]!,
      minAmount: amounts.length >= 2 ? amounts[1]! : null,
      currency: 'CNY',
      statementDate,
      dueDate,
      cardNoFull: `${cardM[1]!}******${cardM[2]!}`,
    });
    if (!bill) return [];
    // 单卡账单：明细中无卡尾的行（如账单分期交易）归属账单头卡号
    const txns = parseAbc2019Transactions(text);
    if (txns.length > 0) {
      bill.transactions = txns.map((t) => ({ ...t, cardLast4: t.cardLast4 ?? cardM[2]! }));
      // 农行旧模板可能由抬头卡承接合并账单，但明细中出现另一张实体卡。
      // 承接卡保持抬头卡尾，其他真实卡尾加入套卡，供入库层建立 BillCard 与明细归属。
      let transactionTails = Array.from(new Set(bill.transactions.map((t) => t.cardLast4).filter((tail): tail is string => !!tail)));
      if (transactionTails.length > 1 || (transactionTails.length === 1 && transactionTails[0] !== cardM[2])) {
        transactionTails = transactionTails.filter((tail) => tail !== '0000');
      }
      const groupTails = Array.from(new Set([cardM[2]!, ...transactionTails]));
      if (groupTails.length > 1) bill.cardLast4s = groupTails;
    }
    return [bill];
  },
};
