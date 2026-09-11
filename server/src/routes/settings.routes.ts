import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { ApiError, asyncHandler } from '../lib/errors';
import { OVERDUE_BASIS_KEY, readOverdueBasis } from '../modules/bills/paid';
import {
  createNotificationChannel, getNotificationSettings, notificationCreateSchema, notificationUpdateSchema,
  removeNotificationChannel, testNotificationChannel, testNotificationConfig, updateNotificationChannel,
} from '../notify/notification.service';
import type { NotificationSendResult } from '../notify/types';
import { requireAuth } from './middleware';

const router = Router();
router.use(requireAuth);
const channelId = z.coerce.number().int().positive();
const overdueBasisSchema = z.object({ basis: z.enum(['all', 'minimum']) });
function ensureSent(result: NotificationSendResult) {
  if (!result.ok) throw new ApiError(502, result.error || '测试通知发送失败');
}
router.get('/', asyncHandler(async (_req, res) => {
  res.json({ reminderHour: config.reminderHour, overdueBasis: await readOverdueBasis(prisma), notifications: await getNotificationSettings() });
}));
router.put('/overdue-basis', asyncHandler(async (req, res) => {
  const { basis } = overdueBasisSchema.parse(req.body);
  await prisma.appSetting.upsert({
    where: { key: OVERDUE_BASIS_KEY },
    create: { key: OVERDUE_BASIS_KEY, value: basis },
    update: { value: basis },
  });
  res.json({ ok: true, overdueBasis: basis });
}));
router.get('/notification-channels', asyncHandler(async (_req, res) => {
  res.json(await getNotificationSettings());
}));
router.post('/notification-channels', asyncHandler(async (req, res) => {
  res.status(201).json({ ok: true, channel: await createNotificationChannel(notificationCreateSchema.parse(req.body)) });
}));
router.put('/notification-channels/:id', asyncHandler(async (req, res) => {
  res.json({ ok: true, channel: await updateNotificationChannel(channelId.parse(req.params.id), notificationUpdateSchema.parse(req.body)) });
}));
router.delete('/notification-channels/:id', asyncHandler(async (req, res) => {
  await removeNotificationChannel(channelId.parse(req.params.id));
  res.json({ ok: true });
}));
router.post('/notification-channels/test', asyncHandler(async (req, res) => {
  const values = notificationCreateSchema.parse(req.body);
  ensureSent(await testNotificationConfig(values.type, values.config, values.name));
  res.json({ ok: true });
}));
router.post('/notification-channels/:id/test', asyncHandler(async (req, res) => {
  ensureSent(await testNotificationChannel(channelId.parse(req.params.id)));
  res.json({ ok: true });
}));
export default router;
