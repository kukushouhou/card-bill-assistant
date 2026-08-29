/**
 * 各银行解析器共享的工具函数
 */
import type { MailContext, ParsedBill, ParsedTransaction } from './types';
import { dayOfMonthClamped, fromYmd, periodOf, shanghaiMidnight } from '../lib/dates';

/** 解析不到卡号时的档案占位（避免与真实卡号 0000 冲突） */
export const UNKNOWN_CARD_TAIL = '----';

/** 银行常见币种别名统一为 ISO 代码；未知三字母代码原样保留。 */
export function normalizeCurrency(raw?: string | null): string {
  const value = (raw ?? 'CNY').trim().toUpperCase();
  const aliases: Record<string, string> = {
    RMB: 'CNY',
    人民币: 'CNY',
    美元: 'USD',
    欧元: 'EUR',
    英镑: 'GBP',
    日元: 'JPY',
    港币: 'HKD',
    澳元: 'AUD',
    加拿大元: 'CAD',
    加元: 'CAD',
    新加坡元: 'SGD',
    瑞士法郎: 'CHF',
    新西兰元: 'NZD',
  };
  return aliases[value] ?? value;
}

/** 取邮件正文：优先纯文本，其次拍平的 HTML（解码常见实体） */
export function mailText(mail: MailContext): string {
  const text = mail.text || (mail.html ? flattenHtml(mail.html) : '');
  return text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&yen;/g, '￥');
}

/** HTML 拍平为纯文本（去样式/脚本，保留换行语义） */
export function flattenHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|div|td|table|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/**
 * 图片账单判定：正文/附件文本均空且拍平 HTML 中金额计数不足 → 账单内容在图片里。
 * 阈值经 32 封招行真实图片账单校准（营销文案"赢999还款金"无小数金额，不会误判；
 * HNB/CEB/CITIC 的 HTML 账单金额众多，不会误入）。
 * 附件 HTML 需拍平后度量：招行 2016-2020 部分账单附件原文数千字符但全是 img 标签与
 * JS 脚本（拍平后无文字），同样属于图片账单。
 * 挂载在解析失败分支：只有"本应解析却无文本可用"的邮件才归图片，不误伤可解析邮件。
 */
export function isImageOnlyMail(mail: MailContext): boolean {
  const textLen = (mail.text ?? '').trim().length;
  const pdfLen = (mail.pdfText ?? '').trim().length;
  const attachFlat = mail.attachText ? flattenHtml(mail.attachText).replace(/\s+/g, ' ').trim() : '';
  if (textLen >= 50 || pdfLen >= 50 || attachFlat.length >= 50) return false;
  // 附件存在但拍平后无文字（纯图片附件，正文摘要金额多少不影响判定）
  if (mail.attachText && attachFlat.length < 50) return true;
  if (!mail.html) return false;
  const flat = flattenHtml(mail.html);
  return (flat.match(/\d[\d,]*\.\d{2}/g) ?? []).length < 3;
}

/**
 * 借记卡综合对账单判定：工行"个人综合对账单"为存款/理财/借记卡月结单，
 * 信用卡区块可为空（有数据时格式也与现役解析器不同），无信用卡账单可产出 → 忽略。
 * 挂载在解析失败分支，不会误伤可正常解析的邮件。
 */
export function isDebitOnlyStatement(mail: MailContext): boolean {
  const sources = [
    mail.text ?? '',
    mail.html ? flattenHtml(mail.html) : '',
    mail.pdfText ?? '',
    mail.attachText ? flattenHtml(mail.attachText) : '',
  ];
  return sources.some((t) => t.includes('个人综合对账单'));
}

