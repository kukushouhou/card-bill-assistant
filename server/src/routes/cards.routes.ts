import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import { requireValidPin } from '../modules/auth/auth.service';
import { decrypt, encrypt } from '../lib/crypto';
import { computeCycle } from '../modules/reminders/reminder.engine';
import { lastPassedCycle, openMissingCycle } from '../modules/bills/ledger';
import { fromYmd, monthParts, today } from '../lib/dates';
import { allCardGroups, recomputePrimary } from '../lib/card-groups';

const router = Router();
router.use(requireAuth);

const annualFeeDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '年费收取日格式应为 YYYY-MM-DD')
  .nullable()
  .optional();

const cardCreateSchema = z.object({
  bankName: z.string().trim().min(1, '银行名不能为空'),
  cardLast4: z.string().regex(/^\d{4}$/, '卡号后 4 位必须为 4 位数字'),
  holderName: z.string().trim().max(64).optional().nullable(),
  nickname: z.string().trim().max(32).optional().nullable(),
  currency: z.string().trim().length(3).default('CNY'),
  statementDay: z.number().int().min(1).max(31),
  dueRule: z.enum(['fixed', 'offset']),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  dueOffsetDays: z.number().int().min(0).max(40).nullable().optional(),
  remindDaysBefore: z.array(z.number().int().min(0).max(60)).default([3, 1, 0]),
  annualFeeDate: annualFeeDateSchema,
});

// 编辑接口不再接受卡号后四位：后四位只读，直调接口传入即 400 拒绝
// 使用 cardCreateSchema.partial() 让所有字段可选，移除 cardLast4，新增 status，然后 strict 拒收未知键
const cardUpdateSchema = cardCreateSchema
  .partial()
  .omit({ cardLast4: true })
  .extend({ status: z.enum(['active', 'frozen', 'closed']).optional() })
  .strict();

function validateDueRule(
  dueRule: 'fixed' | 'offset',
  dueDay: number | null | undefined,
  dueOffsetDays: number | null | undefined,
): void {
  if (dueRule === 'fixed' && !dueDay) throw new ApiError(400, '固定还款日模式下必须填写还款日（几号）');
  if (dueRule === 'offset' && (dueOffsetDays == null || dueOffsetDays < 0)) {
    throw new ApiError(400, '出账日偏移模式下必须填写还款日距出账日的天数');
  }
}

