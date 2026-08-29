import type { ParsedBill, ParsedCurrentCycleTransactions, ParsedTransaction } from './types';
import { prisma } from '../lib/prisma';
import type { Prisma } from '../generated/prisma/client';
import {
  detectAnnualFeeAmount,
  isAnnualFeeDateEvidence,
  normalizeCurrency,
  parseDate,
  UNKNOWN_CARD_TAIL,
} from './_util';
import { daysBetween, dayOf, lastDayOfMonth, monthParts, sameDay, shanghaiMidnight, ymd } from '../lib/dates';
import { pickPrimaryId } from '../lib/card-groups';
import { computeRuleDueDate } from '../modules/bills/ledger';

/** 无卡号占位（现行 ---- 与历史 0000） */
function isPlaceholderTail(tail: string): boolean {
  return tail === UNKNOWN_CARD_TAIL || tail === '0000';
}

/**
 * 解析结果落库流水线：
 * 1. 解析账单中出现的全部卡尾（合并账单多卡，主卡在前），逐个查/建卡档案
 *    - 无卡 → 自动建卡：由出账日/还款日反推提醒规则（优先"出账日+N天"），不写敏感字段
 *    - 主卡有卡 → diffCardRule 同步出账日/还款规则（银行调整账单日期时以最新账单为准）
 * 2. upsert 账单（主卡同期次去重，重复邮件刷新金额与日期），写入明细元数据
 *    （mailLogId 关联源邮件、hasDetails、annualFeeAmount 年费检测），并重建 BillCard 多卡关联
 * 3. 明细按卡尾解析实际所属卡并持久化；再按同一归属识别各卡年费日（手动设置不覆盖）
 * MailLog 由调用方（syncAccount）提前创建并传入 id。
 * 返回账单 ID。
 */
export async function applyParsedBill(mailLogId: number, parserId: string, bill: ParsedBill): Promise<number> {
  const ids = await applyParsedBills(mailLogId, parserId, [bill]);
  return ids[0]!;
}

/** 整封邮件的全部卡片/币种账单在同一事务中落库。 */
export async function applyParsedBills(mailLogId: number, parserId: string, bills: ParsedBill[]): Promise<number[]> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const applied: AppliedBill[] = [];
      for (const bill of bills) applied.push(await applyParsedBillInTransaction(tx, mailLogId, parserId, bill));
      await reconcileCurrentCycleTransactions(tx, bills, applied);
      return applied.map((row) => row.id);
    }),
  );
}

interface AppliedBill {
  id: number;
  currency: string;
  preferredId: number;
  cardByTail: Map<string, number>;
}

interface ResolvedCard {
  id: number;
  tail: string;
  holderName: string | null;
  primaryManual: boolean;
  isOwner: boolean;
  annualFeeDate: Date | null;
  annualFeeDateManual: boolean;
  priority: number;
}

interface ResolvedBillTransaction {
  source: ParsedTransaction;
  cardId: number;
  transactionDate: Date | null;
  data: Prisma.BillTransactionCreateManyInput;
}

