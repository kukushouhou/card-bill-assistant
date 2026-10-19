import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { config } from '../../config';
import { prisma } from '../../lib/prisma';

export const SESSION_VERSION_KEY = 'auth.sessionVersion';
const REVOKED_PREFIX = 'auth.revokedSession.';
// 先提交撤销，再确定清理时间；中途失败时保留此标记，不会提前放行旧凭证。
const REVOCATION_PENDING = 'pending';

/** 会话最长空闲期：只要在此窗口内用过一次就自动续期，长期不用才需要重新登录。 */
export const SESSION_MAX_AGE_MS = 30 * 24 * 3600_000;
/** 距签发超过该时长才续期，避免同一批并发请求反复重签。 */
const SESSION_RENEW_THRESHOLD_MS = 24 * 3600_000;

/** 空版本兼容升级前的登录；首次改密后旧版本凭证全部失效。 */
export async function sessionVersion(db: Pick<Prisma.TransactionClient, 'appSetting'>): Promise<string> {
  return (await db.appSetting.findUnique({ where: { key: SESSION_VERSION_KEY } }))?.value ?? '';
}

export function signSession(
  admin: { id: number; username: string },
  version: string,
  sid: string = randomUUID(),
  issuedAt = Math.floor(Date.now() / 1_000),
): string {
  return jwt.sign({ sub: admin.id, username: admin.username, sv: version, sid, iat: issuedAt }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: SESSION_MAX_AGE_MS / 1_000,
    jwtid: randomUUID(),
  });
}

/** 活跃用户无需周期性重登：距签发超过 24 小时的凭证在使用时自动换发新凭证。 */
export function shouldRenewSession(payload: jwt.JwtPayload): boolean {
  return typeof payload.iat !== 'number' || Date.now() - payload.iat * 1_000 > SESSION_RENEW_THRESHOLD_MS;
}

/** 旧版凭证用自身摘要作为会话标识，换发后沿用，兼容既有登录与撤销记录。 */
export function sessionId(token: string, payload: jwt.JwtPayload): string {
  if (payload.sid === undefined) return createHash('sha256').update(token).digest('hex');
  if (typeof payload.sid !== 'string' || !payload.sid || payload.sid.length > 64) throw new Error('会话标识无效');
  return payload.sid;
}

export async function sessionRevoked(id: string): Promise<boolean> {
  const key = REVOKED_PREFIX + id;
  return !!(await prisma.appSetting.findUnique({ where: { key } }));
}

/** 退出撤销当前会话的全部凭证；仅存标识和到期时间，其他设备继续登录。 */
export async function revokeSession(token: unknown): Promise<void> {
  if (typeof token !== 'string') return;
  let id: string;
  let expiresAt: number;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload !== 'object' || !Number.isFinite(payload.exp)) return;
    id = sessionId(token, payload);
    expiresAt = payload.exp! * 1_000;
  } catch { return; }
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: REVOKED_PREFIX }, value: { lt: new Date(Date.now()).toISOString() } } });
  const key = REVOKED_PREFIX + id;
  try {
    await prisma.appSetting.create({ data: { key, value: REVOCATION_PENDING } });
  } catch (error) {
    // 唯一键保证并发退出只建一条记录，已存在时继续完成清理期限。
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') throw error;
  }
  // 旧凭证也能退出。保留到撤销提交后的完整有效期，覆盖续期分支及已通过认证的在途请求。
  // 首次确定清理时间后不再改写，避免并发退出缩短有效期；在途续期的签发时间取认证查询之前。
  const value = new Date(Math.max(expiresAt, Date.now() + SESSION_MAX_AGE_MS)).toISOString();
  await prisma.appSetting.updateMany({ where: { key, value: REVOCATION_PENDING }, data: { value } });
}
