import type { Prisma } from '../../generated/prisma/client';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { pauseScheduler, startScheduler } from '../../jobs/scheduler';
import { APP_VERSION } from '../../version';
import {
  applicableMigrations,
  classifyUpgradePreflight,
  compareVersions,
  migrationByKey,
  validateMigrationRegistry,
} from './migration.registry';
import type { MigrationInspection, MigrationMode, VersionMigration } from './migration.types';
import {
  getUpgradeRuntimeState,
  setUpgradeRuntimeState,
  waitForBusinessWrites,
  type UpgradeRuntimeMode,
} from './upgrade.runtime';

const INSTALLED_VERSION_KEY = 'installedVersion';
const LEGACY_EMAIL_VERSION = '0.1.0';
const FINAL_TASK_STATUSES = new Set(['completed', 'ignored']);
let activeExecution: Promise<void> | null = null;

async function resolveVersionCursor(
  db: Pick<Prisma.TransactionClient, 'emailAccount'>,
  storedVersion: string | null,
): Promise<{ cursor: string; missingWithoutEmail: boolean }> {
  if (storedVersion) return { cursor: storedVersion, missingWithoutEmail: false };
  const emailAccounts = await db.emailAccount.count();
  return emailAccounts > 0
    ? { cursor: LEGACY_EMAIL_VERSION, missingWithoutEmail: false }
    : { cursor: APP_VERSION, missingWithoutEmail: true };
}

interface ManifestEntry {
  key: string;
  targetVersion: string;
  order: number;
  mode: MigrationMode;
  title: string;
  description: string;
  total: number;
  summary: string | null;
}

export interface UpgradeTaskView {
  key: string;
  mode: MigrationMode;
  targetVersion: string;
  order: number;
  title: string;
  description: string;
  executeLabel: string;
  ignoreLabel: string | null;
  status: string;
  total: number;
  processed: number;
  succeeded: number;
  unchanged: number;
  failed: number;
  error: string | null;
}

export interface UpgradePlanView {
  id: number;
  fromVersion: string | null;
  toVersion: string;
  status: string;
  hasRequired: boolean;
  runtimeMode: UpgradeRuntimeMode;
  error: string | null;
  migrations: ManifestEntry[];
  tasks: UpgradeTaskView[];
}

export interface UpgradeInitialization {
  runtimeMode: UpgradeRuntimeMode;
  shouldStartScheduler: boolean;
  shouldResumeExecution: boolean;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function parseManifest(value: unknown): ManifestEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row.key !== 'string'
      || typeof row.targetVersion !== 'string'
      || typeof row.order !== 'number'
      || !['silent', 'optional', 'required'].includes(String(row.mode))
      || typeof row.title !== 'string'
      || typeof row.description !== 'string'
    ) return [];
    return [{
      key: row.key,
      targetVersion: row.targetVersion,
      order: row.order,
      mode: row.mode as MigrationMode,
      title: row.title,
      description: row.description,
      total: Number(row.total ?? 0),
      summary: typeof row.summary === 'string' ? row.summary : null,
    }];
  });
}

function taskView(task: {
  key: string;
  mode: string;
  toVersion: string;
  migrationOrder: number;
  title: string;
  description: string;
  executeLabel: string;
  ignoreLabel: string | null;
  status: string;
  total: number;
  processed: number;
  succeeded: number;
  unchanged: number;
  failed: number;
  error: string | null;
}): UpgradeTaskView {
  return {
    key: task.key,
    mode: task.mode as MigrationMode,
    targetVersion: task.toVersion,
    order: task.migrationOrder,
    title: task.title,
    description: task.description,
    executeLabel: task.executeLabel,
    ignoreLabel: task.ignoreLabel,
    status: task.status,
    total: task.total,
    processed: task.processed,
    succeeded: task.succeeded,
    unchanged: task.unchanged,
    failed: task.failed,
    error: task.error,
  };
}

