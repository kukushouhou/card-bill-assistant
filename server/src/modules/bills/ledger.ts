/**
 * 账单台账与走势纯函数：
 * 1. buildLedger：真实账单行 + 「未取得账单」占位行 → 完整历史台账
 * 2. buildTrend：按期次聚合金额走势（无数据月份 total=null 断线）
 */
import { addDays, dayOfMonthClamped, daysBetween, monthParts, today as todayOf, ymd } from '../../lib/dates';
import { isOverdue, remainingOf } from './paid';

export interface LedgerCard {
  id: number;
  bankName: string;
  cardLast4: string;
  currency: string;
  statementDay: number;
  dueRule: string; // 'fixed' | 'offset'
  dueDay: number | null;
  dueOffsetDays: number | null;
  status: string; // 'active' | 'frozen' | 'closed'
  createdAt: Date;
  businessRole?: string;
  businessPrimaryId?: number | null;
}

export interface LedgerBillInput {
  id: number;
  cardId: number;
  period: string; // YYYY-MM
  statementDate: Date;
  dueDate: Date;
  amount: number | null;
  minAmount: number | null;
  currency: string;
  paidStatus: string;
  paidAt: Date | null;
  /** 已还金额（partial 时有意义；full 时等于应还金额） */
  paidAmount: number | null;
  hasDetails: boolean;
  annualFeeAmount: number | null;
  source: string; // 'email' | 'manual'
  /** 该账单关联的全部卡 id（含归属主卡） */
  linkedCardIds: number[];
}

export interface LedgerRow {
  /** 占位行无库记录 */
  id: number | null;
  cardId: number;
  bankName: string;
  cardLast4: string;
  /** 合并账单全部卡尾（主卡在前）；普通账单/占位行为单尾号 */
  cardTails: string[];
  period: string;
  statementDate: Date;
  dueDate: Date;
  amount: number | null;
  /** 当前待还金额；金额未知时为 null。 */
  remainingAmount: number | null;
  minAmount: number | null;
  currency: string;
  paidStatus: string | null;
  paidAt: Date | null;
  /** 已还金额（真实账单行有值；占位行 null） */
  paidAmount: number | null;
  hasDetails: boolean;
  annualFeeAmount: number | null;
  source: string; // 'email' | 'manual' | 'missing'
  /** true = 未取得账单占位行（可标记还款） */
  missing: boolean;
  /** 已过还款日且未履行最低还款的天数；未逾期为 null */
  daysOverdue: number | null;
}

/**
 * 账单行的逾期天数。未取得账单的占位行视为“未还”，
 * 因此即使 paidStatus 为 null，过了规则还款日也会正确标记逾期。
 */
function ledgerDaysOverdue(
  row: Pick<LedgerRow, 'dueDate' | 'amount' | 'minAmount' | 'paidStatus' | 'paidAmount' | 'missing'>,
  now: Date,
): number | null {
  const overdue = isOverdue(
    {
      dueDate: row.dueDate,
      amount: row.amount,
      minAmount: row.minAmount,
      paidStatus: row.missing ? 'unpaid' : (row.paidStatus ?? 'unpaid'),
      paidAmount: row.paidAmount,
    },
    now,
  );
  return overdue ? daysBetween(row.dueDate, now) : null;
}

/** 期次字符串（YYYY-MM）+ 偏移月 → 期次字符串 */
export function periodShift(period: string, offsetMonths: number): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const total = year * 12 + (month - 1) + offsetMonths;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

type DueRule = Pick<LedgerCard, 'dueRule' | 'dueDay' | 'dueOffsetDays'>;

/**
 * 按卡片规则从实际出账日推算还款日。
 * fixed 规则中还款日早于出账日时属于次月；通过 monthParts 归一化，12 月会正确跨到下一年。
 */
export function computeRuleDueDate(card: DueRule, statementDate: Date): Date {
  if (card.dueRule !== 'fixed' || !card.dueDay) {
    return addDays(statementDate, card.dueOffsetDays ?? 20);
  }
  const { year, month } = monthParts(statementDate);
  const sameMonth = dayOfMonthClamped(year, month, card.dueDay);
  if (sameMonth >= statementDate) return sameMonth;
  const next = monthParts(statementDate, 1);
  return dayOfMonthClamped(next.year, next.month, card.dueDay);
}

