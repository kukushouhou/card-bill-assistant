import { describe, expect, it } from 'vitest';
import { formatValidationIssues } from '../src/lib/errors';

describe('参数校验错误格式化', () => {
  it('缺少必填字段时不暴露 Zod 英文类型错误', () => {
    expect(formatValidationIssues([{
      code: 'invalid_type',
      message: 'Invalid input: expected string, received undefined',
    }])).toBe('缺少必填参数');
  });

  it('类型错误使用统一中文提示，业务自定义提示保持不变', () => {
    expect(formatValidationIssues([
      {
        code: 'invalid_type',
        message: 'Invalid input: expected boolean, received string',
      },
      {
        code: 'too_small',
        message: '密码长度至少 8 位',
      },
    ])).toBe('参数格式不正确; 密码长度至少 8 位');
  });
});
