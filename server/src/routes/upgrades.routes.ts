import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import { latestStatementRepairResult } from '../modules/upgrades/migrations/repair-statements-050';
import {
  approveUpgradeTask,
  getUpgradePlan,
  ignoreUpgradeTask,
  submitUpgradeDecisions,
} from '../modules/upgrades/upgrade.service';

const router = Router();
router.use(requireAuth);
router.get('/latest-result', asyncHandler(async (_req, res) => {
  res.json(await latestStatementRepairResult());
}));

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await getUpgradePlan());
}));

const decisionsSchema = z.object({
  planId: z.number().int().positive(),
  decisions: z.array(z.object({ key: z.string().min(1), action: z.enum(['approve', 'ignore']) })).min(1),
});

router.post('/decisions', asyncHandler(async (req, res) => {
  const { planId, decisions } = decisionsSchema.parse(req.body);
  res.status(202).json(await submitUpgradeDecisions(planId, decisions));
}));

router.post('/:key/approve', asyncHandler(async (req, res) => {
  res.status(202).json(await approveUpgradeTask(String(req.params.key)));
}));

router.post('/:key/ignore', asyncHandler(async (req, res) => {
  res.json(await ignoreUpgradeTask(String(req.params.key)));
}));

export default router;
