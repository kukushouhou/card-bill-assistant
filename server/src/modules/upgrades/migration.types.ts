import type { Prisma, PrismaClient } from '../../generated/prisma/client';

export type MigrationMode = 'silent' | 'optional' | 'required';

export interface MigrationInspection {
  total: number;
  payload: Prisma.InputJsonValue;
  summary?: string;
}

export interface TaskExecutionResult {
  succeeded: number;
  unchanged: number;
  failed: number;
  error?: string;
}

export interface VersionMigration {
  key: string;
  targetVersion: string;
  order: number;
  mode: MigrationMode;
  title: string;
  description: string;
  executeLabel?: string;
  ignoreLabel?: string;
  /** 用户选择忽略时说明业务后果及决定不可撤销，不作为默认常驻提示。 */
  ignoreWarning?: string;
  /** 根据已盘点的业务上下文说明实际影响范围；旧计划读取时也复用，不执行迁移。 */
  describeImpact?(context: { total: number; payload: unknown }): string | null;
  /** 只读入场条件：返回 null 时该迁移不进入本次计划，不提示也不执行。 */
  inspect(db: PrismaClient | Prisma.TransactionClient): Promise<MigrationInspection | null>;
  executeSilent?(tx: Prisma.TransactionClient): Promise<TaskExecutionResult>;
  prepareTask?(taskId: number): Promise<void>;
  executeTask?(taskId: number): Promise<TaskExecutionResult>;
}
