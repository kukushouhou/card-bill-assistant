import type { Prisma, PrismaClient } from '../../generated/prisma/client';

/**
 * 迁移边界（用户已明确）：
 * - required 仅适用于不迁移就无法运行整个系统的情况，不能因历史账单有错就强制迁移。
 *   今后新增 required，必须事先向用户显著说明必要性，并获得用户明确同意，不能自行定级。
 * - 历史账单、卡片关系等修复必须 optional，由用户选择执行或忽略。
 * - 单封邮件缺失、已删除或解析失败：记录原因并跳过，不要求用户恢复邮件或重试。
 * - 只有明确整个邮箱配置/连接不可用，才进入邮箱修复后继续的流程。
 * - 复用邮箱配置组件，在当前迁移上方弹窗同时设置多个邮箱；全部验证保存后返回
 *   上一级迁移弹窗，由用户点击“重试”，不能保存后自动迁移；不锁住邮箱设置，
 *   不增加常驻重试入口，也不能让用户关闭流程后无处继续。
 * - 已完成结果保留，邮箱修复后仅续跑未完成部分；局部失败不得让系统永久停摆。
 * - 调度器持续运行并在入口判断升级状态；强制迁移未操作满 10 分钟后通知，
 *   后续按已配置的每日通知时刻催办，两者共用模板并说明“因为未迁移所以无法正常通知”。
 *   用户确认开始迁移后停止催办，可选迁移不触发此类通知。
 * - 修订程序版本不能更换现役迁移的任务键或版本锚点，已完成/忽略的迁移不能重复执行。
 * - notice 仅用于告知新版本新增的设置选项：不执行数据迁移、等待期间不阻碍任何业务，
 *   弹窗中内嵌选项控件由用户当场修改并确认；确认与忽略都会照常推进版本游标，不再重现。
 */
export type MigrationMode = 'silent' | 'optional' | 'required' | 'notice';

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
