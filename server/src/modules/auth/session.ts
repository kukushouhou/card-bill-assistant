import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { config } from '../../config';
import { prisma } from '../../lib/prisma';

export const SESSION_VERSION_KEY = 'auth.sessionVersion';
const REVOKED_PREFIX = 'auth.revokedSession.';

/** 空版本兼容升级前的登录；首次改密后旧版本凭证全部失效。 */
export async function sessionVersion(db: Pick<Prisma.TransactionClient, 'appSetting'>): Promise<string> {
  return (await db.appSetting.findUnique({ where: { key: SESSION_VERSION_KEY } }))?.value ?? '';
}

export function signSession(admin: { id: number; username: string }, version: string): string {
  return jwt.sign({ sub: admin.id, username: admin.username, sv: version }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '7d',
    jwtid: randomUUID(),
  });
}

export async function sessionRevoked(token: string): Promise<boolean> {
  const key = REVOKED_PREFIX + createHash('sha256').update(token).digest('hex');
  return !!(await prisma.appSetting.findUnique({ where: { key } }));
}

/** 退出只撤销当前凭证；仅保存摘要和到期时间，其他设备继续登录。 */
export async function revokeSession(token: unknown): Promise<void> {
  if (typeof token !== 'string') return;
  let expiresAt: number;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload !== 'object' || !Number.isFinite(payload.exp)) return;
    expiresAt = payload.exp! * 1_000;
  } catch { return; }
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: REVOKED_PREFIX }, value: { lt: new Date().toISOString() } } });
  const key = REVOKED_PREFIX + createHash('sha256').update(token).digest('hex');
  const value = new Date(expiresAt).toISOString();
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}
