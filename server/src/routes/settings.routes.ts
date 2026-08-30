import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { ApiError, asyncHandler } from '../lib/errors';
import {
  getNotificationSettings,
  removeNotificationChannel,
  saveNotificationChannel,
  testNotificationChannel,
} from '../notify/notification.service';
import { requireAuth } from './middleware';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const notifications = await getNotificationSettings();
    res.json({
      reminderHour: config.reminderHour,
      notifications,
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

export default router;