/** 列表：含敏感字段有无标记 + 当前账期推算 + 套卡分组（只看出账日与还款规则） */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const cards = await prisma.card.findMany({
      where: { hidden: false },
      orderBy: [{ bankName: 'asc' }, { cardLast4: 'asc' }],
    });
    const now = today();
    const { year, month } = monthParts(now);

    const visibleIds = new Set(cards.map((c) => c.id));
    const groups = await allCardGroups();
    const groupOfCard = new Map<number, number[]>();
    for (const members of groups.values()) {
      const visibleMembers = members.filter((id) => visibleIds.has(id));
      for (const id of visibleMembers) groupOfCard.set(id, visibleMembers);
    }

    const result = await Promise.all(
      cards.map(async (card) => {
        const calendarPeriod = `${year}-${String(month).padStart(2, '0')}`;
        const last = lastPassedCycle(card, now);
        const lastYear = Number(last.period.slice(0, 4));
        const lastMonth = Number(last.period.slice(5, 7));
        // 本期应还看上一期已过出账日；合并账单按关联查
        const periodBills = await prisma.bill.findMany({
          where: { period: last.period, OR: [{ cardId: card.id }, { cards: { some: { cardId: card.id } } }] },
          include: { cards: { select: { cardId: true } } },
          orderBy: [{ paidStatus: 'asc' }, { currency: 'asc' }, { id: 'asc' }],
        });
        const unpaidBills = periodBills.filter((bill) => bill.paidStatus !== 'paid');
        const representativeBill = unpaidBills[0] ?? periodBills[0] ?? null;
        const missing = periodBills.length === 0 && openMissingCycle(card, now)?.period === last.period;
        // 未还清或未取得走上一期；已还清且已跨月则切到日历月，避免下一还款停在过去
        const useLast = missing || (periodBills.length > 0 && (unpaidBills.length > 0 || last.period === calendarPeriod));
        const cardLike = { ...card, remindDaysBefore: card.remindDaysBefore as number[] };
        const cycle = useLast
          ? computeCycle(cardLike, lastYear, lastMonth, representativeBill)
          : computeCycle(cardLike, year, month, null);
        const period = useLast ? last.period : calendarPeriod;
        const shownBill = useLast ? representativeBill : null;
        const shownBills = useLast ? periodBills : [];
        const amountBill = useLast && (periodBills.length === 1 || unpaidBills.length === 1)
          ? representativeBill
          : null;
        const linkedCardIds = [shownBill?.cardId, ...(shownBill?.cards ?? []).map((bc) => bc.cardId)]
          .filter((id): id is number => id != null)
          .filter((id, idx, arr) => arr.indexOf(id) === idx);
        return {
          id: card.id,
          bankName: card.bankName,
          cardLast4: card.cardLast4,
          displayLast4: card.displayLast4,
          priority: card.priority,
          holderName: card.holderName,
          nickname: card.nickname,
          currency: card.currency,
          statementDay: card.statementDay,
          dueRule: card.dueRule,
          dueDay: card.dueDay,
          dueOffsetDays: card.dueOffsetDays,
          remindDaysBefore: card.remindDaysBefore,
          annualFeeDate: card.annualFeeDate?.toISOString() ?? null,
          annualFeeDateManual: card.annualFeeDateManual,
          source: card.source,
          status: card.status,
          hasSecret: !!(card.cardNoFullEnc || card.expDateEnc || card.cvvEnc),
          /** 套卡内全部卡 ID（按出账日与还款规则归组，含本卡；单卡组仅自身） */
          groupCardIds: groupOfCard.get(card.id) ?? [card.id],
          /** 套卡内优先显示卡 */
          isPrimary: card.isPrimary,
          /** 用户指定的优先显示卡 */
          primaryManual: card.primaryManual,
          /** 本卡是否承接当期账单（标识字段，不参与自动选定） */
          isBillOwner: shownBill?.cardId === card.id,
          currentCycle: {
            period,
            statementDate: cycle.statementDate.toISOString(),
            dueDate: cycle.dueDate.toISOString(),
            hasBill: shownBills.length > 0,
            missing,
            amount: amountBill?.amount != null ? Number(amountBill.amount) : null,
            minAmount: amountBill?.minAmount != null ? Number(amountBill.minAmount) : null,
            currency: amountBill?.currency ?? null,
            paidStatus: amountBill?.paidStatus ?? null,
            billCount: shownBills.length,
            unpaidBillCount: unpaidBills.length,
            /** 合并账单全部关联卡尾号（含本卡，普通账单仅本卡） */
            cardTails: linkedCardIds.map(
              (cid) => cards.find((c) => c.id === cid)?.displayLast4 ?? '',
            ).filter(Boolean),
          },
          createdAt: card.createdAt.toISOString(),
        };
      }),
    );
    res.json(result);
  }),
);

// 创建
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = cardCreateSchema.parse(req.body);
    validateDueRule(input.dueRule, input.dueDay, input.dueOffsetDays);
    const exists = await prisma.card.findUnique({
      where: { bankName_cardLast4: { bankName: input.bankName, cardLast4: input.cardLast4 } },
    });
    if (exists) throw new ApiError(409, `已存在 ${input.bankName}（${input.cardLast4}）的卡档案`);
    const card = await prisma.card.create({
      data: {
        bankName: input.bankName,
        cardLast4: input.cardLast4,
        displayLast4: input.cardLast4,
        holderName: input.holderName || null,
        nickname: input.nickname || null,
        currency: input.currency,
        statementDay: input.statementDay,
        dueRule: input.dueRule,
        dueDay: input.dueRule === 'fixed' ? input.dueDay! : null,
        dueOffsetDays: input.dueRule === 'offset' ? input.dueOffsetDays! : null,
        remindDaysBefore: input.remindDaysBefore,
        annualFeeDate: input.annualFeeDate ? fromYmd(input.annualFeeDate) : null,
        annualFeeDateManual: input.annualFeeDate ? true : false,
        source: 'manual',
      },
    });
    res.status(201).json({ id: card.id });
  }),
);