async function planView(planId: number): Promise<UpgradePlanView | null> {
  const plan = await prisma.upgradePlan.findUnique({ where: { id: planId }, include: { tasks: true } });
  if (!plan) return null;
  const tasks = plan.tasks
    .map(taskView)
    .sort((a, b) => compareVersions(a.targetVersion, b.targetVersion) || a.order - b.order);
  return {
    id: plan.id,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    status: plan.status,
    hasRequired: plan.hasRequired,
    runtimeMode: getUpgradeRuntimeState().mode,
    error: plan.error,
    migrations: parseManifest(plan.manifest),
    tasks,
  };
}

async function activePlan() {
  return prisma.upgradePlan.findFirst({
    where: { status: { in: ['awaiting_decision', 'executing', 'failed'] } },
    include: { tasks: true },
    orderBy: { createdAt: 'desc' },
  });
}

function decisionsComplete(tasks: Array<{ status: string }>): boolean {
  return tasks.every((task) => ['approved', 'completed', 'ignored'].includes(task.status));
}

function waitingMode(plan: { hasRequired: boolean }): UpgradeRuntimeMode {
  return plan.hasRequired ? 'required_wait' : 'optional_wait';
}

async function ignoreTasksPastCursor(cursor: string): Promise<void> {
  const tasks = await prisma.upgradeTask.findMany({
    where: { status: { notIn: ['completed', 'ignored'] } },
    select: { id: true, toVersion: true },
  });
  for (const task of tasks) {
    if (compareVersions(task.toVersion, cursor) > 0) continue;
    await prisma.upgradeTask.update({
      where: { id: task.id },
      data: { status: 'ignored', error: null, ignoredAt: new Date(), finishedAt: new Date() },
    });
  }
}

async function restoreInterruptedTasks(): Promise<void> {
  const interrupted = await prisma.upgradeTask.findMany({
    where: { status: 'running' },
    select: { id: true },
  });
  if (interrupted.length === 0) return;
  const ids = interrupted.map((task) => task.id);
  await prisma.upgradeTaskItem.updateMany({
    where: { taskId: { in: ids }, status: 'running' },
    data: { status: 'pending', error: null, processedAt: null },
  });
  await prisma.upgradeTask.updateMany({
    where: { id: { in: ids } },
    data: { status: 'approved', error: null, finishedAt: null },
  });
}

function manifestEntry(migration: VersionMigration, inspection: MigrationInspection): ManifestEntry {
  return {
    key: migration.key,
    targetVersion: migration.targetVersion,
    order: migration.order,
    mode: migration.mode,
    title: migration.title,
    description: migration.description,
    total: inspection.total,
    summary: inspection.summary ?? null,
  };
}

async function createOrAttachTask(
  tx: Prisma.TransactionClient,
  planId: number,
  fromVersion: string | null,
  migration: VersionMigration,
  inspection: MigrationInspection,
) {
  const existing = await tx.upgradeTask.findUnique({ where: { key: migration.key } });
  const metadata = {
    key: migration.key,
    planId,
    fromVersion,
    toVersion: migration.targetVersion,
    mode: migration.mode,
    migrationOrder: migration.order,
    title: migration.title,
    description: migration.description,
    executeLabel: migration.executeLabel ?? (migration.mode === 'required' ? '确认并执行' : '现在执行'),
    ignoreLabel: migration.mode === 'optional' ? migration.ignoreLabel ?? '忽略迁移' : null,
    payload: inspection.payload,
    total: inspection.total,
  };
  if (existing) return tx.upgradeTask.update({ where: { id: existing.id }, data: metadata });
  return tx.upgradeTask.create({ data: { ...metadata, status: 'awaiting_decision' } });
}

