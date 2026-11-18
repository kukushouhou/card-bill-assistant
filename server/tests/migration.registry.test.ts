import { describe, expect, it, vi } from 'vitest';
import { applicableMigrations, classifyUpgradePreflight, compareVersions, migrationByKey, validateMigrationRegistry } from '../src/modules/upgrades/migration.registry';
import type { VersionMigration } from '../src/modules/upgrades/migration.types';

function migration(overrides: Partial<VersionMigration>): VersionMigration {
  return {
    key: 'sample-v1',
    targetVersion: '1.2.3',
    order: 10,
    mode: 'required',
    title: '必选数据迁移',
    description: '需要用户确认后执行',
    inspect: vi.fn(async () => null),
    prepareTask: vi.fn(async () => undefined),
    executeTask: vi.fn(async () => ({ succeeded: 0, unchanged: 0, failed: 0 })),
    ...overrides,
  };
}

describe('版本迁移注册表', () => {
  it('0.8.5 平安、民生、广发独立可选，跨过版本后不再执行', () => {
    const tasks = applicableMigrations('0.8.4', '0.8.5');
    expect(tasks.map(task => task.key)).toEqual(['pab-details-repair-085-v1', 'cmbc-details-repair-085-v1', 'cgb-statement-recovery-085-v1']);
    expect(tasks.map(task => task.title)).toEqual(['补齐平安美元明细', '修正民生美元明细', '补录广发历史账单']);
    expect(tasks.every(task => task.mode === 'optional')).toBe(true);
    expect(tasks.every(task => task.ignoreWarning?.includes('系统将不再提供本次迁移服务'))).toBe(true);
    expect(tasks[0]!.description).toContain('平安');
    expect(tasks[0]!.description).not.toContain('民生');
    expect(tasks[1]!.description).toContain('民生');
    expect(tasks[1]!.description).not.toContain('平安');
    expect(applicableMigrations('0.8.5', '0.8.6')).toHaveLength(0);
  });
  it('0.8.4 农行恢复为独立可选迁移，已越过版本后不再执行', () => {
    const migration = migrationByKey('abc-statement-repair-084-v1');
    expect(migration).toMatchObject({ targetVersion: '0.8.4', mode: 'optional' });
    expect(applicableMigrations('0.8.3', '0.8.4').map(row => row.key)).toEqual([migration!.key]);
    expect(applicableMigrations('0.8.4', '0.8.5').map(row => row.key)).not.toContain(migration!.key);
  });
  it('从 0.7.0 升级到 0.7.1 可以执行独立补救迁移', () => {
    expect(applicableMigrations('0.7.0', '0.7.1').map((row) => row.key)).toEqual(['supplementary-link-repair-v2']);
  });

  it('从更早版本直接升级时只提示 0.7.1 附属卡迁移', () => {
    expect(applicableMigrations('0.6.2', '0.7.1').map((row) => row.key)).toEqual(['supplementary-link-repair-v2']);
    expect(migrationByKey('supplementary-link-repair-v1')?.targetVersion).toBe('0.7.0');
    expect(applicableMigrations('0.6.2', '0.7.0').map((row) => row.key)).toEqual(['supplementary-link-repair-v1']);
  });

  it('按语义化版本比较而不是字符串比较', () => {
    expect(compareVersions('0.3.2', '0.3.1')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('必选迁移提供忽略操作时拒绝启动', () => {
    expect(() => validateMigrationRegistry([migration({ ignoreLabel: '忽略' })]))
      .toThrow('必选迁移不能提供忽略操作');
  });

  it('注册键和同版本顺序必须唯一', () => {
    expect(() => validateMigrationRegistry([
      migration({ key: 'a' }),
      migration({ key: 'a', order: 20 }),
    ])).toThrow('迁移键重复');
    expect(() => validateMigrationRegistry([
      migration({ key: 'a' }),
      migration({ key: 'b' }),
    ])).toThrow('迁移顺序冲突');
  });

  it('必须先看完整入场结果再选择升级模式', () => {
    expect(classifyUpgradePreflight([])).toBe('none');
    expect(classifyUpgradePreflight([{ mode: 'silent' }])).toBe('silent');
    expect(classifyUpgradePreflight([{ mode: 'silent' }, { mode: 'optional' }])).toBe('optional_wait');
    expect(classifyUpgradePreflight([
      { mode: 'silent' },
      { mode: 'optional' },
      { mode: 'required' },
    ])).toBe('required_wait');
  });

  it('notice 仅告知新选项，等待模式与可选迁移一致且不阻碍业务', () => {
    expect(classifyUpgradePreflight([{ mode: 'notice' }])).toBe('optional_wait');
    expect(classifyUpgradePreflight([{ mode: 'notice' }, { mode: 'silent' }])).toBe('optional_wait');
    expect(classifyUpgradePreflight([{ mode: 'notice' }, { mode: 'required' }])).toBe('required_wait');
    expect(() => validateMigrationRegistry([
      migration({ mode: 'notice', key: 'notice-v1', title: '新增选项', description: '告知新选项' }),
    ])).not.toThrow();
  });
});