/** 依次尝试一组正则，返回第一个命中的捕获组 */
export function pick(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/** 解析金额：'12,345.67' → 12345.67；'无欠款'/'---' 等 → null */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[,，\s￥¥＄$]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析日期为上海时区零点时刻。支持：
 *   2026年08月14日 / 2026年8月25日 / 2026-08-14 / 2026/08/14 / 2026.08.14 / 20260814
 */
export function parseDate(raw: string): Date | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (m) return safeYmd(m[1], m[2], m[3]);
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return safeYmd(m[1], m[2], m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return safeYmd(m[1], m[2], m[3]);
  return null;
}

function safeYmd(y: string, mo: string, d: string): Date | null {
  const ymdStr = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const date = fromYmd(ymdStr);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 账单周期（如 '2026/07/11-2026/08/10' 或 '2026/06/28-2026/07/27'）→ 期末日期（出账日） */
export function cycleEnd(raw: string): Date | null {
  const m = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/);
  return m ? safeYmd(m[1], m[2], m[3]) : null;
}

/** '15' / '15日' / '每月15日' 等规则文本中的"日" + 账单年月 → 具体出账日 */
export function monthlyRuleDate(dayRaw: string, year: number, month: number): Date | null {
  const m = dayRaw.match(/(\d{1,2})/);
  if (!m) return null;
  return dayOfMonthClamped(year, month, Number(m[1]));
}

/** 从"尊敬的 XXX 先生/女士"提取持卡人姓名（通用称呼如"客户您好"不算姓名） */
export function pickHolder(text: string): string | null {
  const raw = pick(text, [/尊敬的\s*([\u4e00-\u9fa5·*]{2,10})\s*(?:先生|女士|小姐|同学|阁下)?/]);
  if (!raw) return null;
  if (/客户|您好|持卡人|用户/.test(raw)) return null;
  return raw.replace(/(先生|女士|小姐|同学|阁下)$/, '') || null;
}

/** 组装并校验一条账单：日期非法或还款日早于出账日时返回 null。卡尾由解析器传入，不回退抬头掩码。 */
export function buildBill(params: {
  bankName: string;
  cardLast4: string;
  holderName?: string | null;
  amount: number;
  minAmount?: number | null;
  currency?: string;
  statementDate: Date;
  dueDate: Date;
  cardNoFull?: string | null;
}): ParsedBill | null {
  if (Number.isNaN(params.statementDate.getTime()) || Number.isNaN(params.dueDate.getTime())) return null;
  if (shanghaiMidnight(params.dueDate) < shanghaiMidnight(params.statementDate)) return null;
  const bill: ParsedBill = {
    bankName: params.bankName,
    cardLast4: params.cardLast4,
    holderName: params.holderName || undefined,
    amount: params.amount,
    minAmount: params.minAmount ?? undefined,
    currency: normalizeCurrency(params.currency),
    statementDate: params.statementDate,
    dueDate: params.dueDate,
    period: periodOf(params.statementDate),
  };
  if (params.cardNoFull) bill.cardNoFull = params.cardNoFull;
  return bill;
}

/**
 * 实际年费支出：沿用既有金额口径，排除返还、冲销和减免类标记。
 */
export function isAnnualFeeCharge(transaction: Pick<ParsedTransaction, 'amount' | 'description'>): boolean {
  return transaction.amount > 0
    && /年费/.test(transaction.description)
    && !/退|返|冲|免|减/.test(transaction.description);
}

/** 实际年费金额合计；零元刷免只用于识别日期，不进入金额。 */
export function detectAnnualFeeAmount(transactions?: ParsedTransaction[]): number | null {
  if (!transactions || transactions.length === 0) return null;
  let total = 0;
  let hit = false;
  for (const transaction of transactions) {
    if (isAnnualFeeCharge(transaction)) {
      total += transaction.amount;
      hit = true;
    }
  }
  return hit ? Math.round(total * 100) / 100 : null;
}

/** 年费日证据：实际年费，或金额为 0 且描述明确包含“年费”的刷免记录。 */
export function isAnnualFeeDateEvidence(transaction: Pick<ParsedTransaction, 'amount' | 'description'>): boolean {
  return isAnnualFeeCharge(transaction)
    || (transaction.amount === 0 && /年费/.test(transaction.description));
}

/** 日期行判定：YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD / MM-DD / MM/DD → 原样文本；否则 null */
export function dateLine(l: string): string | null {
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(l)) return l;
  if (/^\d{8}$/.test(l)) return l;
  if (/^\d{1,2}[-/.]\d{1,2}$/.test(l)) return l;
  return null;
}

/**
 * 金额行判定：￥22.00 / -￥4,063.25 / 5.50 / (存入)1,194.62 / 1,210.00/RMB / 1,210.00/RMB(支出)
 * → number；否则 null。金额必须带两位小数（避免误吞积分/卡尾号等纯数字行）。
 */
