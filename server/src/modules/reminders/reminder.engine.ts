import { prisma } from '../../lib/prisma';
import {
  addDays,
  dayOfMonthClamped,
  dayOf,
  daysBetween,
  formatCn,
  monthParts,
  periodOf,
  sameDay,
  shanghaiMidnight,
  today,
  ymd,
} from '../../lib/dates';
import { computeRuleCycle, openMissingCycle } from '../bills/ledger';
import { materializeCustomReminderOccurrences, occurrenceToView, type CustomOccurrenceLike } from './custom-occurrences';
import { customTargetDatesBetween, type CustomScheduleLike } from './custom-schedule';

/** 卡档案的最小结构（便于纯函数测试与复用） */
export interface CardLike {
  id: number;
  bankName: string;
  cardLast4: string;
  statementDay: number;
  dueRule: string; // 'fixed' | 'offset'
  dueDay: number | null;
  dueOffsetDays: number | null;
  remindDaysBefore: number[];
  status: string;
  businessPrimaryId?: number | null;
  /** 年费收取日（每年该月日收取，null=未设置） */
  annualFeeDate?: Date | null;
}

export interface BillLike {
  id?: number;
  /** 账单归属卡（合并账单的主卡） */
  cardId: number;
  period: string;
  dueDate: Date;
  /** null = 金额未取得 */
  amount?: number | string | { toString(): string } | null;
  minAmount?: number | string | { toString(): string } | null;
  currency: string;
  paidStatus: string;
  /** 已还金额（partial 时有意义；full 时等于应还金额） */
  paidAmount?: number | string | { toString(): string } | null;
  /** 本期年费（正数非退还合计），null=无 */
  annualFeeAmount?: number | string | { toString(): string } | null;
  /** 合并账单共享该账单的其他卡（不含归属卡） */
  linkedCardIds?: number[];
}

/** 某个账期（出账月）的关键日期：有真实账单用账单还款日，否则按规则推算 */
export function computeCycle(card: CardLike, year: number, month: number, bill?: BillLike | null) {
  const ruleCycle = computeRuleCycle(card, year, month);
  const statementDate = ruleCycle.statementDate;
  const dueDate = bill ? shanghaiMidnight(bill.dueDate) : ruleCycle.dueDate;
  return { period: periodOf(statementDate), statementDate, dueDate, hasBill: !!bill, bill: bill ?? null };
}

/** 卡在 today 应触发的提醒事件（含结构化字段，供前端快速标记还款） */
export interface CardEvent {
  type: 'card_due' | 'card_statement' | 'card_fee';
  /** 通知去重与业务定位：真实账单用 Bill.id，未取得账单与年费事件用负卡片 ID。 */
  refId: number;
  cardId: number;
  bankName: string;
  cardLast4: string;
  /** 相关账期（card_fee 为年费计入的账期） */
  period: string | null;
  title: string;
  body: string;
  /** 触发日（today） */
  fireDate: Date;
  /** 该期还款日（card_fee 为前一期账单还款日） */
  dueDate: Date | null;
  billId: number | null;
  hasBill: boolean;
  amount: number | null;
  minAmount: number | null;
  currency: string | null;
  paidStatus: string | null;
  /** 已还金额（partial 时有意义；full 时等于应还金额） */
  paidAmount: number | null;
  /** 合并账单共享卡数（含主卡，1=普通账单） */
  linkedCount: number;
}

/** 提醒文案统一携带币种代码，避免 ¥ 在人民币与日元之间产生歧义。 */
function money(currency: string, amount: number): string {
  const code = currency.toUpperCase();
  const symbol = code === 'CNY' ? '¥' : code === 'USD' ? '$' : code === 'EUR' ? '€' : code === 'GBP' ? '£' : '';
  const fractionDigits = code === 'JPY' || code === 'KRW' ? 0 : 2;
  const value = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
  return symbol ? `${code} ${symbol}${value}` : `${code} ${value}`;
}

