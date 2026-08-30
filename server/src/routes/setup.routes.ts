import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { config } from '../config';
import { derivePinKey, makePinVerifier, randomBytes } from '../lib/crypto';
import { getNotificationProvider, listNotificationProviderDefinitions } from '../notify/registry';
import { sealNotificationConfig } from '../notify/notification-config';

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
  password: z.string({ error: '请输入密码' }).min(8, '密码长度至少 8 位').max(72, '密码过长'),
  // PIN 可跳过；填写则必须为 6 位数字
  pin: z.union([z.literal(''), z.string().regex(/^\d{6}$/, 'PIN 必须为 6 位数字')]).optional(),
  notifications: z.array(z.object({
    type: z.string().trim().min(1).max(50),
    config: z.unknown().optional(),
  })).max(20).optional(),
});

router.post(
  '/install',
  asyncHandler(async (req, res) => {
    const { password, pin: rawPin, notifications = [] } = installSchema.parse(req.body ?? {});
    const pin = rawPin || null;
    const uniqueTypes = new Set<string>();
    const parsedNotifications = notifications.map((item) => {
      if (uniqueTypes.has(item.type)) throw new ApiError(400, '同一种通知渠道只能配置一次');
      uniqueTypes.add(item.type);
      const provider = getNotificationProvider(item.type);
      if (!provider) throw new ApiError(400, '不支持所选通知渠道');
      return { provider, config: provider.parseConfig(item.config) };
    });
    if (await getInstalledAt()) throw new ApiError(403, '系统已安装，如需重置请查阅部署文档');

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
      for (const item of parsedNotifications) {
        await tx.notificationChannel.upsert({
          where: { type: item.provider.definition.type },
          create: {
            type: item.provider.definition.type,
            name: item.provider.definition.name,
            config: sealNotificationConfig(item.config) as Prisma.InputJsonObject,
            enabled: true,
          },
          update: {
            name: item.provider.definition.name,
            config: sealNotificationConfig(item.config) as Prisma.InputJsonObject,
            enabled: true,
          },
        });
      }
    });

    console.log(`[setup] 安装完成：管理员账户 admin 已创建${pin ? '（含 PIN）' : ''}`);
    res.json({ ok: true });
  }),
);

export default router;