async function applyParsedBillInTransaction(
  tx: Prisma.TransactionClient,
  mailLogId: number,
  parserId: string,
  bill: ParsedBill,
): Promise<AppliedBill> {
  const statementDate = shanghaiMidnight(bill.statementDate);
  const dueDate = shanghaiMidnight(bill.dueDate);
  const period = bill.period;
  void parserId;
    // 阶段 1：卡档案确定（空卡号按出账日匹配已有档案 / 真实卡号切归属）
    const tails = Array.from(new Set([bill.cardLast4, ...(bill.cardLast4s ?? [])]));
    const rule = inferCardRule(statementDate, dueDate);

    const resolved: ResolvedCard[] = [];
    let ownerCard: (typeof resolved)[number] | null = null;

    for (const tail of tails) {
      let card = await tx.card.findUnique({
        where: { bankName_cardLast4: { bankName: bill.bankName, cardLast4: tail } },
      });
      // 隐藏卡不承接新账单
      if (card?.hidden) card = null;

      // 已完善占位卡：匹配尾号仍 ----，展示尾号与本次真号相同 → 必须升级匹配尾号
      if (!card && !isPlaceholderTail(tail)) {
        const placeholders = await tx.card.findMany({
          where: { bankName: bill.bankName, cardLast4: { in: [UNKNOWN_CARD_TAIL, '0000'] }, hidden: false },
        });
        const matchDisplay = placeholders.find((c) => c.displayLast4 === tail);
        if (matchDisplay) {
          card = await tx.card.update({
            where: { id: matchDisplay.id },
            data: { cardLast4: tail, displayLast4: tail },
          });
          console.log(`[pipeline] 匹配尾号升级: ${bill.bankName}(----) → ${tail}`);
        }
      }

      // 无卡号账单（---- 占位）：按出账日/还款日规则匹配该银行已有可见档案
      // （含用户已完善、匹配尾号仍占位的卡；匹配不到才新建 ---- 占位卡）
      if (!card && isPlaceholderTail(tail)) {
        const bankCards = await tx.card.findMany({ where: { bankName: bill.bankName, hidden: false } });
        card = bankCards.find((c) => diffCardRule(c, bill.statementDate, bill.dueDate) === null) ?? null;
      }
      const isOwner = tail === bill.cardLast4;
      const mapped = bill.holderMap?.[tail];
      const mappedName = typeof mapped === 'string' && mapped ? mapped : null;
      // 账单级提取姓名只落到本封账单承接卡，不在解析器里猜附卡
      const extracted = isOwner && bill.holderName ? bill.holderName : null;

      if (!card) {
        card = await tx.card.create({
          data: {
            bankName: bill.bankName,
            cardLast4: tail,
            displayLast4: isPlaceholderTail(tail) ? UNKNOWN_CARD_TAIL : tail,
            holderName: mappedName || extracted || null,
            currency: normalizeCurrency(bill.currency),
            statementDay: rule.statementDay,
            dueRule: rule.dueRule,
            dueDay: rule.dueDay,
            dueOffsetDays: rule.dueOffsetDays,
            remindDaysBefore: [3, 1, 0],
            source: 'email',
            status: 'active',
          },
        });
        console.log(
          `[pipeline] 自动建卡: ${bill.bankName}(${tail})${isOwner ? '' : ' 合并账单副卡'} 出账日${rule.statementDay} 规则${rule.dueRule}` +
            (rule.dueRule === 'offset' ? `+${rule.dueOffsetDays}天` : `每月${rule.dueDay}日`),
        );
      } else {
        const patch: {
          statementDay?: number;
          dueRule?: string;
          dueDay?: number | null;
          dueOffsetDays?: number | null;
          holderName?: string;
        } = {};
        if (isOwner) Object.assign(patch, diffCardRule(card, statementDate, dueDate) ?? {});
        if (!card.holderName && (mappedName || extracted)) patch.holderName = mappedName || extracted!;
        if (Object.keys(patch).length) {
          await tx.card.update({ where: { id: card.id }, data: patch });
          if (patch.holderName) card.holderName = patch.holderName;
          console.log(`[pipeline] 规则更新: ${bill.bankName}(${tail}) ${JSON.stringify(patch)}`);
        }
      }

      const row = {
        id: card.id,
        tail,
        holderName: card.holderName ?? mappedName ?? extracted,
        primaryManual: card.primaryManual === true,
        isOwner,
        annualFeeDate: card.annualFeeDate ?? null,
        annualFeeDateManual: card.annualFeeDateManual === true,
        priority: card.priority ?? 0,
      };
      resolved.push(row);
      if (isOwner) ownerCard = row;
    }

    // 阶段 2：holderName 三档（映射 → 历史已有 → 同封承接卡已有值）；已有不覆盖
    const ownerHolder = ownerCard?.holderName ?? null;
    for (const row of resolved) {
      if (row.holderName) continue;
      if (!ownerHolder) continue;
      await tx.card.update({ where: { id: row.id }, data: { holderName: ownerHolder } });
      row.holderName = ownerHolder;
    }

    // 阶段 3：本封账单套卡配置——多卡时优先显示卡 = 手动钉住压过自动 → priority 降序 → id 升序
    const memberIds = resolved.map((r) => r.id);
    const priorities = new Map<number, number>(resolved.map((r) => [r.id, r.priority]));
    const preferredId =
      pickPrimaryId(memberIds, {
        primaryManualIds: resolved.filter((r) => r.primaryManual).map((r) => r.id),
        priorities,
      }) ?? ownerCard?.id ?? memberIds[0]!;
    const primaryCard = resolved.find((r) => r.id === preferredId) ?? ownerCard ?? resolved[0]!;

    // 账单级年费金额与卡片级年费日分开处理；这里只计算实际年费金额。
    const annualFeeAmount = detectAnnualFeeAmount(bill.transactions);

    // 历史账单自动已还：还款日已过（今天之前）必然已结清；当期/未来账单保持 unpaid
    const autoPaid = bill.amount <= 0 || dueDate.getTime() < shanghaiMidnight(new Date()).getTime();

    const billOwnerId = ownerCard?.id ?? primaryCard.id;
    const currency = normalizeCurrency(bill.currency);
    const existingBill = await tx.bill.findUnique({
      where: { cardId_period_currency: { cardId: billOwnerId, period, currency } },
      select: { id: true },
    });
    const billRow = await tx.bill.upsert({
      where: { cardId_period_currency: { cardId: billOwnerId, period, currency } },
      create: {
        cardId: billOwnerId,
        period,
        cycleStartDate: bill.cycleStartDate ? shanghaiMidnight(bill.cycleStartDate) : null,
        statementDate,
        dueDate,
        amount: bill.amount,
        minAmount: bill.minAmount ?? null,
        currency,
        mailLogId,
        hasDetails: (bill.transactions?.length ?? 0) > 0,
        annualFeeAmount,
        source: 'email',
        paidStatus: autoPaid ? 'paid' : 'unpaid',
        paidAt: autoPaid ? dueDate : null,
        paidAmount: autoPaid ? (bill.amount ?? null) : null,
      },
      update: {
        cycleStartDate: bill.cycleStartDate ? shanghaiMidnight(bill.cycleStartDate) : null,
        statementDate,
        dueDate,
        amount: bill.amount,
        minAmount: bill.minAmount ?? null,
        currency,
        mailLogId,
        hasDetails: (bill.transactions?.length ?? 0) > 0,
        annualFeeAmount,
        source: 'email',
        // 历史账单（还款日已过）强制已还；当期账单保留用户手动标记的还款状态
        ...(autoPaid ? { paidStatus: 'paid' as const, paidAt: dueDate, paidAmount: bill.amount ?? null } : {}),
      },
    });

    // 阶段 3.5：priority 累加写入（按金额、不按笔数；同期幂等；手动钉住照样更新）
    if (!existingBill) {
      const txns = bill.transactions ?? [];
      const deltas = new Map<number, number>();
      if (txns.length > 0) {
        const byTail = new Map<string, number>();
        for (const t of txns) {
          const tTail = t.cardLast4;
          if (!tTail) continue;
          // 只加正数消费和费用：还款 / 返还 / 冲抵等负数与 0 一律不计入，不反向抹低优先级
          if (!(t.amount > 0)) continue;
          byTail.set(tTail, (byTail.get(tTail) ?? 0) + t.amount);
        }
        for (const row of resolved) {
          const delta = byTail.get(row.tail);
          if (delta != null) deltas.set(row.id, delta);
        }
        // 无卡号交易（费用行/分期）不单独加分；各卡只加自己带卡尾的金额
      } else {
        deltas.set(billOwnerId, bill.amount);
      }
      for (const [cardId, delta] of deltas) {
        const row = resolved.find((r) => r.id === cardId);
        const next = (row?.priority ?? 0) + delta;
        await tx.card.update({ where: { id: cardId }, data: { priority: next } });
        if (row) row.priority = next;
      }
    }

    // 阶段 4：无卡号交易（分期/费用行）挂优先显示卡——写入 BillCard 关联
    const cardIds = Array.from(new Set([...memberIds, preferredId]));
    if (cardIds.length > 1 || (await tx.billCard.count({ where: { billId: billRow.id } })) !== cardIds.length) {
      await tx.billCard.deleteMany({ where: { billId: billRow.id } });
      await tx.billCard.createMany({
        data: cardIds.map((cardId) => ({ billId: billRow.id, cardId })),
      });
    }

    // 阶段 4.5：明细跟随独立币种账单持久化；账户级行挂套卡优先显示卡；年费日复用同一归属。
    const cardByTail = new Map(resolved.map((row) => [row.tail, row.id] as const));
    const transactions = bill.transactions ?? [];
    for (const transaction of transactions) {
      const transactionCurrency = normalizeCurrency(transaction.currency ?? currency);
      if (transactionCurrency !== currency) {
        throw new Error(
          `${bill.bankName}(${bill.cardLast4}) ${period} ${currency} 账单包含 ${transactionCurrency} 入账明细`,
        );
      }
    }
    const resolvedTransactions: ResolvedBillTransaction[] = transactions.map((transaction, sequence) => {
      const rawTail = transaction.cardLast4 ?? null;
      const explicitTail = rawTail && !isPlaceholderTail(rawTail) ? rawTail : null;
      const transactionCardId = explicitTail ? cardByTail.get(explicitTail) : preferredId;
      if (explicitTail && transactionCardId == null) {
        throw new Error(
          `${bill.bankName}(${bill.cardLast4}) ${period} 明细卡尾 ${explicitTail} 未进入账单套卡`,
        );
      }
      const cardId = transactionCardId ?? preferredId;
      const snapshotTail = explicitTail ?? resolved.find((row) => row.id === cardId)?.tail ?? primaryCard.tail;
      const transactionDate = normalizeTransactionDate(transaction.date, statementDate);
      const originalAmount = transaction.originalAmount ?? null;
      const originalCurrency = transaction.originalCurrency
        ? normalizeCurrency(transaction.originalCurrency)
        : null;
      const hasUsefulOriginalAmount = originalAmount != null
        && originalCurrency != null
        && (originalCurrency !== currency || Math.abs(originalAmount) !== Math.abs(transaction.amount));
      return {
        source: transaction,
        cardId,
        transactionDate,
        data: {
          billId: billRow.id,
          bankName: bill.bankName,
          cardId,
          cardLast4: snapshotTail,
          transactionDate,
          dateText: transaction.date?.slice(0, 32) ?? null,
          description: transaction.description.slice(0, 512),
          amount: transaction.amount,
          currency,
          originalAmount: hasUsefulOriginalAmount ? originalAmount : null,
          originalCurrency: hasUsefulOriginalAmount ? originalCurrency : null,
          sequence,
        },
      };
    });
    await tx.billTransaction.deleteMany({ where: { billId: billRow.id } });
    if (resolvedTransactions.length > 0) {
      await tx.billTransaction.createMany({ data: resolvedTransactions.map((transaction) => transaction.data) });
    }
    await updateAnnualFeeDatesFromTransactions(tx, bill.bankName, resolved, resolvedTransactions);
    await tx.bill.update({
      where: { id: billRow.id },
      data: { hasDetails: transactions.length > 0 },
    });

    // 阶段 5：未完善占位卡隐藏——同账期出现其他带真实尾号的卡时隐藏，不删卡不改挂
    const hasRealTail = tails.some((t) => !isPlaceholderTail(t));
    if (hasRealTail) {
      const unfinished = await tx.card.findMany({
        where: {
          bankName: bill.bankName,
          cardLast4: { in: [UNKNOWN_CARD_TAIL, '0000'] },
          displayLast4: UNKNOWN_CARD_TAIL,
          hidden: false,
        },
      });
      const resolvedIds = new Set(resolved.map((r) => r.id));
      for (const ph of unfinished) {
        if (resolvedIds.has(ph.id)) continue;
        const samePeriod = await tx.bill.findFirst({
          where: { cardId: ph.id, period },
          select: { id: true },
        });
        if (!samePeriod) continue;
        await tx.card.update({ where: { id: ph.id }, data: { hidden: true, isPrimary: false, primaryManual: false } });
        console.log(`[pipeline] 未完善占位卡隐藏: ${bill.bankName}(${ph.cardLast4}) id=${ph.id}`);
      }
    }

    return { id: billRow.id, currency, preferredId, cardByTail };
}