/**
 * 年费收取时间表：下一次年费日、计入账期、前一期账期与其还款日。
 * 提醒锚点 = 前一期账单还款日。年费日在出账日之后时锚点可能晚于收取日
 * （此时年费已入账但账单未出，仍提示"将计入下期账单"），因此候选含今年已过
 * 但账单未出的收取日；该期账单已出则顺延至明年。
 */
export function annualFeeSchedule(
  card: CardLike,
  bills: BillLike[],
  today: Date,
): { feeDate: Date; feePeriod: string; prevPeriod: string; prevDue: Date } | null {
  if (!card.annualFeeDate) return null;
  const anchor = ymd(shanghaiMidnight(card.annualFeeDate));
  const feeMonth = Number(anchor.slice(5, 7));
  const feeDay = Number(anchor.slice(8, 10));
  const { year: ty } = monthParts(today);
  const candidates = [dayOfMonthClamped(ty, feeMonth, feeDay), dayOfMonthClamped(ty + 1, feeMonth, feeDay)];

  for (const feeDate of candidates) {
    // 年费落入的账期：年费日之后（含当天）最近的出账日所在月
    const feeOnOrBeforeStatement = dayOf(feeDate) <= card.statementDay;
    const feePeriodParts = feeOnOrBeforeStatement ? monthParts(feeDate) : monthParts(feeDate, 1);
    const feePeriod = `${feePeriodParts.year}-${String(feePeriodParts.month).padStart(2, '0')}`;
    // 年费账单已出则该次不再提示，顺延候选
    if (bills.some((b) => b.period === feePeriod)) continue;

    // 前一期账单及其还款日（锚点已过则该次无可提醒）
    const prev = monthParts(feeDate, feeOnOrBeforeStatement ? -1 : 0);
    const prevPeriod = `${prev.year}-${String(prev.month).padStart(2, '0')}`;
    const prevBill = bills.find((b) => b.period === prevPeriod) ?? null;
    const prevDue = prevBill ? shanghaiMidnight(prevBill.dueDate) : computeCycle(card, prev.year, prev.month, null).dueDate;
    if (prevDue >= today) return { feeDate, feePeriod, prevPeriod, prevDue };
  }
  return null;
}

