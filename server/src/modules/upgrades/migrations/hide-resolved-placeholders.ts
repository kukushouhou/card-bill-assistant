import { findUnfinishedPlaceholderCardIds, reconcileUnfinishedPlaceholderCards } from '../../../lib/card-placeholders';
import { recomputePrimary } from '../../../lib/card-groups';
import type { VersionMigration } from '../migration.types';
import { affectedBankNames } from '../migration-context';

export const hideResolvedPlaceholdersMigration: VersionMigration = {
  key: 'hide-resolved-placeholders-v1',
  targetVersion: '0.3.2',
  order: 10,
  mode: 'silent',
  title: '隐藏重复显示的无卡号卡片',
  description: '已有对应真实卡时，隐藏无卡号卡片，保留历史账单。',
  describeImpact({ total, payload }) {
    const banks = affectedBankNames(payload);
    return banks.length > 0 ? `${banks.join('、')} · 共 ${total} 张无卡号卡片` : null;
  },
  async inspect(db) {
    const ids = await findUnfinishedPlaceholderCardIds(db);
    if (ids.length === 0) return null;
    const cards = await db.card.findMany({ where: { id: { in: ids } }, select: { bankName: true } });
    return { total: ids.length, payload: { cardIds: ids, banks: [...new Set(cards.map((card) => card.bankName))] } };
  },
  async executeSilent(tx) {
    const result = await reconcileUnfinishedPlaceholderCards(tx);
    if (result.hiddenCardIds.length > 0) await recomputePrimary(tx);
    return { succeeded: result.hiddenCardIds.length, unchanged: 0, failed: 0 };
  },
};
