import { findUnfinishedPlaceholderCardIds, reconcileUnfinishedPlaceholderCards } from '../../../lib/card-placeholders';
import { recomputePrimary } from '../../../lib/card-groups';
import type { VersionMigration } from '../migration.types';

export const hideResolvedPlaceholdersMigration: VersionMigration = {
  key: 'hide-resolved-placeholders-v1',
  targetVersion: '0.3.2',
  order: 10,
  mode: 'silent',
  title: '隐藏已有真实卡承接的占位卡',
  description: '同银行已有同出账日和还款规则真实卡时，隐藏未完善占位卡，历史账单及其归属保持不变。',
  async inspect(db) {
    const ids = await findUnfinishedPlaceholderCardIds(db);
    return ids.length > 0 ? { total: ids.length, payload: { cardIds: ids } } : null;
  },
  async executeSilent(tx) {
    const result = await reconcileUnfinishedPlaceholderCards(tx);
    if (result.hiddenCardIds.length > 0) await recomputePrimary(tx);
    return { succeeded: result.hiddenCardIds.length, unchanged: 0, failed: 0 };
  },
};
