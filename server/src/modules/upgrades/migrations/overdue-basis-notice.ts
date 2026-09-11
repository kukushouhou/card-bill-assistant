import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import type { MigrationInspection, TaskExecutionResult, VersionMigration } from '../migration.types';
import { OVERDUE_BASIS_KEY } from '../../bills/paid';

const emptyResult = (): TaskExecutionResult => ({ succeeded: 0, unchanged: 0, failed: 0 });

/**
 * 逾期提醒口径属于新设置，不迁移任何数据：notice 模式在升级弹窗中告知新选项，
 * 弹窗内嵌选项控件由用户当场修改，确认时由前端调用设置接口保存；
 * 这里只保留空执行器以满足任务状态机，确认与忽略都会照常推进版本游标。
 */
export const overdueBasisNoticeMigration: VersionMigration = {
  key: 'overdue-basis-notice-v1',
  targetVersion: '0.5.2',
  order: 30,
  mode: 'notice',
  title: '新增逾期提醒设置',
  description: '现在可以决定过了还款日的账单按哪种口径算逾期：默认「未全额还清」，只要没还清应还金额就算逾期，已还最低的账单也会继续提醒；想保留以前「还够最低就不算逾期」的行为，请在下方改为「未还最低还款额」。',
  executeLabel: '完成',
  async inspect(_db: PrismaClient | Prisma.TransactionClient): Promise<MigrationInspection | null> {
    return { total: 1, payload: { option: OVERDUE_BASIS_KEY } };
  },
  prepareTask: async () => undefined,
  executeTask: async () => emptyResult(),
};