/** 启动时只读盘点完整版本区间；存在交互迁移时不执行任何数据迁移。 */
export async function initializeUpgradeState(installed: boolean): Promise<UpgradeInitialization> {
  validateMigrationRegistry();
  if (!installed) {
    setUpgradeRuntimeState({ mode: 'ready', planId: null, message: null });
    return { runtimeMode: 'ready', shouldStartScheduler: true, shouldResumeExecution: false };
  }

  await restoreInterruptedTasks();
  const stored = await prisma.appSetting.findUnique({ where: { key: INSTALLED_VERSION_KEY } });
  const resolvedCursor = await resolveVersionCursor(prisma, stored?.value ?? null);
  const cursor = resolvedCursor.cursor;
  if (!stored && resolvedCursor.missingWithoutEmail) {
    await prisma.appSetting.upsert({
      where: { key: INSTALLED_VERSION_KEY },
      create: { key: INSTALLED_VERSION_KEY, value: APP_VERSION },
      update: { value: APP_VERSION },
    });
  }
  if (compareVersions(cursor, APP_VERSION) > 0) {
    throw new Error(`数据库版本 ${cursor} 高于当前程序 ${APP_VERSION}，不支持降级启动`);
  }
  await ignoreTasksPastCursor(cursor);

  const existingPlan = await activePlan();
  if (existingPlan) {
    const taskStates = existingPlan.tasks.map((task) => task.status);
    if (existingPlan.status === 'failed' || taskStates.includes('failed')) {
      setUpgradeRuntimeState({ mode: 'failed', planId: existingPlan.id, message: existingPlan.error });
      return { runtimeMode: 'failed', shouldStartScheduler: false, shouldResumeExecution: false };
    }
    if (decisionsComplete(existingPlan.tasks)) {
      setUpgradeRuntimeState({ mode: 'executing', planId: existingPlan.id, message: null });
      return { runtimeMode: 'executing', shouldStartScheduler: false, shouldResumeExecution: true };
    }
    const mode = waitingMode(existingPlan);
    setUpgradeRuntimeState({ mode, planId: existingPlan.id, message: null });
    return { runtimeMode: mode, shouldStartScheduler: mode === 'optional_wait', shouldResumeExecution: false };
  }

  if (compareVersions(cursor, APP_VERSION) === 0) {
    setUpgradeRuntimeState({ mode: 'ready', planId: null, message: null });
    return { runtimeMode: 'ready', shouldStartScheduler: true, shouldResumeExecution: false };
  }

  let initialization: UpgradeInitialization = {
    runtimeMode: 'ready', shouldStartScheduler: true, shouldResumeExecution: false,
  };
  await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT `key` FROM `AppSetting` WHERE `key` = 'installedAt' FOR UPDATE");
    const latest = await tx.appSetting.findUnique({ where: { key: INSTALLED_VERSION_KEY } });
    const resolved = await resolveVersionCursor(tx, latest?.value ?? null);
    const from = resolved.cursor;
    if (!latest && resolved.missingWithoutEmail) {
      await tx.appSetting.upsert({
        where: { key: INSTALLED_VERSION_KEY },
        create: { key: INSTALLED_VERSION_KEY, value: APP_VERSION },
        update: { value: APP_VERSION },
      });
      return;
    }
    if (compareVersions(from, APP_VERSION) === 0) return;
    if (compareVersions(from, APP_VERSION) > 0) throw new Error('数据库版本高于当前程序');

    const inspections: Array<{ migration: VersionMigration; inspection: MigrationInspection }> = [];
    for (const migration of applicableMigrations(from, APP_VERSION)) {
      const inspection = await migration.inspect(tx);
      if (inspection) inspections.push({ migration, inspection });
    }

    if (inspections.length === 0) {
      await tx.appSetting.upsert({
        where: { key: INSTALLED_VERSION_KEY },
        create: { key: INSTALLED_VERSION_KEY, value: APP_VERSION },
        update: { value: APP_VERSION },
      });
      return;
    }

    const preflightMode = classifyUpgradePreflight(inspections.map(({ migration }) => migration));
    const hasRequired = preflightMode === 'required_wait';
    const interactive = inspections.filter(({ migration }) => migration.mode !== 'silent');
    const plan = await tx.upgradePlan.create({
      data: {
        fromVersion: latest?.value ?? null,
        toVersion: APP_VERSION,
        status: interactive.length > 0 ? 'awaiting_decision' : 'executing',
        hasRequired,
        manifest: asJson(inspections.map(({ migration, inspection }) => manifestEntry(migration, inspection))),
        startedAt: interactive.length > 0 ? null : new Date(),
      },
    });
    for (const { migration, inspection } of interactive) {
      await createOrAttachTask(tx, plan.id, latest?.value ?? null, migration, inspection);
    }

    if (interactive.length > 0) {
      const mode: UpgradeRuntimeMode = preflightMode === 'required_wait' ? 'required_wait' : 'optional_wait';
      setUpgradeRuntimeState({ mode, planId: plan.id, message: null });
      initialization = { runtimeMode: mode, shouldStartScheduler: mode === 'optional_wait', shouldResumeExecution: false };
      return;
    }

    for (const { migration } of inspections) {
      const result = await migration.executeSilent!(tx);
      if (result.failed > 0) throw new Error(result.error ?? `静默迁移失败: ${migration.key}`);
      console.log(`[upgrade] 静默迁移完成: ${migration.key}, 更新 ${result.succeeded} 项`);
    }
    await tx.appSetting.upsert({
      where: { key: INSTALLED_VERSION_KEY },
      create: { key: INSTALLED_VERSION_KEY, value: APP_VERSION },
      update: { value: APP_VERSION },
    });
    await tx.upgradePlan.update({ where: { id: plan.id }, data: { status: 'completed', finishedAt: new Date() } });
  });

  if (initialization.runtimeMode === 'ready') {
    setUpgradeRuntimeState({ mode: 'ready', planId: null, message: null });
  }
  return initialization;
}

