import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectionOptions } from 'node:tls';

const schemaDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma');

/** 将已配置的 TLS 选项传递给驱动，避免连接串要求加密但运行时静默使用明文。 */
export function parseMysqlUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('DATABASE_URL 格式非法'); }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (parsed.protocol !== 'mysql:' || !parsed.hostname || !database) throw new Error('DATABASE_URL 格式非法，应使用 mysql:// 连接串');
  const params = parsed.searchParams;
  const sslFlag = params.get('ssl');
  const accept = params.get('sslaccept');
  if (sslFlag !== null && !['true', 'false'].includes(sslFlag)) throw new Error('DATABASE_URL 的 ssl 必须为 true 或 false');
  if (accept !== null && !['strict', 'accept_invalid_certs'].includes(accept)) throw new Error('DATABASE_URL 的 sslaccept 参数无效');
  const tlsParameters = ['sslaccept', 'sslcert', 'sslidentity', 'sslpassword'];
  for (const key of params.keys()) {
    if (key.startsWith('ssl') && key !== 'ssl' && !tlsParameters.includes(key)) throw new Error('DATABASE_URL 包含不支持的 TLS 参数，请使用 ssl=true 或 sslaccept=strict');
  }
  const hasTlsOptions = tlsParameters.some(key => params.has(key));
  if (sslFlag === 'false' && hasTlsOptions) throw new Error('DATABASE_URL 的 TLS 配置互相冲突');
  let ssl: ConnectionOptions | undefined;
  if (sslFlag === 'true' || hasTlsOptions) {
    ssl = { rejectUnauthorized: accept !== 'accept_invalid_certs' };
    for (const [parameter, field] of [['sslcert', 'ca'], ['sslidentity', 'pfx']] as const) {
      if (params.has(parameter)) {
        const filename = params.get(parameter)!;
        if (!filename) throw new Error('DATABASE_URL 的证书路径不能为空');
        try { ssl[field] = fs.readFileSync(path.resolve(schemaDirectory, filename)); }
        catch { throw new Error('无法读取 DATABASE_URL 中配置的数据库证书'); }
      }
    }
    if (params.has('sslpassword')) ssl.passphrase = params.get('sslpassword')!;
  }
  const connectionLimit = Number(params.get('connection_limit') ?? 10);
  if (!Number.isSafeInteger(connectionLimit) || connectionLimit <= 0) throw new Error('DATABASE_URL 的 connection_limit 必须是正整数');
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    connectionLimit,
    ...(ssl ? { ssl } : {}),
  };
}
