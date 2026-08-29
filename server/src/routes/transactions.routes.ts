import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { addDays, fromYmd } from '../lib/dates';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';

const router = Router();
router.use(requireAuth);

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  bank: z.string().trim().max(64).optional(),
  cardId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(100).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const input = querySchema.parse(req.query);
    const dateFrom = input.dateFrom ? fromYmd(input.dateFrom) : undefined;
    const dateToExclusive = input.dateTo ? addDays(fromYmd(input.dateTo), 1) : undefined;
    const where = {
      ...(input.bank ? { bankName: input.bank } : {}),
      ...(input.cardId ? { cardId: input.cardId } : {}),
      ...(dateFrom || dateToExclusive
        ? {
            transactionDate: {
              ...(dateFrom ? { gte: dateFrom } : {}),
              ...(dateToExclusive ? { lt: dateToExclusive } : {}),
            },
          }
        : {}),
      ...(input.q ? { description: { contains: input.q } } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.billTransaction.count({ where }),
      prisma.billTransaction.findMany({
        where,
        include: {
          bill: { include: { card: { select: { cardLast4: true } } } },
        },
        orderBy: [
          { transactionDate: 'desc' },
          { bill: { statementDate: 'desc' } },
          { billId: 'desc' },
          { sequence: 'asc' },
        ],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
    ]);

    res.json({
      total,
      page: input.page,
      pageSize: input.pageSize,
      items: rows.map((row) => ({
        id: row.id,
        billId: row.billId,
        period: row.bill?.period ?? '未出账',
        unbilled: row.billId == null,
        bankName: row.bankName,
        cardId: row.cardId,
        cardLast4: row.cardLast4 ?? row.bill?.card.cardLast4 ?? null,
        date: row.dateText,
        transactionDate: row.transactionDate?.toISOString() ?? null,
        description: row.description,
        amount: Number(row.amount),
        currency: row.currency,
        originalAmount: row.originalAmount == null ? null : Number(row.originalAmount),
        originalCurrency: row.originalCurrency,
      })),
    });
  }),
);

export default router;