export async function recordInstalledVersion(): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: INSTALLED_VERSION_KEY },
    create: { key: INSTALLED_VERSION_KEY, value: APP_VERSION },
    update: { value: APP_VERSION },
  });
}

export async function getUpgradePlan(): Promise<UpgradePlanView | null> {
  const plan = await activePlan();
  return plan ? planView(plan.id) : null;
}

async function requireActionableTask(key: string) {
  const task = await prisma.upgradeTask.findUnique({ where: { key }, include: { plan: true } });
  if (!task || !task.plan) throw new ApiError(404, '迁移任务不存在');
  const cursor = await prisma.appSetting.findUnique({ where: { key: INSTALLED_VERSION_KEY } });
  if (cursor && compareVersions(cursor.value, task.toVersion) >= 0) {
    throw new ApiError(409, '版本游标已越过该迁移，不能再执行');
  }
  if (FINAL_TASK_STATUSES.has(task.status)) throw new ApiError(409, '该迁移已取得最终结果');
  return task;
}

export async function approveUpgradeTask(key: string): Promise<UpgradePlanView> {
  const task = await requireActionableTask(key);
  if (task.status === 'running') throw new ApiError(409, '该迁移正在执行');
  await prisma.upgradeTask.update({
    where: { id: task.id },
    data: { status: 'approved', approvedAt: new Date(), ignoredAt: null, error: null, finishedAt: null },
  });
  await continueAfterDecision(task.planId!);
  return (await planView(task.planId!))!;
}

export async function ignoreUpgradeTask(key: string): Promise<UpgradePlanView> {
  const task = await requireActionableTask(key);
  if (task.mode !== 'optional') throw new ApiError(400, '必选迁移不允许忽略');
  if (task.status === 'running') throw new ApiError(409, '该迁移正在执行');
  await prisma.upgradeTask.update({
    where: { id: task.id },
    data: { status: 'ignored', ignoredAt: new Date(), error: null, finishedAt: new Date() },
  });
  await continueAfterDecision(task.planId!);
  return (await planView(task.planId!))!;
}

async function continueAfterDecision(planId: number): Promise<void> {
  const plan = await prisma.upgradePlan.findUnique({ where: { id: planId }, include: { tasks: true } });
  if (!plan) throw new ApiError(404, '升级计划不存在');
  if (!decisionsComplete(plan.tasks)) {
    const mode = waitingMode(plan);
    setUpgradeRuntimeState({ mode, planId, message: null });
    return;
  }
  await prisma.upgradePlan.update({
    where: { id: planId },
    data: { status: 'executing', startedAt: plan.startedAt ?? new Date(), error: null },
  });
  setUpgradeRuntimeState({ mode: 'executing', planId, message: null });
  void resumeUpgradeExecution();
}