export function collectCardEvents(
  card: CardLike,
  bills: BillLike[],
  today: Date,
  /** 全体活跃卡 id（合并账单归属卡不活跃时由关联卡兜底提醒；缺省视为归属卡活跃） */
  activeCardIds?: Set<number>,
): CardEvent[] {
  const events: CardEvent[] = [];
  if (card.status !== 'active') return events;

  /** 合并账单归属其他卡且该卡活跃时跳过（避免同一账单重复提醒），返回 true 表示跳过 */
  const ownedByOtherActive = (bill: BillLike): boolean =>
    bill.cardId !== card.id && (activeCardIds == null || activeCardIds.has(bill.cardId));
  const openMissing = openMissingCycle(card, today);

  if (card.businessPrimaryId == null) for (const offset of [-1, 0, 1]) {
    const { year, month } = monthParts(today, offset);
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const periodBills = bills.filter((bill) => bill.period === period);
    const candidates: Array<BillLike | null> = periodBills.length > 0 ? periodBills : [null];
    for (const bill of candidates) {
    if (bill && ownedByOtherActive(bill)) continue; // 主卡已提醒该账单
    const cycle = computeCycle(card, year, month, bill);
    // 无真实账单时，还款催缴只走台账允许的上一期未取得占位；出账日当天提醒仍保留
    const allowMissingDue = openMissing != null && openMissing.period === period;
    // 年费附加提示：本期账单检测到正数非退还年费时追加
    const annualFee = bill?.annualFeeAmount != null ? Number(bill.annualFeeAmount) : null;
    const annualFeeText = annualFee != null && annualFee > 0 && bill
      ? `，含年费 ${money(bill.currency, annualFee)}`
      : '';
    const linkedCount = bill ? 1 + (bill.linkedCardIds?.length ?? 0) : 1;
    const amountText =
      bill == null
        ? '未取得账单'
        : bill.amount != null
          ? `应还 ${money(bill.currency, Number(bill.amount))}`
          : '账单金额未取得';
    // 部分已还时补充已还/剩余金额（账单未结清，提醒继续）
    const paidAmt = bill?.paidAmount != null ? Number(bill.paidAmount) : null;
    const partialText =
      bill != null && bill.paidStatus === 'partial' && bill.amount != null
        ? `（已还 ${money(bill.currency, paidAmt ?? 0)}，剩 ${money(bill.currency, Math.max(0, Number(bill.amount) - (paidAmt ?? 0))) }）`
        : '';
    const minText =
      bill?.minAmount != null && bill.amount != null ? `（最低 ${money(bill.currency, Number(bill.minAmount))}）` : '';

    // 出账提醒：出账日当天（有账单给摘要，没账单给警示）
    if (sameDay(today, cycle.statementDate)) {
      events.push({
        type: 'card_statement',
        refId: bill?.id ?? -card.id,
        cardId: card.id,
        bankName: card.bankName,
        cardLast4: card.cardLast4,
        period,
        title: '账单出账提醒',
        body: bill
          ? `${card.bankName}（${card.cardLast4}）${period}账单已出：${amountText}${partialText}${minText}${annualFeeText}，还款日 ${formatCn(cycle.dueDate)}`
          : `${card.bankName}（${card.cardLast4}）今日出账`,
        fireDate: today,
        dueDate: cycle.dueDate,
        billId: bill?.id ?? null,
        hasBill: !!bill,
        amount: bill?.amount != null ? Number(bill.amount) : null,
        minAmount: bill?.minAmount != null ? Number(bill.minAmount) : null,
        currency: bill?.currency ?? null,
        paidStatus: bill?.paidStatus ?? null,
        paidAmount: bill?.paidAmount != null ? Number(bill.paidAmount) : null,
        linkedCount,
      });
    }

    // 还款提醒：今天 ∈ {还款日 - N}
    const daysToDue = daysBetween(today, cycle.dueDate);
    if (card.remindDaysBefore.includes(daysToDue)) {
      // 该期账单已标记还清则不再催还；无账单则仅催台账允许的未取得期
      if (bill && bill.paidStatus === 'paid') continue;
      if (!bill && !allowMissingDue) continue;
      events.push({
        type: 'card_due',
        refId: bill?.id ?? -card.id,
        cardId: card.id,
        bankName: card.bankName,
        cardLast4: card.cardLast4,
        period,
        title: '还款提醒',
        body:
          daysToDue === 0
            ? `${card.bankName}（${card.cardLast4}）今天还款日！${amountText}${partialText}${minText}${annualFeeText}`
            : `${card.bankName}（${card.cardLast4}）还款日 ${formatCn(cycle.dueDate)}，还有 ${daysToDue} 天，${amountText}${partialText}${minText}${annualFeeText}`,
        fireDate: today,
        dueDate: cycle.dueDate,
        billId: bill?.id ?? null,
        hasBill: !!bill,
        amount: bill?.amount != null ? Number(bill.amount) : null,
        minAmount: bill?.minAmount != null ? Number(bill.minAmount) : null,
        currency: bill?.currency ?? null,
        paidStatus: bill?.paidStatus ?? null,
        paidAmount: bill?.paidAmount != null ? Number(bill.paidAmount) : null,
        linkedCount,
      });
    }
    }
  }

  // 年费提醒：前一期账单还款日提示"年费即将出账"
  const fee = annualFeeSchedule(card, bills, today);
  if (fee && daysBetween(today, fee.prevDue) === 0) {
    events.push({
      type: 'card_fee',
      refId: -card.id,
      cardId: card.id,
      bankName: card.bankName,
      cardLast4: card.cardLast4,
      period: fee.feePeriod,
      title: '年费提醒',
      body: `${card.bankName}（${card.cardLast4}）年费即将出账：${ymd(fee.feeDate)} 收取，将计入 ${fee.feePeriod} 账单`,
      fireDate: today,
      dueDate: fee.prevDue,
      billId: null,
      hasBill: false,
      amount: null,
      minAmount: null,
      currency: null,
      paidStatus: null,
      paidAmount: null,
      linkedCount: 1,
    });
  }
  return events;
}