/** 卡规则推算某个出账月的出账日/还款日（无账单时的统一参考日期）。 */
export function computeRuleCycle(
  card: Pick<LedgerCard, 'statementDay' | 'dueRule' | 'dueDay' | 'dueOffsetDays'>,
  year: number,
  month: number,
): { statementDate: Date; dueDate: Date } {
  const statementDate = dayOfMonthClamped(year, month, card.statementDay);
  return { statementDate, dueDate: computeRuleDueDate(card, statementDate) };
}

function ruleCycle(
  card: Pick<LedgerCard, 'statementDay' | 'dueRule' | 'dueDay' | 'dueOffsetDays'>,
  period: string,
): { statementDate: Date; dueDate: Date } {
  return computeRuleCycle(card, Number(period.slice(0, 4)), Number(period.slice(5, 7)));
}

/**
 * 上一期已过出账日所在账期（出账日当天尚未算已过，回退到上一月）。
 */
export function lastPassedCycle(
  card: Pick<LedgerCard, 'statementDay' | 'dueRule' | 'dueDay' | 'dueOffsetDays'>,
  now: Date,
): { period: string; statementDate: Date; dueDate: Date } {
  const currentPeriod = ymd(now).slice(0, 7);
  const thisMonth = ruleCycle(card, currentPeriod);
  const period = thisMonth.statementDate < now ? currentPeriod : periodShift(currentPeriod, -1);
  return period === currentPeriod ? { period, ...thisMonth } : { period, ...ruleCycle(card, period) };
}

/**
 * 可展示的未取得账单期：仅正常使用的卡、上一期已过出账日；
 * 冻结/注销卡 / 出账日未到 / 过还款日 30 天 → 无。
 */
export function openMissingCycle(
  card: Pick<LedgerCard, 'statementDay' | 'dueRule' | 'dueDay' | 'dueOffsetDays' | 'status' | 'businessPrimaryId'>,
  now: Date,
): { period: string; statementDate: Date; dueDate: Date } | null {
  if (card.status !== 'active') return null;
  if (card.businessPrimaryId != null) return null;
  const cycle = lastPassedCycle(card, now);
  if (!(cycle.statementDate < now)) return null;
  if (now > addDays(cycle.dueDate, 30)) return null;
  return cycle;
}

/**
 * 完整台账：真实账单每期一行 + 至多一期「未取得账单」占位行。
 * - 冻结/注销卡只保留真实账单，不生成占位行；
 * - 只为上一期已过出账日所在账期生成一期；出账日未到不生成；不按日历月、不补中间月；
 * - 占位行过了规则还款日 30 天不返回（就当没有这期）；
 * - 合并账单副卡（近期出现在其他账单关联中）不生成独立占位行，由主卡账单行代表整个账户。
 */
