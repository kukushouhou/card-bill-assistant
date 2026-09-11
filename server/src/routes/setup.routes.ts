import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { config } from '../config';
import { derivePinKey, makePinVerifier, randomBytes } from '../lib/crypto';
import { listNotificationProviderDefinitions } from '../notify/registry';
import { notificationCreateSchema, prepareNotificationChannel } from '../notify/notification.service';
import { APP_VERSION } from '../version';
import { APPLIED_SKIN_KEY, BUILTIN_IDS, DEFAULT_SKIN } from '../modules/skins/manifest';
import { skins } from '../modules/skins/service';
import { SESSION_VERSION_KEY } from '../modules/auth/session';
import { DEFAULT_OVERDUE_BASIS, OVERDUE_BASIS_KEY } from '../modules/bills/paid';

/**
 * 安装向导路由（免认证）：
 * - GET  /status  安装状态 + 数据库连通性（前端据此决定是否进入向导）
 * - POST /install 设置管理员密码（可选同时设置卡信息加密 PIN）完成安装；已安装后永久 403，杜绝重装提权
 *
 * 安装标记：AppSetting.installedAt（ISO 时间字符串）
 */

const router = Router();
const INSTALLED_AT_KEY = 'installedAt';

async function getInstalledAt(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: INSTALLED_AT_KEY } });
  return row?.value ?? null;
}

router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    let dbOk = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbOk = false;
    }
    let installed = false;
    let installedAt: string | null = null;
    if (dbOk) {
      installedAt = await getInstalledAt();
      installed = !!installedAt;
    }
    res.json({ installed, dbOk, installedAt, notificationProviders: listNotificationProviderDefinitions() });
  }),
);

const installSchema = z.object({
  skinId: z.string().optional(),
  password: z.string({ error: '请输入密码' }).min(8, '密码长度至少 8 位').max(72, '密码过长')
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, '密码不能超过 72 个字节'),
  // PIN 可跳过；填写则必须为 6 位数字
  pin: z.union([z.literal(''), z.string().regex(/^\d{6}$/, 'PIN 必须为 6 位数字')]).optional(),
  notifications: z.array(notificationCreateSchema).max(20).optional(),
  overdueBasis: z.enum(['all', 'minimum']).optional(),
});

router.post(
  '/install',
  asyncHandler(async (req, res) => {
    // 已安装时先拒绝，避免匿名请求反复触发通知配置处理和皮肤读取。
    if (await getInstalledAt()) throw new ApiError(403, '系统已安装，如需重置请查阅部署文档');
    const { password, pin: rawPin, notifications = [], skinId, overdueBasis } = installSchema.parse(req.body ?? {});
    if (skinId && !BUILTIN_IDS.has(skinId)) throw new ApiError(400, '请选择可用的内置皮肤');
    if (skinId) await skins.read(skinId, DEFAULT_SKIN.version);
    const pin = rawPin || null;
    const parsedNotifications = notifications.map(prepareNotificationChannel);

    const adminCount = await prisma.admin.count();
    if (adminCount > 0) {
      throw new ApiError(409, '检测到已存在管理员账户但无安装标记（数据异常），请检查数据库');
    }

    await prisma.$transaction(async (tx) => {
      // 并发防护：事务内二次确认
      const again = await tx.appSetting.findUnique({ where: { key: INSTALLED_AT_KEY } });
      if (again) throw new ApiError(403, '系统已安装');
      const pinSalt = pin ? randomBytes(16) : null;
      const pinVerifier = pin ? makePinVerifier(derivePinKey(config.encryptionKey, pin, pinSalt!)) : null;
      await tx.admin.create({
        data: {
          username: 'admin',
          passwordHash: await bcrypt.hash(password, 10),
          pinSalt,
          pinVerifier,
        },
      });
      await tx.appSetting.create({
        data: { key: INSTALLED_AT_KEY, value: new Date().toISOString() },
      });
      await tx.appSetting.create({ data: { key: 'installedVersion', value: APP_VERSION } });
      await tx.appSetting.create({ data: { key: SESSION_VERSION_KEY, value: randomUUID() } });
      await tx.appSetting.create({ data: { key: OVERDUE_BASIS_KEY, value: overdueBasis ?? DEFAULT_OVERDUE_BASIS } });
      if (skinId) await tx.appSetting.create({ data: { key: APPLIED_SKIN_KEY, value: JSON.stringify({ id: skinId, version: DEFAULT_SKIN.version }) } });
      for (const data of parsedNotifications) {
        await tx.notificationChannel.create({ data });
      }
    });

    console.log(`[setup] 安装完成：管理员账户 admin 已创建${pin ? '（含 PIN）' : ''}`);
    res.json({ ok: true });
  }),
);

export default router;
