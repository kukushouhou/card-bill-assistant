import { describe, expect, it, vi } from 'vitest';
import { classifyUpgradePreflight, compareVersions, validateMigrationRegistry } from '../src/modules/upgrades/migration.registry';
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
});