/** 按已解析的明细归属更新各卡年费日；多卡账单不再统一挂到账单承接卡。 */
async function updateAnnualFeeDatesFromTransactions(
  tx: Prisma.TransactionClient,
  bankName: string,
  cards: ResolvedCard[],
  transactions: ResolvedBillTransaction[],
): Promise<void> {
  const latestByCard = new Map<number, Date>();
  for (const transaction of transactions) {
    if (!isAnnualFeeDateEvidence(transaction.source)) continue;
    if (!transaction.transactionDate) {
      console.log(
        `[pipeline] 年费收取日跳过: ${bankName}(${transaction.data.cardLast4 ?? UNKNOWN_CARD_TAIL}) 交易日不可解析`,
      );
      continue;
    }
    const current = latestByCard.get(transaction.cardId);
    if (!current || transaction.transactionDate > current) {
      latestByCard.set(transaction.cardId, transaction.transactionDate);
    }
  }

  for (const [cardId, latest] of latestByCard) {
    const card = cards.find((row) => row.id === cardId);
    if (!card || card.annualFeeDateManual) continue;
    const current = card.annualFeeDate;
    if (current && ymd(current).slice(5) === ymd(latest).slice(5)) continue;
    if (current && latest <= current) continue;
    await tx.card.update({ where: { id: cardId }, data: { annualFeeDate: latest } });
    card.annualFeeDate = latest;
    console.log(`[pipeline] 年费收取日识别: ${bankName}(${card.tail}) ${ymd(latest)}`);
  }
}