export function amountLine(l: string): number | null {
  let s = l.replace(/^[（(]?(?:存入|支出)[）)]?\s*/, '').replace(/^[￥¥]\s*/, '');
  const m = s.match(/^(-?[\d,]+\.\d{2})(?:\/[A-Z]{2,3})?(?:[（(][^）)]*[）)])?$/);
  return m ? parseAmount(m[1]) : null;
}

/** 4 位卡尾行判定：纯 4 位数字 → 原样；否则 null */
export function cardTailLine(l: string): string | null {
  return /^\d{4}$/.test(l) ? l : null;
}

/**
 * 中信明细 8 行组：交易日(YYYYMMDD) / 记账日 / 卡号后四位 / 描述 / CNY / 交易金额 / CNY / 记账金额。
 * 卡尾取明细列四位，不用抬头掩码。
 */
export function citicTransactions(text: string): Array<ParsedTransaction & { cardLast4: string }> {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const txns: Array<ParsedTransaction & { cardLast4: string }> = [];
  for (let i = 0; i + 7 < lines.length; i++) {
    const d1 = dateLine(lines[i] ?? '');
    const d2 = d1 ? dateLine(lines[i + 1] ?? '') : null;
    const tail = d2 ? cardTailLine(lines[i + 2] ?? '') : null;
    if (!d1 || !d2 || !tail || !/^\d{8}$/.test(d1)) continue;
    const desc = lines[i + 3] ?? '';
    if (!desc || lines[i + 4] !== 'CNY' || lines[i + 6] !== 'CNY') continue;
    const value = parseAmount(lines[i + 7] ?? '');
    if (value == null) continue;
    txns.push({ date: d1, description: desc, amount: value, cardLast4: tail });
    i += 7;
  }
  return txns;
}

/**
 * 中信卡尾：优先明细「卡号后四位」四位；3 位抬头不得回退。无明细时仅 4 位抬头可用。
 */
export function resolveCiticCardLast4(headerTail: string, txnTails: string[]): string | null {
  if (/^\d{4}$/.test(headerTail)) return headerTail;
  const matches = [...new Set(txnTails.filter((t) => t.endsWith(headerTail)))];
  return matches.length === 1 ? matches[0]! : null;
}

/** 交易行内剥离币种/国别尾巴（如 "CHN 488.00" / "488.00/RMB"）后的金额提取 */
export function trailingAmount(l: string): number | null {
  const m = l.match(/(-?[\d,]+\.\d{2})\s*$/);
  return m ? parseAmount(m[1]) : null;
}

/**
 * 通用 5 行组明细解析：交易日/记账日/摘要/金额行/卡尾号（北京/长沙/湖南农信/南京银行同款模板）。
 * amountRe 匹配金额行（捕获组 1 为带符号金额文本，如 'RMB:9.50' / '-157.80'）。
 */
export function fiveLineTransactions(text: string, amountRe: RegExp): ParsedTransaction[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const txns: ParsedTransaction[] = [];
  for (let i = 0; i + 4 < lines.length; i++) {
    const d1 = dateLine(lines[i] ?? '');
    const d2 = d1 ? dateLine(lines[i + 1] ?? '') : null;
    if (!d1 || !d2 || !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(d1)) continue;
    const desc = lines[i + 2] ?? '';
    const amountM = (lines[i + 3] ?? '').match(amountRe);
    const value = amountM ? parseAmount(amountM[1]) : null;
    const tail = lines[i + 4] ?? '';
    if (!desc || value == null || !/^\d{4}$/.test(tail)) continue;
    // 银行费用行卡尾 0000：解析阶段留空，不填 0000 / ----
    txns.push({ date: d1, description: desc, amount: value, cardLast4: tail === '0000' ? null : tail });
    i += 4;
  }
  return txns;
}

/**
 * 把明细行按卡号后四位严格匹配归属到对应账单（多卡合并账单场景）。
 * 无卡号标识的行由调用方自行补 cardLast4（单卡账单可直接补该卡尾号）。
 * 明细行保留 cardLast4 字段，供合并账单明细展示时区分卡尾。
 */
