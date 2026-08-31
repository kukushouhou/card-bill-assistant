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
  /** 只读入场条件：返回 null 时该迁移不进入本次计划，不提示也不执行。 */
  inspect(db: PrismaClient | Prisma.TransactionClient): Promise<MigrationInspection | null>;
  executeSilent?(tx: Prisma.TransactionClient): Promise<TaskExecutionResult>;
  prepareTask?(taskId: number): Promise<void>;
  executeTask?(taskId: number): Promise<TaskExecutionResult>;
}