/**
 * 招商正式账单接管同一账期的日度交易。
 * 正式明细存在时整段替换；正式账单无明细时把日度交易转入正式期次。
 */
async function reconcileCurrentCycleTransactions(
  tx: Prisma.TransactionClient,
  bills: ParsedBill[],
  applied: AppliedBill[],
): Promise<void> {
  const cycleBill = bills.find((bill) => bill.cycleStartDate != null);
  if (!cycleBill?.cycleStartDate || applied.length === 0) return;

  const bankName = cycleBill.bankName;
  const cycleStartDate = shanghaiMidnight(cycleBill.cycleStartDate);
  const statementDate = shanghaiMidnight(cycleBill.statementDate);
  const range = {
    gte: cycleStartDate,
    lte: new Date(statementDate.getTime() + 86_400_000 - 1),
  };
  const hasOfficialDetails = bills.some((bill) => (bill.transactions?.length ?? 0) > 0);

  if (hasOfficialDetails) {
    await tx.billTransaction.deleteMany({
      where: {
        billId: null,
        dailyMailLogId: { not: null },
        bankName,
        transactionDate: range,
      },
    });
    return;
  }

  const rows = await tx.billTransaction.findMany({
    where: {
      billId: null,
      dailyMailLogId: { not: null },
      bankName,
      transactionDate: range,
    },
    orderBy: [{ transactionDate: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) return;

  const fallback = applied.find((row) => row.currency === 'CNY') ?? applied[0]!;
  const nextSequence = new Map<number, number>(applied.map((row) => [row.id, 0]));
  for (const row of rows) {
    const target = applied.find((item) => item.currency === normalizeCurrency(row.currency)) ?? fallback;
    let cardId = row.cardId;
    if (row.cardLast4 && !isPlaceholderTail(row.cardLast4)) {
      cardId = target.cardByTail.get(row.cardLast4) ?? null;
      if (cardId == null) {
        const card = await tx.card.findUnique({
          where: { bankName_cardLast4: { bankName, cardLast4: row.cardLast4 } },
          select: { id: true },
        });
        cardId = card?.id ?? null;
      }
    } else {
      cardId = target.preferredId;
    }
    if (cardId != null) {
      await tx.billCard.upsert({
        where: { billId_cardId: { billId: target.id, cardId } },
        create: { billId: target.id, cardId },
        update: {},
      });
    }
    const sequence = nextSequence.get(target.id) ?? 0;
    nextSequence.set(target.id, sequence + 1);
    await tx.billTransaction.update({
      where: { id: row.id },
      data: { billId: target.id, cardId, sequence },
    });
  }
  for (const target of applied) {
    if ((nextSequence.get(target.id) ?? 0) === 0) continue;
    await tx.bill.update({ where: { id: target.id }, data: { hasDetails: true } });
  }
}

/** 日度邮件只写明细，不建账单、不建卡片。 */
export async function applyCurrentCycleTransactions(
  mailLogId: number,
  batches: ParsedCurrentCycleTransactions[],
  afterStatementDate: Date | null,
): Promise<number> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const finalized = await tx.billTransaction.count({
        where: { dailyMailLogId: mailLogId, billId: { not: null } },
      });
      if (finalized > 0) return finalized;

      await tx.billTransaction.deleteMany({ where: { dailyMailLogId: mailLogId, billId: null } });
      let created = 0;
      for (const batch of batches) {
        const eligible = batch.transactions.filter(
          (transaction) => afterStatementDate == null || transaction.transactionAt > afterStatementDate,
        );
        if (eligible.length === 0) continue;
        const cardIds = new Map<string, number>();
        for (const transaction of eligible) {
          const tail = transaction.cardLast4 ?? null;
          if (!tail || cardIds.has(tail)) continue;
          const card = await tx.card.findUnique({
            where: { bankName_cardLast4: { bankName: batch.bankName, cardLast4: tail } },
            select: { id: true },
          });
          if (card) cardIds.set(tail, card.id);
        }
        await tx.billTransaction.createMany({
          data: eligible.map((transaction, sequence) => ({
            billId: null,
            bankName: batch.bankName,
            dailyMailLogId: mailLogId,
            cardId: transaction.cardLast4 ? cardIds.get(transaction.cardLast4) ?? null : null,
            cardLast4: transaction.cardLast4 ?? null,
            transactionDate: transaction.transactionAt,
            dateText: transaction.date?.slice(0, 32) ?? null,
            description: transaction.description.slice(0, 512),
            amount: transaction.amount,
            currency: normalizeCurrency(transaction.currency),
            originalAmount: null,
            originalCurrency: null,
            sequence,
          })),
        });
        created += eligible.length;
      }
      return created;
    }),
  );
}

