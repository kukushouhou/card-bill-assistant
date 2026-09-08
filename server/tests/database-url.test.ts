import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { parseMysqlUrl } from '../src/lib/database-url';

afterEach(() => vi.restoreAllMocks());
const url = 'mysql://synthetic:encoded%40password@db.example.test:3306/test_db';
describe('数据库连接的 TLS 配置', () => {
  it('保留现有无 TLS 连接，解码密码并读取连接池大小', () => {
    expect(parseMysqlUrl(url)).toMatchObject({ host: 'db.example.test', port: 3306, password: 'encoded@password', database: 'test_db', connectionLimit: 10 });
    expect(parseMysqlUrl(url)).not.toHaveProperty('ssl');
    expect(parseMysqlUrl(url + '?connection_limit=3').connectionLimit).toBe(3);
    expect(parseMysqlUrl('mysql://user:pass@[::1]/db').host).toBe('::1');
  });
  it('显式 TLS 配置默认验证证书，不静默降级为明文', () => {
    expect(parseMysqlUrl(url + '?ssl=true').ssl).toEqual({ rejectUnauthorized: true });
    expect(parseMysqlUrl(url + '?sslaccept=strict').ssl).toEqual({ rejectUnauthorized: true });
    expect(parseMysqlUrl(url + '?sslaccept=accept_invalid_certs').ssl).toEqual({ rejectUnauthorized: false });
    expect(parseMysqlUrl(url + '?ssl=false')).not.toHaveProperty('ssl');
  });
  it('按 Prisma 目录解析 CA 与 PKCS12 证书，异常不输出连接串或密码', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('synthetic-certificate'));
    expect(parseMysqlUrl(url + '?sslcert=ca.pem&sslidentity=client.p12&sslpassword=test-passphrase').ssl)
      .toEqual({ rejectUnauthorized: true, ca: Buffer.from('synthetic-certificate'), pfx: Buffer.from('synthetic-certificate'), passphrase: 'test-passphrase' });
    expect(String(read.mock.calls[0][0])).toMatch(/prisma[\\/]ca\.pem$/);
    read.mockImplementation(() => { throw new Error('不要向外暴露路径'); });
    expect(() => parseMysqlUrl(url + '?sslcert=missing.pem')).toThrow('无法读取');
  });
  it('错误协议和拼错的 TLS 参数必须显式失败', () => {
    for (const value of ['https://user:pass@host/db', url + '?ssl=maybe', url + '?sslmode=require',
      url + '?ssl=false&sslaccept=strict', url + '?sslaccept=typo', url + '?connection_limit=NaN']) {
      expect(() => parseMysqlUrl(value)).toThrow();
    }
  });
});