// 详情（含历史账单）
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    const bills = await prisma.bill.findMany({
      where: { OR: [{ cardId: id }, { cards: { some: { cardId: id } } }] },
      orderBy: { period: 'desc' },
      take: 24,
    });
    res.json({
      id: card.id,
      bankName: card.bankName,
      cardLast4: card.cardLast4,
      displayLast4: card.displayLast4,
      priority: card.priority,
      holderName: card.holderName,
      nickname: card.nickname,
      currency: card.currency,
      statementDay: card.statementDay,
      dueRule: card.dueRule,
      dueDay: card.dueDay,
      dueOffsetDays: card.dueOffsetDays,
      remindDaysBefore: card.remindDaysBefore,
      annualFeeDate: card.annualFeeDate?.toISOString() ?? null,
      annualFeeDateManual: card.annualFeeDateManual,
      source: card.source,
      status: card.status,
      hasSecret: !!(card.cardNoFullEnc || card.expDateEnc || card.cvvEnc),
      secretFields: {
        cardNoFull: !!card.cardNoFullEnc,
        expDate: !!card.expDateEnc,
        cvv: !!card.cvvEnc,
      },
      bills: bills.map((b) => ({
        id: b.id,
        period: b.period,
        statementDate: b.statementDate.toISOString(),
        dueDate: b.dueDate.toISOString(),
        amount: b.amount != null ? Number(b.amount) : null,
        minAmount: b.minAmount != null ? Number(b.minAmount) : null,
        currency: b.currency,
        paidStatus: b.paidStatus,
        paidAt: b.paidAt?.toISOString() ?? null,
      })),
    });
  }),
);

// 更新
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    const input = cardUpdateSchema.parse(req.body);

    const dueRule = input.dueRule ?? (card.dueRule as 'fixed' | 'offset');
    const dueDay = input.dueDay !== undefined ? input.dueDay : card.dueDay;
    const dueOffsetDays = input.dueOffsetDays !== undefined ? input.dueOffsetDays : card.dueOffsetDays;
    if (input.dueRule || input.dueDay !== undefined || input.dueOffsetDays !== undefined) {
      validateDueRule(dueRule, dueDay, dueOffsetDays);
    }

    await prisma.card.update({
      where: { id },
      data: {
        ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
        ...(input.holderName !== undefined ? { holderName: input.holderName || null } : {}),
        ...(input.nickname !== undefined ? { nickname: input.nickname || null } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.statementDay !== undefined ? { statementDay: input.statementDay } : {}),
        ...(input.dueRule !== undefined ? { dueRule: input.dueRule } : {}),
        ...(input.dueDay !== undefined ? { dueDay } : {}),
        ...(input.dueOffsetDays !== undefined ? { dueOffsetDays } : {}),
        ...(input.remindDaysBefore !== undefined ? { remindDaysBefore: input.remindDaysBefore } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.annualFeeDate !== undefined
          ? {
              annualFeeDate: input.annualFeeDate ? fromYmd(input.annualFeeDate) : null,
              // 用户手动设置/清除即置 manual 标记，自动识别不再覆盖
              annualFeeDateManual: input.annualFeeDate ? true : false,
            }
          : {}),
      },
    });
    // 出账日/还款规则变更后按当前规则重算归组；冻结/注销让位复用同一套自动主卡
    if (
      input.statementDay !== undefined ||
      input.dueRule !== undefined ||
      input.dueDay !== undefined ||
      input.dueOffsetDays !== undefined ||
      input.status !== undefined
    ) {
      await recomputePrimary();
    }
    res.json({ ok: true });
  }),
);

