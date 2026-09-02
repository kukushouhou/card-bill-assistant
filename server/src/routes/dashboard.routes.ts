import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import { monthParts, today } from '../lib/dates';
import { remainingOf } from '../modules/bills/paid';
import { buildLedger, type LedgerBillInput, type LedgerCard } from '../modules/bills/ledger';
import {
  ANNUAL_FEE_NOTICE_CURSOR_KEY,
  annualFeeBillCursor,
  buildAnnualFeeNotice,
  compareAnnualFeeNoticeCursor,
  parseAnnualFeeNoticeCursor,
  serializeAnnualFeeNoticeCursor,
} from '../modules/bills/annual-fee-notice';
import { buildBillsByCard, collectUpcoming, type CardLike } from '../modules/reminders/reminder.engine';
import { materializeCustomReminderOccurrences, occurrenceToView } from '../modules/reminders/custom-occurrences';

const router = Router();
router.use(requireAuth);

const acknowledgeAnnualFeeNoticeSchema = z.object({
  acknowledgeThroughBillId: z.number().int().positive(),
}).strict();

router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const now = today();
    await materializeCustomReminderOccurrences(now);
    const { year, month } = monthParts(now);
    const period = `${year}-${String(month).padStart(2, '0')}`;

    const [cards, billRows, customs, emailAccounts, customOccurrenceRows, annualFeeCursorRow] = await Promise.all([
      prisma.card.findMany(),
      prisma.bill.findMany({
        include: {
          cards: { select: { cardId: true } },
          transactions: {
            where: { description: { contains: '年费' } },
            select: {
              cardId: true,
              cardLast4: true,
              bankName: true,
              description: true,
              amount: true,
              currency: true,
            },
          },
        },
      }),
      prisma.customReminder.findMany(),
      prisma.emailAccount.findMany(),
      prisma.customReminderOccurrence.findMany({ where: { suspended: false } }),
      prisma.appSetting.findUnique({ where: { key: ANNUAL_FEE_NOTICE_CURSOR_KEY } }),
    ]);

    const activeCards = cards.filter((c) => c.status === 'active');

    // 当前待还：buildLedger 未还清全集（含逾期上期真实账单 + 未取得账单占位行）
    // 作用域与今日待办一致：hidden 卡不进台账；冻结/注销卡的真实未还清账单仍由 buildLedger 保留
    const ledgerCards: LedgerCard[] = cards.filter((c) => !c.hidden).map((c) => ({
      id: c.id,
      bankName: c.bankName,
      cardLast4: c.cardLast4,
      currency: c.currency,
      statementDay: c.statementDay,
      dueRule: c.dueRule,
      dueDay: c.dueDay,
      dueOffsetDays: c.dueOffsetDays,
      status: c.status,
      createdAt: c.createdAt,
      businessRole: c.businessRole,
      businessPrimaryId: c.businessPrimaryId,
    }));
    const ledgerBills: LedgerBillInput[] = billRows.map((b) => ({
      id: b.id,
      cardId: b.cardId,
      period: b.period,
      statementDate: b.statementDate,
      dueDate: b.dueDate,
      amount: b.amount != null ? Number(b.amount) : null,
      minAmount: b.minAmount != null ? Number(b.minAmount) : null,
      currency: b.currency,
      paidStatus: b.paidStatus,
      paidAt: b.paidAt,
      paidAmount: b.paidAmount != null ? Number(b.paidAmount) : null,
      hasDetails: b.hasDetails,
      annualFeeAmount: b.annualFeeAmount != null ? Number(b.annualFeeAmount) : null,
      source: b.source,
      linkedCardIds: [b.cardId, ...b.cards.map((bc) => bc.cardId)].filter(
        (id, idx, arr) => arr.indexOf(id) === idx,
      ),
    }));
    const unpaidLedger = buildLedger(ledgerCards, ledgerCards, ledgerBills, now)
      .filter((row) => row.paidStatus !== 'paid');
    const unpaidCustomBills = customOccurrenceRows.filter((row) =>
      (row.businessType === 'fixed_bill' || row.businessType === 'dynamic_bill')
      && row.status !== 'paid',
    );
    const byCurrency = new Map<string, { unpaidCount: number; unpaidTotal: number; annualFeeTotal: number }>();
    let unknownAmountCount = 0;
    let annualFeeCount = 0;
    for (const row of unpaidLedger) {
      const entry = byCurrency.get(row.currency) ?? { unpaidCount: 0, unpaidTotal: 0, annualFeeTotal: 0 };
      entry.unpaidCount++;
      entry.unpaidTotal += remainingOf({
        amount: row.amount,
        paidStatus: row.paidStatus ?? 'unpaid',
        paidAmount: row.paidAmount,
      });
      if (row.amount == null) unknownAmountCount++;
      if (row.annualFeeAmount != null && row.annualFeeAmount > 0) {
        entry.annualFeeTotal += row.annualFeeAmount;
        annualFeeCount++;
      }
      byCurrency.set(row.currency, entry);
    }
    for (const row of unpaidCustomBills) {
      const entry = byCurrency.get('CNY') ?? { unpaidCount: 0, unpaidTotal: 0, annualFeeTotal: 0 };
      entry.unpaidCount++;
      if (row.amount == null) {
        unknownAmountCount++;
      } else {
        entry.unpaidTotal += remainingOf({
          amount: Number(row.amount),
          paidStatus: 'unpaid',
          paidAmount: null,
        });
      }
      byCurrency.set('CNY', entry);
    }
    const totalsByCurrency = [...byCurrency.entries()]
      .map(([currency, entry]) => ({
        currency,
        unpaidCount: entry.unpaidCount,
        unpaidTotal: Math.round(entry.unpaidTotal * 100) / 100,
        annualFeeTotal: Math.round(entry.annualFeeTotal * 100) / 100,
      }))
      .sort((a, b) => (a.currency === 'CNY' ? -1 : b.currency === 'CNY' ? 1 : a.currency.localeCompare(b.currency)));
    const cny = totalsByCurrency.find((entry) => entry.currency === 'CNY');
    const annualFeeNotice = buildAnnualFeeNotice(
      billRows,
      cards,
      parseAnnualFeeNoticeCursor(annualFeeCursorRow?.value),
    );

    // 即将到期视图（14 天，合并账单按关联分桶）
    const billsByCard = buildBillsByCard(billRows);
    const upcoming = collectUpcoming(
      cards.map((c) => ({ ...c, remindDaysBefore: (c.remindDaysBefore as number[]) ?? [3, 1, 0] }) as CardLike),
      billsByCard,
      customs.map((r) => ({
        ...r,
        daysBefore: (r.daysBefore as number[]) ?? [],
        fixedAmount: r.fixedAmount == null ? null : Number(r.fixedAmount),
      })),
      now,
      14,
      customOccurrenceRows.map(occurrenceToView),
    );

    res.json({
      date: now.toISOString(),
      cards: {
        total: cards.length,
        active: activeCards.length,
        withSecret: cards.filter((c) => c.cardNoFullEnc || c.expDateEnc || c.cvvEnc).length,
      },
      currentPeriod: {
        period,
        bills: unpaidLedger.length + unpaidCustomBills.length,
        unpaidCount: unpaidLedger.length + unpaidCustomBills.length,
        unpaidTotal: cny?.unpaidTotal ?? 0,
        totalsByCurrency,
        unknownAmountCount,
        annualFeeCount,
        annualFeeTotal: cny?.annualFeeTotal ?? 0,
        currency: 'CNY',
      },
      annualFeeNotice,
      upcoming14d: {
        dueCount: upcoming.filter((i) =>
          (i.type === 'due' && !i.paid)
          || (i.type === 'custom' && (i.customBusinessType === 'fixed_bill' || i.customBusinessType === 'dynamic_bill')),
        ).length,
        statementCount: upcoming.filter((i) => i.type === 'statement').length,
        feeCount: upcoming.filter((i) => i.type === 'fee').length,
        customCount: upcoming.filter((i) => i.type === 'custom').length,
      },
      email: {
        total: emailAccounts.length,
        enabled: emailAccounts.filter((a) => a.enabled).length,
        lastSyncAt: emailAccounts.reduce<Date | null>(
          (latest, a) => (!a.lastSyncAt ? latest : !latest || a.lastSyncAt > latest ? a.lastSyncAt : latest),
          null,
        )?.toISOString() ?? null,
      },
      customs: { total: customs.length, enabled: customs.filter((c) => c.enabled).length },
    });
  }),
);

