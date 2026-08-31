import { Router } from 'express';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import {
  getPendingUpgradeTask,
  skipUpgradeTask,
  startUpgradeTask,
} from '../modules/upgrades/upgrade.service';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await getPendingUpgradeTask());
}));

router.post('/:key/run', asyncHandler(async (req, res) => {
  res.status(202).json(await startUpgradeTask(String(req.params.key)));
}));

router.post('/:key/skip', asyncHandler(async (req, res) => {
  await skipUpgradeTask(String(req.params.key));
  res.json({ ok: true });
}));

export default router;
