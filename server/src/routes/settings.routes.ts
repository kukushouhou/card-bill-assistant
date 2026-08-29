import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { ApiError, asyncHandler } from '../lib/errors';
import { prisma } from '../lib/prisma';
import {
  getLegacyCompatibleBarkUrl,
  getNotificationSettings,
  LEGACY_BARK_URL_KEY,
  NOTIFICATION_CHANNELS_INITIALIZED_KEY,
  removeNotificationChannel,
  saveNotificationChannel,
  testNotificationChannel,
} from '../notify/notification.service';
import { requireAuth } from './middleware';

const router = Router();
router.use(requireAuth);

/** 兼容旧调用；新代码使用通用通知渠道接口。 */
export async function getBarkUrl(): Promise<string> {
  return getLegacyCompatibleBarkUrl();
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const notifications = await getNotificationSettings();
    res.json({
      reminderHour: config.reminderHour,
      notifications,
      // 兼容旧前端，后续版本可移除。
      barkUrl: await getLegacyCompatibleBarkUrl(),
    });
  }),
);

router.get(
  '/notification-channels',
  asyncHandler(async (_req, res) => {
    res.json(await getNotificationSettings());
  }),
);

router.put(
  '/notification-channels/:type',
  asyncHandler(async (req, res) => {
    const type = z.string().trim().min(1).max(50).parse(req.params.type);
    const input = z.object({ enabled: z.boolean().optional(), config: z.unknown() }).parse(req.body);
    res.json({ ok: true, channel: await saveNotificationChannel(type, input) });
  }),
);

router.delete(
  '/notification-channels/:type',
  asyncHandler(async (req, res) => {
    const type = z.string().trim().min(1).max(50).parse(req.params.type);
    await removeNotificationChannel(type);
    res.json({ ok: true });
  }),
);

router.post(
  '/notification-channels/:type/test',
  asyncHandler(async (req, res) => {
    const type = z.string().trim().min(1).max(50).parse(req.params.type);
    const body = z.object({ config: z.unknown().optional() }).parse(req.body ?? {});
    const result = await testNotificationChannel(type, body.config);
    if (!result.ok) throw new ApiError(502, result.error || '测试通知发送失败');
    res.json({ ok: true });
  }),
);

/**
 * 旧版设置接口兼容：继续接受 barkUrl。空字符串仍表示清除界面覆盖并回退 BARK_URL，
 * 新版“停用渠道”使用 DELETE /notification-channels/bark，不会被环境变量重新激活。
 */
router.put(
  '/',
  asyncHandler(async (req, res) => {
    const { barkUrl } = z
      .object({
        barkUrl: z
          .string()
          .trim()
          .url('推送地址格式错误，应形如 https://api.day.app/YourKey')
          .max(500)
          .or(z.literal('')),
      })
      .parse(req.body);
    if (barkUrl) {
      await saveNotificationChannel('bark', { enabled: true, config: { url: barkUrl } });
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.notificationChannel.deleteMany({ where: { type: 'bark' } });
        await tx.appSetting.deleteMany({
          where: { key: { in: [LEGACY_BARK_URL_KEY, NOTIFICATION_CHANNELS_INITIALIZED_KEY] } },
        });
      });
    }
    res.json({ ok: true, barkUrl: await getLegacyCompatibleBarkUrl() });
  }),
);

/** 旧版连通性测试接口兼容。错误文案保持渠道中立。 */
router.post(
  '/test-bark',
  asyncHandler(async (req, res) => {
    const { barkUrl } = z.object({ barkUrl: z.string().trim().url() }).parse(req.body);
    const result = await testNotificationChannel('bark', { url: barkUrl });
    if (!result.ok) throw new ApiError(502, result.error || '测试通知发送失败');
    res.json({ ok: true });
  }),
);

export default router;