router.post(
  '/annual-fee-notice/acknowledge',
  asyncHandler(async (req, res) => {
    const input = acknowledgeAnnualFeeNoticeSchema.parse(req.body);
    const [targetBill, cursorRow] = await Promise.all([
      prisma.bill.findUnique({
        where: { id: input.acknowledgeThroughBillId },
        select: { id: true, createdAt: true, annualFeeAmount: true },
      }),
      prisma.appSetting.findUnique({ where: { key: ANNUAL_FEE_NOTICE_CURSOR_KEY } }),
    ]);
    if (!targetBill || targetBill.annualFeeAmount == null || Number(targetBill.annualFeeAmount) <= 0) {
      throw new ApiError(409, '年费提醒已更新，请刷新后重试');
    }

    const existingCursor = parseAnnualFeeNoticeCursor(cursorRow?.value);
    const targetCursor = annualFeeBillCursor(targetBill);
    if (existingCursor && compareAnnualFeeNoticeCursor(targetCursor, existingCursor) <= 0) {
      res.json({ ok: true, updated: false });
      return;
    }

    // 点击期间账单可能已经还款；只让仍未还的年费账单推动游标。
    const eligibleRows = await prisma.bill.findMany({
      where: {
        annualFeeAmount: { gt: 0 },
        paidStatus: { notIn: ['partial', 'paid'] },
      },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const acknowledgeable = eligibleRows.filter((bill) => {
      const candidate = annualFeeBillCursor(bill);
      return (!existingCursor || compareAnnualFeeNoticeCursor(candidate, existingCursor) > 0)
        && compareAnnualFeeNoticeCursor(candidate, targetCursor) <= 0;
    });
    const nextCursorBill = acknowledgeable[acknowledgeable.length - 1];
    if (!nextCursorBill) {
      res.json({ ok: true, updated: false });
      return;
    }

    const nextValue = serializeAnnualFeeNoticeCursor(annualFeeBillCursor(nextCursorBill));
    // 单条原子写确保多标签页同时确认时游标只向后推进。
    await prisma.$executeRaw`
      INSERT INTO \`AppSetting\` (\`key\`, \`value\`)
      VALUES (${ANNUAL_FEE_NOTICE_CURSOR_KEY}, ${nextValue})
      ON DUPLICATE KEY UPDATE \`value\` =
        CASE WHEN \`value\` < ${nextValue} THEN ${nextValue} ELSE \`value\` END
    `;
    res.json({ ok: true, updated: true, acknowledgeThroughBillId: nextCursorBill.id });
  }),
);

export default router;
