import { cardBusinessRelationsMigration } from './migrations/card-business-relations';
import { hideResolvedPlaceholdersMigration } from './migrations/hide-resolved-placeholders';
import type { VersionMigration } from './migration.types';

export const versionMigrations: VersionMigration[] = [
  cardBusinessRelationsMigration,
  hideResolvedPlaceholdersMigration,
];

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareVersions(left: string, right: string): number {
  const a = VERSION_RE.exec(left);
  const b = VERSION_RE.exec(right);
  if (!a || !b) throw new Error(`版本号必须为 major.minor.patch: ${!a ? left : right}`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function validateMigrationRegistry(migrations: VersionMigration[] = versionMigrations): void {
  const keys = new Set<string>();
  const orders = new Set<string>();
  for (const migration of migrations) {
    compareVersions(migration.targetVersion, migration.targetVersion);
    if (keys.has(migration.key)) throw new Error(`迁移键重复: ${migration.key}`);
    keys.add(migration.key);
    const orderKey = `${migration.targetVersion}:${migration.order}`;
    if (orders.has(orderKey)) throw new Error(`迁移顺序冲突: ${orderKey}`);
    orders.add(orderKey);
    if (migration.mode === 'silent' && !migration.executeSilent) {
      throw new Error(`静默迁移缺少执行器: ${migration.key}`);
    }
    if (migration.mode !== 'silent' && (!migration.executeTask || !migration.prepareTask)) {
      throw new Error(`用户确认迁移缺少任务执行器: ${migration.key}`);
    }
    if (migration.mode === 'required' && migration.ignoreLabel) {
      throw new Error(`必选迁移不能提供忽略操作: ${migration.key}`);
    }
  }
}

export function applicableMigrations(fromVersion: string, toVersion: string): VersionMigration[] {
  validateMigrationRegistry();
  if (compareVersions(fromVersion, toVersion) > 0) {
    throw new Error(`不支持从 ${fromVersion} 降级到 ${toVersion}`);
  }
  return versionMigrations
    .filter((migration) => (
      compareVersions(migration.targetVersion, fromVersion) > 0
      && compareVersions(migration.targetVersion, toVersion) <= 0
    ))
    .sort((a, b) => compareVersions(a.targetVersion, b.targetVersion) || a.order - b.order);
}

export function migrationByKey(key: string): VersionMigration | undefined {
  return versionMigrations.find((migration) => migration.key === key);
}

export type UpgradePreflightMode = 'none' | 'silent' | 'optional_wait' | 'required_wait';

/** 必须在任何迁移执行前，基于完整入场结果选定全局升级模式。 */
export function classifyUpgradePreflight(migrations: Array<Pick<VersionMigration, 'mode'>>): UpgradePreflightMode {
  if (migrations.some((migration) => migration.mode === 'required')) return 'required_wait';
  if (migrations.some((migration) => migration.mode === 'optional')) return 'optional_wait';
  if (migrations.some((migration) => migration.mode === 'silent')) return 'silent';
  return 'none';
}
