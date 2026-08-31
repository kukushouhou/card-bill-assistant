import { Router } from 'express';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import {
  approveUpgradeTask,
  getUpgradePlan,
  ignoreUpgradeTask,
} from '../modules/upgrades/upgrade.service';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await getUpgradePlan());
}));

router.post('/:key/approve', asyncHandler(async (req, res) => {
  res.status(202).json(await approveUpgradeTask(String(req.params.key)));
}));

router.post('/:key/ignore', asyncHandler(async (req, res) => {
  res.json(await ignoreUpgradeTask(String(req.params.key)));
}));

export default router;
