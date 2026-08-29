import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import {
  encryptAuthPassword,
  syncAccount,
  testConnection,
  dryRunParse,
  fetchMailBody,
  resyncAccount,
  getHistorySyncState,
  startHistorySync,
  type EmailAccountParams,
} from '../modules/email/email.service';
import { listParsers } from '../parsers/registry';

const router = Router();
router.use(requireAuth);

const accountSchema = z.object({
  email: z.string().trim().email('邮箱地址格式错误'),
  imapHost: z.string().trim().min(1, 'IMAP 服务器不能为空'),
  imapPort: z.number().int().min(1).max(65535).default(993),
  tls: z.boolean().default(true),
  authUser: z.string().trim().min(1, '登录账号不能为空'),
  authPassword: z.string().min(1, '授权码不能为空'),
});

// ===== 邮箱账户 CRUD =====

router.get(
  '/accounts',
  asyncHandler(async (_req, res) => {
    const accounts = await prisma.emailAccount.findMany({ orderBy: { id: 'asc' } });
    res.json(
      accounts.map((a) => ({
        id: a.id,
        email: a.email,
        imapHost: a.imapHost,
        imapPort: a.imapPort,
        tls: a.tls,
        authUser: a.authUser,
        enabled: a.enabled,
        lastUid: a.lastUid,
        lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
        syncDaysBack: a.syncDaysBack,
      })),
    );
  }),
);

// 新增（可选 ?test=1 先测试连接再落库）
router.post(
  '/accounts',
  asyncHandler(async (req, res) => {
    const input = accountSchema.parse(req.body);
    const exists = await prisma.emailAccount.findFirst({ where: { email: input.email } });
    if (exists) throw new ApiError(409, '该邮箱账户已存在');

    if (req.query.test === '1') {
      await testConnection(input);
    }
    const account = await prisma.emailAccount.create({
      data: {
        email: input.email,
        imapHost: input.imapHost,
        imapPort: input.imapPort,
        tls: input.tls,
        authUser: input.authUser,
        authPasswordEnc: encryptAuthPassword(input.authPassword),
      },
    });
    res.status(201).json({ id: account.id });
  }),
);

// 更新（authPassword 可选；syncDaysBack / enabled 可改）
router.put(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) throw new ApiError(404, '邮箱账户不存在');
    const input = accountSchema.partial().parse(req.body);

    if (input.email && input.email !== account.email) {
      const dup = await prisma.emailAccount.findFirst({ where: { email: input.email } });
      if (dup) throw new ApiError(409, '该邮箱已被其他账户使用');
    }
    await prisma.emailAccount.update({
      where: { id },
      data: {
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.imapHost !== undefined ? { imapHost: input.imapHost } : {}),
        ...(input.imapPort !== undefined ? { imapPort: input.imapPort } : {}),
        ...(input.tls !== undefined ? { tls: input.tls } : {}),
        ...(input.authUser !== undefined ? { authUser: input.authUser } : {}),
        ...(input.authPassword !== undefined
          ? { authPasswordEnc: encryptAuthPassword(input.authPassword) }
          : {}),
      },
    });
    res.json({ ok: true });
  }),
);

router.delete(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) throw new ApiError(404, '邮箱账户不存在');
    await prisma.emailAccount.delete({ where: { id } });
    res.json({ ok: true });
  }),
);

// 启用/停用
router.put(
  '/accounts/:id/enabled',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const account = await prisma.emailAccount.findUnique({ where: { id } });
    if (!account) throw new ApiError(404, '邮箱账户不存在');
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await prisma.emailAccount.update({ where: { id }, data: { enabled } });
    res.json({ ok: true });
  }),
);

// 连接测试（用请求参数，不落库）
router.post(
  '/accounts/test',
  asyncHandler(async (req, res) => {
    const input = accountSchema.parse(req.body);
    const result = await testConnection(input);
    res.json(result);
  }),
);

// 手动同步
router.post(
  '/accounts/:id/sync',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const summary = await syncAccount(id);
    res.json(summary);
  }),
);

// ===== 同步日志 =====

router.get(
  '/logs',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    // 默认排除未匹配，includeUnmatched=1 时才展示
    const includeUnmatched = req.query.includeUnmatched === '1';
    const where = {
      ...(accountId ? { accountId } : {}),
      ...(status ? { status } : includeUnmatched ? {} : { status: { notIn: ['unmatched'] } }),
    };

    const [total, logs] = await Promise.all([
      prisma.mailLog.count({ where }),
      prisma.mailLog.findMany({
        where,
        include: { bills: { select: { id: true }, orderBy: { id: 'asc' } } },
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    res.json({
      total,
      page,
      pageSize,
      items: logs.map((l) => ({
        id: l.id,
        accountId: l.accountId,
        uid: l.uid,
        fromAddress: l.fromAddress,
        subject: l.subject,
        mailDate: l.mailDate.toISOString(),
        status: l.status,
        parserId: l.parserId,
        billIds: l.bills.map((bill) => bill.id),
        error: l.error,
        processedAt: l.processedAt.toISOString(),
      })),
    });
  }),
);

// ===== 解析器中心 =====

// 已注册解析器列表
router.get(
  '/parsers',
  asyncHandler(async (_req, res) => {
    res.json(
      listParsers().map((p) => ({
        id: p.id,
        bankName: p.bankName,
        senderPatterns: p.senderPatterns,
        subjectPatterns: p.subjectPatterns?.map((re) => re.source) ?? [],
      })),
    );
  }),
);

// 解析器干跑：从指定邮箱拉最近 N 封（或近 N 天，limit 上限 1000）邮件实跑解析，不落库
router.post(
  '/dry-run',
  asyncHandler(async (req, res) => {
    const { accountId, limit, parserId, sinceDays } = z
      .object({
        accountId: z.number().int().positive(),
        limit: z.number().int().min(1).max(1000).default(20),
        parserId: z.string().optional(),
        sinceDays: z.number().int().min(1).max(365).optional(),
      })
      .parse(req.body ?? {});
    const result = await dryRunParse(accountId, limit, parserId, sinceDays);
    res.json(result);
  }),
);

// 实时读取单封邮件正文（不落库），供解析器调试
router.get(
  '/accounts/:id/messages/:uid',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) throw new ApiError(400, '非法 UID');
    res.json(await fetchMailBody(id, uid));
  }),
);

// 重新同步：清除同步日志并重置游标，重新拉取近 N 天邮件（解析器上新后回灌历史）
router.post(
  '/accounts/:id/resync',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const summary = await resyncAccount(id);
    res.json(summary);
  }),
);

// 历史拉取：全量拉取邮箱全部历史邮件（后台任务，前端轮询进度）
router.post(
  '/accounts/:id/history-sync',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const state = await startHistorySync(id);
    res.status(202).json(state);
  }),
);

// 历史拉取进度查询
router.get(
  '/accounts/:id/history-sync',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    res.json(getHistorySyncState(id));
  }),
);

export default router;
