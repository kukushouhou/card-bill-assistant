import { Router } from 'express';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import { triggerDailyReminderNow } from '../jobs/scheduler';

const router = Router();
router.use(requireAuth);

// 手动触发今日提醒推送（幂等：已推送过的当日不会重复推）
router.post(
  '/reminders/run',
  asyncHandler(async (_req, res) => {
    const result = await triggerDailyReminderNow();
    res.json(result);
  }),
);

export default router;