async function executeInteractiveTask(task: NonNullable<Awaited<ReturnType<typeof prisma.upgradeTask.findUnique>>>): Promise<boolean> {
  if (task.status === 'ignored' || task.status === 'completed') return true;
  const migration = migrationByKey(task.key);
  if (!migration?.executeTask || !migration.prepareTask) throw new Error(`迁移执行器不存在: ${task.key}`);
  await prisma.upgradeTask.update({
    where: { id: task.id },
    data: { status: 'running', error: null, startedAt: task.startedAt ?? new Date(), finishedAt: null },
  });
  await migration.prepareTask(task.id);
  const result = await migration.executeTask(task.id);
  const status = result.failed > 0 ? 'failed' : 'completed';
  await prisma.upgradeTask.update({
    where: { id: task.id },
    data: {
      status,
      succeeded: result.succeeded,
      unchanged: result.unchanged,
      failed: result.failed,
      processed: result.succeeded + result.unchanged + result.failed,
      error: result.error?.slice(0, 512) ?? null,
      finishedAt: new Date(),
    },
  });
  return status === 'completed';
}

async function runUpgradePlan(planId: number): Promise<void> {
  await pauseScheduler();
  setUpgradeRuntimeState({ mode: 'executing', planId, message: null });
  await waitForBusinessWrites();
  const plan = await prisma.upgradePlan.findUnique({ where: { id: planId }, include: { tasks: true } });
  if (!plan) throw new Error('升级计划不存在');
  if (!decisionsComplete(plan.tasks)) {
    setUpgradeRuntimeState({ mode: waitingMode(plan), planId, message: null });
    return;
  }

  const cursorRow = await prisma.appSetting.findUnique({ where: { key: INSTALLED_VERSION_KEY } });
  const resolvedCursor = await resolveVersionCursor(prisma, cursorRow?.value ?? null);
  let cursor = resolvedCursor.cursor;
  const migrations = applicableMigrations(cursor, plan.toVersion);
  const versions = [...new Set(migrations.map((migration) => migration.targetVersion))].sort(compareVersions);

  for (const targetVersion of versions) {
    const group = migrations.filter((migration) => migration.targetVersion === targetVersion);
    for (const migration of group) {
      if (migration.mode === 'silent') {
        if (!(await migration.inspect(prisma))) continue;
        await prisma.$transaction(async (tx) => {
          const result = await migration.executeSilent!(tx);
          if (result.failed > 0) throw new Error(result.error ?? `静默迁移失败: ${migration.key}`);
        });
        continue;
      }
      const task = await prisma.upgradeTask.findUnique({ where: { key: migration.key } });
      if (!task) {
        if (!(await migration.inspect(prisma))) continue;
        throw new Error(`迁移 ${migration.key} 在执行前新增了待决策数据，需要重新生成升级计划`);
      }
      if (!(await executeInteractiveTask(task))) {
        const failed = await prisma.upgradeTask.findUnique({ where: { id: task.id } });
        const message = failed?.error ?? '迁移执行失败';
        await prisma.upgradePlan.update({ where: { id: planId }, data: { status: 'failed', error: message } });
        setUpgradeRuntimeState({ mode: 'failed', planId, message });
        return;
      }
    }
    await prisma.appSetting.upsert({
      where: { key: INSTALLED_VERSION_KEY },
      create: { key: INSTALLED_VERSION_KEY, value: targetVersion },
      update: { value: targetVersion },
    });
    cursor = targetVersion;
  }

  if (compareVersions(cursor, plan.toVersion) < 0) {
    await prisma.appSetting.upsert({
      where: { key: INSTALLED_VERSION_KEY },
      create: { key: INSTALLED_VERSION_KEY, value: plan.toVersion },
      update: { value: plan.toVersion },
    });
  }
  await prisma.upgradePlan.update({
    where: { id: planId },
    data: { status: 'completed', error: null, finishedAt: new Date() },
  });
  setUpgradeRuntimeState({ mode: 'ready', planId: null, message: null });
  startScheduler();
}

export async function resumeUpgradeExecution(): Promise<void> {
  if (activeExecution) return activeExecution;
  const plan = await activePlan();
  if (!plan || plan.status !== 'executing') return;
  activeExecution = runUpgradePlan(plan.id)
    .catch(async (error) => {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 512);
      await prisma.upgradePlan.update({ where: { id: plan.id }, data: { status: 'failed', error: message } }).catch(() => undefined);
      setUpgradeRuntimeState({ mode: 'failed', planId: plan.id, message });
      console.error('[upgrade] 迁移链执行失败:', error);
    })
    .finally(() => { activeExecution = null; });
  return activeExecution;
}