export interface CustomReminderLike {
  id: number;
  name: string;
  businessType: string;
  type: string;
  interval: number;
  anchorDate: Date;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  monthOfYear: number | null;
  specificDate: Date | null;
  daysBefore: number[];
  fixedAmount: number | null;
  note: string | null;
  enabled: boolean;
}

export interface CustomEvent {
  type: 'custom';
  refId: number;
  occurrenceId: number;
  businessType: string;
  title: string;
  body: string;
  fireDate: Date;
  targetDate: Date;
  amount: number | null;
}

export function collectCustomEvents(occurrence: CustomOccurrenceLike, now: Date, reminderEnabled = true): CustomEvent[] {
  if (!reminderEnabled || occurrence.status !== 'open' || occurrence.suspended) return [];
  const diff = daysBetween(now, occurrence.targetDate);
  if (!occurrence.daysBefore.includes(diff)) return [];
  const dateText = diff === 0 ? '今天' : `${formatCn(occurrence.targetDate)}，还有 ${diff} 天`;
  const amountText =
    occurrence.businessType === 'fixed_bill' && occurrence.amount != null
      ? `，金额 ${money('CNY', occurrence.amount)}`
      : '';
  return [{
    type: 'custom',
    refId: occurrence.id,
    occurrenceId: occurrence.id,
    businessType: occurrence.businessType,
    title: occurrence.name,
    body: `${dateText}${amountText}${occurrence.note ? `，${occurrence.note}` : ''}`,
    fireDate: now,
    targetDate: occurrence.targetDate,
    amount: occurrence.amount,
  }];
}

// ============ 即将到期视图（仪表盘/提醒页共用） ============

export interface UpcomingItem {
  /** 前端列表稳定唯一键：卡事项按卡/账期/类型，自定义事项按提醒/日期 */
  sourceKey: string;
  date: string; // YYYY-MM-DD
  type: 'due' | 'statement' | 'custom' | 'fee';
  title: string;
  detail: string;
  amount: number | null;
  minAmount: number | null;
  currency: string | null;
  /** 是否已结清（null=无账单） */
  paid: boolean | null;
  /** 三态还款状态：'unpaid' | 'partial' | 'paid'（null=无账单） */
  paidStatus: string | null;
  /** 已还金额（partial 时有意义；full 时等于应还金额） */
  paidAmount: number | null;
  daysLeft: number;
  hasBill: boolean;
  cardId?: number;
  billId?: number | null;
  period?: string | null;
  customOccurrenceId?: number | null;
  customBusinessType?: string | null;
  customAction?: 'complete' | 'pay' | null;
  actionable?: boolean;
  /** 合并账单共享卡数（含主卡，1=普通账单） */
  linkedCount?: number;
}