/** 交易日期归一化：完整日期直接解析，省略年份时取不晚于出账日的最近日期。 */
export function normalizeTransactionDate(raw: string | null | undefined, statementDate: Date): Date | null {
  if (!raw) return null;
  const full = parseDate(raw);
  if (full) return full;

  const compactWithYear = raw.trim().match(/^(\d{2})(\d{2})(\d{2})$/);
  if (compactWithYear) {
    const statementYear = Number(ymd(statementDate).slice(0, 4));
    let year = Math.floor(statementYear / 100) * 100 + Number(compactWithYear[1]);
    if (year > statementYear) year -= 100;
    return parseDate(`${year}-${compactWithYear[2]}-${compactWithYear[3]}`);
  }

  const compactMonthDay = raw.trim().match(/^(\d{2})(\d{2})$/);
  const separatedMonthDay = raw.trim().match(/^(\d{1,2})[-/.](\d{1,2})$/);
  const match = compactMonthDay ?? separatedMonthDay;
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const statementYear = Number(ymd(statementDate).slice(0, 4));
  for (const year of [statementYear, statementYear - 1]) {
    const candidate = parseDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    if (candidate && candidate <= statementDate) return candidate;
  }
  return null;
}

/** 事务写冲突（P2034）短暂退避重试：历史全量拉取与定时同步并发场景 */
async function withTransactionRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'P2034' || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1) * (i + 1)));
    }
  }
}