export function attachTransactions(bills: ParsedBill[], txns: ParsedTransaction[]): void {
  for (const bill of bills) {
    const own = txns.filter((t) => t.cardLast4 === bill.cardLast4);
    if (own.length > 0) bill.transactions = own;
  }
}

/**
 * 明细卡尾决定账单归属：邮件正文无卡号时，明细行末的卡尾即真实归属卡。
 * 全部交易同一卡尾 → 账单挂该卡；多卡尾 → 合并账单（主卡 + cardLast4s）；
 * 明细无卡尾 → 保持 bill 原有的 cardLast4。
 */
export function applyTransactionTails(bill: ParsedBill, txns: ParsedTransaction[]): void {
  if (txns.length === 0) return;
  bill.transactions = txns;
  let tails = Array.from(new Set(txns.map((t) => t.cardLast4).filter((t): t is string => !!t)));
  // 银行把账户级费用行的卡尾显示为 0000（如招行 2023-02 会员费行），
  // 与真实卡尾并存时是占位符而非卡号，从归属判定中剔除（交易行本身保留展示）
  if (tails.length > 1) tails = tails.filter((t) => t !== '0000');
  if (tails.length === 1) {
    // 明细全是银行 0000 费用行时，不覆盖档案占位 ----
    if (tails[0] === '0000' && bill.cardLast4 === UNKNOWN_CARD_TAIL) return;
    bill.cardLast4 = tails[0]!;
  } else if (tails.length > 1) {
    bill.cardLast4 = tails[0]!;
    bill.cardLast4s = tails;
  }
}

/**
 * 账户级多币种账单共用同一套实体卡。某币种没有交易时，沿用同封邮件中
 * 已由交易明细识别出的卡尾关系，避免零金额外币账单落到独立占位卡。
 */
export function propagateAccountBillTails(bills: ParsedBill[]): void {
  const source = bills.find((bill) => bill.cardLast4 !== UNKNOWN_CARD_TAIL);
  if (!source) return;
  for (const bill of bills) {
    if (bill.cardLast4 !== UNKNOWN_CARD_TAIL) continue;
    bill.cardLast4 = source.cardLast4;
    if (source.cardLast4s) bill.cardLast4s = [...source.cardLast4s];
    if (source.holderMap) bill.holderMap = { ...source.holderMap };
  }
}

/**
 * 同封账户级账单可能先按卡片列出各卡金额；落库前按币种汇总成一张账单，
 * 同时保留各交易的卡尾归属与完整套卡关系。
 */
export function mergeAccountBillsByCurrency(bills: ParsedBill[]): ParsedBill[] {
  const merged = new Map<string, ParsedBill>();
  for (const source of bills) {
    const currency = normalizeCurrency(source.currency);
    const target = merged.get(currency);
    if (!target) {
      merged.set(currency, {
        ...source,
        currency,
        cardLast4s: source.cardLast4s ? [...source.cardLast4s] : undefined,
        holderMap: source.holderMap ? { ...source.holderMap } : undefined,
        transactions: source.transactions ? [...source.transactions] : undefined,
      });
      continue;
    }
    target.amount = Math.round((target.amount + source.amount) * 100) / 100;
    const minimums = [target.minAmount, source.minAmount].filter((value): value is number => value != null);
    target.minAmount = minimums.length > 0
      ? Math.round(minimums.reduce((sum, value) => sum + value, 0) * 100) / 100
      : undefined;
    const tails = Array.from(new Set([
      target.cardLast4,
      ...(target.cardLast4s ?? []),
      source.cardLast4,
      ...(source.cardLast4s ?? []),
    ]));
    target.cardLast4s = tails.length > 1 ? tails : undefined;
    if (source.transactions?.length) {
      target.transactions = [...(target.transactions ?? []), ...source.transactions];
    }
    if (source.holderMap) target.holderMap = { ...(target.holderMap ?? {}), ...source.holderMap };
  }

  const result = [...merged.values()];
  const allTails = Array.from(new Set(result.flatMap((bill) => [bill.cardLast4, ...(bill.cardLast4s ?? [])])));
  if (allTails.length > 1) {
    for (const bill of result) bill.cardLast4s = [...allTails];
  }
  return result;
}