export function collectUpcoming(
  cards: CardLike[],
  billsByCard: Map<number, BillLike[]>,
  customs: CustomReminderLike[],
  today: Date,
  days = 30,
  customOccurrences: CustomOccurrenceLike[] = [],
): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  const horizon = addDays(today, days);
  const statusOf = new Map(cards.map((c) => [c.id, c.status] as const));

  for (const card of cards) {
    if (card.status !== 'active') continue;
    const bills = billsByCard.get(card.id) ?? [];
    if (card.businessPrimaryId == null) for (let offset = -1; offset <= 2; offset++) {
      const { year, month } = monthParts(today, offset);
      const period = `${year}-${String(month).padStart(2, '0')}`;
      const periodBills = bills.filter((bill) => bill.period === period);
      const candidateBills: Array<BillLike | null> = periodBills.length > 0 ? periodBills : [null];
      for (const bill of candidateBills) {
      // 合并账单归属其他卡且该卡活跃时跳过（主卡视图已含该账单）
      if (bill && bill.cardId !== card.id && statusOf.get(bill.cardId) === 'active') continue;
      const cycle = computeCycle(card, year, month, bill);
      const linkedCount = bill ? 1 + (bill.linkedCardIds?.length ?? 0) : 1;
      const openMissing = openMissingCycle(card, today);

      if (cycle.statementDate >= today && cycle.statementDate <= horizon) {
        items.push({
          sourceKey: bill ? `bill:${bill.id}:statement` : `card:${card.id}:${period}:statement`,
          date: ymd(cycle.statementDate),
          type: 'statement',
          title: `${card.bankName}（${card.cardLast4}）出账日`,
          detail: bill ? '账单已出' : '',
          amount: bill?.amount != null ? Number(bill.amount) : null,
          minAmount: bill?.minAmount != null ? Number(bill.minAmount) : null,
          currency: bill?.currency ?? null,
          paid: null,
          paidStatus: null,
          paidAmount: null,
          daysLeft: daysBetween(today, cycle.statementDate),
          hasBill: !!bill,
          cardId: card.id,
          billId: bill?.id ?? null,
          period,
          linkedCount,
        });
      }
      const allowMissingDue = bill != null || (openMissing != null && openMissing.period === period);
      if (allowMissingDue && cycle.dueDate >= today && cycle.dueDate <= horizon && !(bill && bill.paidStatus === 'paid')) {
        items.push({
          sourceKey: bill ? `bill:${bill.id}:due` : `card:${card.id}:${period}:due`,
          date: ymd(cycle.dueDate),
          type: 'due',
          title: `${card.bankName}（${card.cardLast4}）还款日`,
          detail: bill ? '' : '未取得账单',
          amount: bill?.amount != null ? Number(bill.amount) : null,
          minAmount: bill?.minAmount != null ? Number(bill.minAmount) : null,
          currency: bill?.currency ?? null,
          paid: bill ? bill.paidStatus === 'paid' : null,
          paidStatus: bill?.paidStatus ?? null,
          paidAmount: bill?.paidAmount != null ? Number(bill.paidAmount) : null,
          daysLeft: daysBetween(today, cycle.dueDate),
          hasBill: !!bill,
          cardId: card.id,
          billId: bill?.id ?? null,
          period,
          linkedCount,
        });
      }
      }
    }

    // 年费即将出账（前一期账单还款日）
    const fee = annualFeeSchedule(card, bills, today);
    if (fee && fee.prevDue >= today && fee.prevDue <= horizon) {
      items.push({
        sourceKey: `card:${card.id}:${fee.feePeriod}:fee`,
        date: ymd(fee.prevDue),
        type: 'fee',
        title: `${card.bankName}（${card.cardLast4}）年费即将出账`,
        detail: `${ymd(fee.feeDate)} 收取，计入 ${fee.feePeriod} 账单`,
        amount: null,
        minAmount: null,
        currency: null,
        paid: null,
        paidStatus: null,
        paidAmount: null,
        daysLeft: daysBetween(today, fee.prevDue),
        hasBill: false,
        cardId: card.id,
        billId: null,
        period: fee.feePeriod,
        linkedCount: 1,
      });
    }
  }

  const occurrenceByTarget = new Map(
    customOccurrences
      .filter((occurrence) => occurrence.reminderId != null)
      .map((occurrence) => [`${occurrence.reminderId}:${ymd(occurrence.targetDate)}`, occurrence] as const),
  );
  for (const r of customs) {
    if (!r.enabled) continue;
    const targets = customTargetDatesBetween(r as CustomScheduleLike, today, horizon);
    for (const target of targets) {
      if (target >= today && target <= horizon) {
        const occurrence = occurrenceByTarget.get(`${r.id}:${ymd(target)}`);
        if (occurrence && (occurrence.status !== 'open' || occurrence.suspended)) continue;
        const isBill = r.businessType === 'fixed_bill' || r.businessType === 'dynamic_bill';
        items.push({
          sourceKey: `custom:${r.id}:${ymd(target)}`,
          date: ymd(target),
          type: 'custom',
          title: r.name,
          detail: r.note || '',
          amount: occurrence?.amount ?? (r.businessType === 'fixed_bill' ? r.fixedAmount : null),
          minAmount: null,
          currency: isBill ? 'CNY' : null,
          paid: isBill ? false : null,
          paidStatus: isBill && occurrence ? 'unpaid' : null,
          paidAmount: null,
          daysLeft: daysBetween(today, target),
          hasBill: isBill && occurrence != null,
          customOccurrenceId: occurrence?.id ?? null,
          customBusinessType: r.businessType,
          customAction: r.businessType === 'general' ? 'complete' : 'pay',
          actionable: occurrence != null,
        });
      }
    }
  }

  return items.sort((a, b) => (a.date === b.date ? orderOf(a.type) - orderOf(b.type) : a.date < b.date ? -1 : 1));
}

