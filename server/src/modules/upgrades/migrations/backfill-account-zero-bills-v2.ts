import { affectedBankNames } from '../migration-context';
import type { VersionMigration } from '../migration.types';
import {
  executeZeroBillTask,
  inspectAccountZeroBills,
  prepareZeroBillTask,
} from './backfill-account-zero-bills';

/**
 * 户级账单银行扩容后的回填迁移：此前已决策过 v1（account-zero-bills-current-v1，锚点 0.4.1）的库
 * 不会重复执行旧迁移，新增户级银行（北京、长沙、湖南银行、南京、浦发）的当前待还账期由本迁移补齐。
 * 盘点与执行完全复用 v1 的动态扫描——已补齐的银行自动 0 待补，不弹面板。
 */
export const accountZeroBillsMigrationV2: VersionMigration = {
  key: 'account-zero-bills-current-v2',
  targetVersion: '0.5.2',
  order: 10,
  mode: 'optional',
  title: '修正新增户级账单银行的本期账单状态',
  description: '北京、长沙、湖南银行、南京、浦发与招商、民生、平安、华夏一样按户发账单：本期账单已到而自身无账单的卡，属于「无需还款」而不是「未取得账单」。本次升级补齐这些银行当前账期的账单状态并校正户内出账日和还款日。无需重读邮件，历史账单不变。',
  executeLabel: '现在执行',
  ignoreLabel: '忽略更新',
  ignoreWarning: '忽略后，这些银行本期仍可能显示「未取得账单」并产生多余提醒；收到下期账单后会正常处理。系统将不再提供本次迁移服务。',
  describeImpact({ total, payload }) {
    const banks = affectedBankNames(payload);
    return banks.length > 0 ? `${banks.join('、')} · 共 ${total} 张卡的本期账单` : null;
  },
  inspect: inspectAccountZeroBills,
  prepareTask: prepareZeroBillTask,
  executeTask: executeZeroBillTask,
};