/** 纯函数：由账单出账日/还款日反推建卡规则 */
export function inferCardRule(statementDate: Date, dueDate: Date): {
  statementDay: number;
  dueRule: 'offset' | 'fixed';
  dueOffsetDays: number | null;
  dueDay: number | null;
} {
  const sd = shanghaiMidnight(statementDate);
  const dd = shanghaiMidnight(dueDate);
  const diff = daysBetween(sd, dd);
  return diff >= 0 && diff <= 40
    ? { statementDay: dayOf(sd), dueRule: 'offset', dueOffsetDays: diff, dueDay: null }
    : { statementDay: dayOf(sd), dueRule: 'fixed', dueOffsetDays: null, dueDay: dayOf(dd) };
}

/** 卡档案规则字段的快照（便于纯函数测试与复用） */
export interface CardRuleSnapshot {
  statementDay: number;
  dueRule: string; // 'fixed' | 'offset'
  dueDay: number | null;
  dueOffsetDays: number | null;
}

/**
 * 卡片规则与真实账单的差异检测：出账日或还款日变化时返回待更新字段，无变化返回 null。
 * 月末截断不算变化（如 31 号出账的卡在 2 月账单日落在当月最后一天）。
 */
export function diffCardRule(card: CardRuleSnapshot, statementDate: Date, dueDate: Date): Partial<CardRuleSnapshot> | null {
  const sd = shanghaiMidnight(statementDate);
  const dd = shanghaiMidnight(dueDate);
  const patch: Partial<CardRuleSnapshot> = {};

  // 1. 出账日同步
  const actualDay = dayOf(sd);
  if (actualDay !== card.statementDay) {
    const { year, month } = monthParts(sd);
    const monthEndClamped = actualDay < card.statementDay && actualDay === lastDayOfMonth(year, month);
    if (!monthEndClamped) patch.statementDay = actualDay;
  }

  // 2. 还款规则同步：现有规则按本次出账日推算的还款日与实际不符时，以账单为准重推规则
  const predicted = predictDueDate(card, sd);
  if (!predicted || !sameDay(predicted, dd)) {
    const rule = inferCardRule(sd, dd);
    patch.dueRule = rule.dueRule;
    patch.dueOffsetDays = rule.dueOffsetDays;
    patch.dueDay = rule.dueDay;
  }

  return Object.keys(patch).length ? patch : null;
}

/** 按现有规则由出账日推算还款日（fixed 规则的还款日早于出账日时属次月，如每月19日出账、次月8日还款） */
function predictDueDate(card: CardRuleSnapshot, statementDate: Date): Date | null {
  if (card.dueRule === 'fixed' && card.dueDay != null) return computeRuleDueDate(card, statementDate);
  if (card.dueRule === 'offset' && card.dueOffsetDays != null) return computeRuleDueDate(card, statementDate);
  return null;
}
