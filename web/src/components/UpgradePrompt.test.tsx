import { describe, expect, it } from 'vitest';
import { migrationModeText } from './UpgradePrompt';

describe('版本升级任务文案', () => {
  it('明确区分三种迁移类型', () => {
    expect(migrationModeText('silent')).toBe('静默迁移');
    expect(migrationModeText('optional')).toBe('可选迁移');
    expect(migrationModeText('required')).toBe('必选迁移');
  });
});
