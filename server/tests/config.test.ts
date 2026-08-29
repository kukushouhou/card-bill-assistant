import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';

const originalCookieSecure = process.env.COOKIE_SECURE;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalCookieSecure === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = originalCookieSecure;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe('COOKIE_SECURE', () => {
  it('未显式配置时跟随生产环境', () => {
    delete process.env.COOKIE_SECURE;
    process.env.NODE_ENV = 'production';
    expect(config.cookieSecure).toBe(true);

    process.env.NODE_ENV = 'development';
    expect(config.cookieSecure).toBe(false);
  });

  it('允许显式覆盖为 true 或 false', () => {
    process.env.COOKIE_SECURE = 'true';
    expect(config.cookieSecure).toBe(true);

    process.env.COOKIE_SECURE = 'false';
    expect(config.cookieSecure).toBe(false);
  });

  it('拒绝无法识别的值', () => {
    process.env.COOKIE_SECURE = 'sometimes';
    expect(() => config.cookieSecure).toThrow('COOKIE_SECURE 必须是 true 或 false');
  });
});