function orderOf(type: UpcomingItem['type']): number {
  return type === 'due' ? 0 : type === 'fee' ? 1 : type === 'statement' ? 2 : 3;
}

// ============ 账单行 → 每卡可见账单（含合并账单关联） ============

/** 含 BillCard 关联的账单行（prisma include cards 后的形状） */
export interface BillRowWithLinks {
  id: number;
  cardId: number;
  period: string;
  dueDate: Date;
  amount: unknown;
  minAmount: unknown;
  currency: string;
  paidStatus: string;
  paidAmount: unknown;
  annualFeeAmount: unknown;
  cards?: Array<{ cardId: number }>;
}

/**
 * 账单行按卡分桶：归属卡 + 合并账单关联卡均可见该账单。
 * 关联卡视角下 bill.cardId 为归属卡 id，由引擎决定是否让归属卡唯一提醒。
 */
export function buildBillsByCard(billRows: BillRowWithLinks[]): Map<number, BillLike[]> {
  const map = new Map<number, BillLike[]>();
  const push = (cardId: number, like: BillLike) => {
    const list = map.get(cardId) ?? [];
    list.push(like);
    map.set(cardId, list);
  };
  for (const b of billRows) {
    const linkedCardIds = (b.cards ?? []).map((bc) => bc.cardId).filter((id) => id !== b.cardId);
    const like: BillLike = {
      id: b.id,
      cardId: b.cardId,
      period: b.period,
      dueDate: b.dueDate,
      amount: b.amount == null ? null : Number(b.amount),
      minAmount: b.minAmount == null ? null : Number(b.minAmount),
      currency: b.currency,
      paidStatus: b.paidStatus,
      paidAmount: b.paidAmount == null ? null : Number(b.paidAmount),
      annualFeeAmount: b.annualFeeAmount == null ? null : Number(b.annualFeeAmount),
      linkedCardIds,
    };
    push(b.cardId, like);
    for (const cid of linkedCardIds) push(cid, like);
  }
  return map;
}

// ============ 每日提醒事件汇总（由通用通知渠道调度器发送并防重） ============

export async function collectTodayEvents() {
  const now = today();
  await materializeCustomReminderOccurrences(now);
  const cards = await prisma.card.findMany({ where: { status: 'active', hidden: false } });
  const periods = [-1, 0, 1].map((o) => {
    const { year, month } = monthParts(now, o);
    return `${year}-${String(month).padStart(2, '0')}`;
  });
  const billRows = await prisma.bill.findMany({
    // 隐藏卡的历史账单仍可在账单页展示，但不再作为未来提醒或推送的归属来源。
    where: { period: { in: periods }, card: { hidden: false } },
    include: { cards: { select: { cardId: true } } },
  });
  const billsByCard = buildBillsByCard(billRows);

  const activeCardIds = new Set(cards.filter((c) => c.status === 'active').map((c) => c.id));
  const cardEvents = cards.flatMap((c) =>
    collectCardEvents(
      { ...c, remindDaysBefore: (c.remindDaysBefore as number[]) ?? [3, 1, 0] },
      billsByCard.get(c.id) ?? [],
      now,
      activeCardIds,
    ),
  );

  const occurrences = await prisma.customReminderOccurrence.findMany({
    where: { status: 'open', suspended: false, reminder: { enabled: true } },
    include: { reminder: { select: { enabled: true } } },
  });
  const customEvents = occurrences.flatMap((occurrence) =>
    collectCustomEvents(occurrenceToView(occurrence), now, occurrence.reminder?.enabled ?? false),
  );

  return { now, cardEvents, customEvents };
}