// 设为主卡（仅控制套卡列表哪张卡居首；单卡组无意义；仅正常使用卡可指定）
router.post(
  '/:id/primary',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    if (card.status !== 'active') throw new ApiError(400, '已冻结或已注销的卡不能设为主卡');
    const groups = await allCardGroups();
    const members = [...groups.values()].find((m) => m.includes(id));
    if (!members || members.length <= 1) {
      throw new ApiError(400, '单卡无需设为主卡');
    }
    await prisma.$transaction(
      members.map((mid) =>
        prisma.card.update({
          where: { id: mid },
          data: mid === id ? { primaryManual: true } : { primaryManual: false },
        }),
      ),
    );
    await recomputePrimary();
    res.json({ ok: true });
  }),
);

// 删除（级联删除账单）
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    await prisma.card.delete({ where: { id } });
    res.json({ ok: true });
  }),
);

// ===== 敏感信息（PIN 加密存储） =====

const secretSchema = z
  .object({
    pin: z.string().regex(/^\d{6}$/, 'PIN 必须为 6 位数字'),
    cardNoFull: z.string().regex(/^\d{13,19}$/, '卡号格式错误').optional(),
    expDate: z.string().regex(/^(0[1-9]|1[0-2])\/?\d{2}$/, '有效期格式应为 MM/YY').optional(),
    cvv: z.string().regex(/^\d{3,4}$/, 'CVV 格式错误').optional(),
  })
  .refine((v) => v.cardNoFull || v.expDate || v.cvv, { message: '至少填写一项敏感信息' });

// 保存/覆盖敏感信息（全量覆盖）
router.post(
  '/:id/secret',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    const input = secretSchema.parse(req.body);
    const key = await requireValidPin(input.pin);

    // MMYY 归一化为 MM/YY
    const expDate = input.expDate
      ? input.expDate.includes('/')
        ? input.expDate
        : `${input.expDate.slice(0, 2)}/${input.expDate.slice(2)}`
      : null;

    // 完整卡号保存闸门：按匹配尾号分闸，拒绝时不写入任何字段
    // 1) 匹配尾号已是真号：录入后四位必须与现有匹配尾号一致
    // 2) 匹配尾号是占位 + 展示尾号未完善：由完整卡号后四位写入展示尾号（仅这一次）
    // 3) 匹配尾号是占位 + 展示尾号已有四位：后四位不变（回填原值）放行，变更拒绝
    let displayLast4: string | undefined;
    if (input.cardNoFull) {
      const last4 = input.cardNoFull.slice(-4);
      const placeholder = card.cardLast4 === '----' || card.cardLast4 === '0000';
      if (!placeholder) {
        if (last4 !== card.cardLast4) {
          throw new ApiError(400, `该卡已记录的账单尾号为 ${card.cardLast4}，与本次录入的完整卡号不符`);
        }
      } else if (card.displayLast4 === '----') {
        displayLast4 = last4;
      } else if (last4 !== card.displayLast4) {
        throw new ApiError(400, `该卡已记录的账单尾号为 ${card.displayLast4}，与本次录入的完整卡号不符`);
      }
    }

    await prisma.card.update({
      where: { id },
      data: {
        cardNoFullEnc: input.cardNoFull ? encrypt(key, input.cardNoFull) : null,
        expDateEnc: expDate ? encrypt(key, expDate) : null,
        cvvEnc: input.cvv ? encrypt(key, input.cvv) : null,
        ...(displayLast4 ? { displayLast4 } : {}),
      },
    });
    res.json({ ok: true });
  }),
);

// 查看（PIN 即验即用，响应后弃）
router.post(
  '/:id/secret/view',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const card = await prisma.card.findUnique({ where: { id } });
    if (!card || card.hidden) throw new ApiError(404, '卡档案不存在');
    const pin = req.body?.pin;
    const key = await requireValidPin(pin);
    if (!card.cardNoFullEnc && !card.expDateEnc && !card.cvvEnc) {
      throw new ApiError(404, '该卡尚未录入敏感信息');
    }
    res.json({
      cardNoFull: card.cardNoFullEnc ? decrypt(key, Buffer.from(card.cardNoFullEnc)) : null,
      expDate: card.expDateEnc ? decrypt(key, Buffer.from(card.expDateEnc)) : null,
      cvv: card.cvvEnc ? decrypt(key, Buffer.from(card.cvvEnc)) : null,
    });
  }),
);

export default router;