export function buildLedger(
  scopeCards: LedgerCard[],
  allCards: LedgerCard[],
  bills: LedgerBillInput[],
  now: Date = todayOf(),
): LedgerRow[] {
  const cardById = new Map(allCards.map((c) => [c.id, c] as const));
  const rows: LedgerRow[] = [];

  for (const bill of bills) {
    const card = cardById.get(bill.cardId);
    if (!card) continue;
    const tails = bill.linkedCardIds
      .map((id) => cardById.get(id)?.cardLast4)
      .filter((t): t is string => !!t);
    const cardTails = tails.includes(card.cardLast4) ? tails : [card.cardLast4, ...tails];
    const row: LedgerRow = {
      id: bill.id,
      cardId: bill.cardId,
      bankName: card.bankName,
      cardLast4: card.cardLast4,
      cardTails,
      period: bill.period,
      statementDate: bill.statementDate,
      dueDate: bill.dueDate,
      amount: bill.amount,
      remainingAmount: bill.amount == null ? null : remainingOf(bill),
      minAmount: bill.minAmount,
      currency: bill.currency,
      paidStatus: bill.paidStatus,
      paidAt: bill.paidAt,
      paidAmount: bill.paidAmount,
      hasDetails: bill.hasDetails,
      annualFeeAmount: bill.annualFeeAmount,
      source: bill.source,
      missing: false,
      daysOverdue: null,
    };
    row.daysOverdue = ledgerDaysOverdue(row, now);
    rows.push(row);
  }

  // 每卡可见账单（自有 + 合并关联），按期索引
  const billsByCardPeriod = new Map<string, LedgerBillInput>();
  for (const b of bills) {
    for (const cid of b.linkedCardIds) billsByCardPeriod.set(`${cid}:${b.period}`, b);
  }
  // 合并账单中的副卡 id 集合（该卡在任意账单中以非主卡身份出现）
  const secondaryCards = new Set<number>();
  for (const b of bills) {
    for (const cid of b.linkedCardIds) if (cid !== b.cardId) secondaryCards.add(cid);
  }

  for (const card of scopeCards) {
    const cycle = openMissingCycle(card, now);
    if (!cycle) continue;
    if (billsByCardPeriod.has(`${card.id}:${cycle.period}`)) continue;
    // 副卡在相邻期（P-1/P/P+1）出现在合并账单关联中 → 该账户由主卡账单行代表
    const adjacentLinked =
      secondaryCards.has(card.id) &&
      [-1, 0, 1].some((o) => {
        const b = billsByCardPeriod.get(`${card.id}:${periodShift(cycle.period, o)}`);
        return b != null && b.cardId !== card.id;
      });
    if (adjacentLinked) continue;
    const row: LedgerRow = {
      id: null,
      cardId: card.id,
      bankName: card.bankName,
      cardLast4: card.cardLast4,
      cardTails: [card.cardLast4],
      period: cycle.period,
      statementDate: cycle.statementDate,
      dueDate: cycle.dueDate,
      amount: null,
      remainingAmount: null,
      minAmount: null,
      currency: card.currency,
      paidStatus: null,
      paidAt: null,
      paidAmount: null,
      hasDetails: false,
      annualFeeAmount: null,
      source: 'missing',
      missing: true,
      daysOverdue: null,
    };
    row.daysOverdue = ledgerDaysOverdue(row, now);
    rows.push(row);
  }

  // 未还清（含占位行）在前按还款日升序；历史已还在后按还款日倒序
  const unpaid = rows.filter((r) => r.paidStatus !== 'paid');
  const paid = rows.filter((r) => r.paidStatus === 'paid');
  const byDue = (a: LedgerRow, b: LedgerRow, dir: 1 | -1) => {
    const da = a.dueDate.getTime();
    const db = b.dueDate.getTime();
    if (da !== db) return (da - db) * dir;
    if (a.period !== b.period) return a.period < b.period ? -dir : dir;
    return ((b.id ?? 0) - (a.id ?? 0)) * dir;
  };
  unpaid.sort((a, b) => byDue(a, b, 1));
  paid.sort((a, b) => byDue(a, b, -1));
  return [...unpaid, ...paid];
}

export interface TrendItem {
  period: string;
  /** 无账单月份为 null（前端断线）；金额 null 的行不计入 */
  total: number | null;
  count: number;
}

/** 近 N 个月逐月聚合：合计金额 + 账单数；无数据月份 total=null */
export function buildTrend(
  bills: LedgerBillInput[],
  months: number,
  now: Date = todayOf(),
  currency?: string,
): TrendItem[] {
  const n = Math.max(1, Math.min(60, months));
  const currentPeriod = ymd(now).slice(0, 7);
  const byPeriod = new Map<string, { total: number; count: number }>();
  for (const b of bills) {
    if (currency && b.currency !== currency) continue;
    const entry = byPeriod.get(b.period) ?? { total: 0, count: 0 };
    if (b.amount != null) entry.total += b.amount;
    entry.count++;
    byPeriod.set(b.period, entry);
  }
  const items: TrendItem[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const period = periodShift(currentPeriod, -i);
    const entry = byPeriod.get(period);
    items.push({
      period,
      total: entry && entry.count > 0 ? Math.round(entry.total * 100) / 100 : null,
      count: entry?.count ?? 0,
    });
  }
  return items;
}
