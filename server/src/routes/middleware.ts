import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { SESSION_MAX_AGE_MS, sessionId, sessionRevoked, sessionVersion, shouldRenewSession, signSession } from '../modules/auth/session';

export const COOKIE_NAME = 'drc_token';

/** 登录与自动续期共用同一 Cookie 口径，避免两处配置漂移。 */
export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set('Cache-Control', 'no-store');
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  let payload: jwt.JwtPayload;
  let id: string;
  // 必须早于撤销查询取时，保证在途续期的到期时间不会越过已提交的撤销记录。
  const issuedAt = Math.floor(Date.now() / 1_000);
  try {
    const verified = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof verified !== 'object' || verified === null) throw new Error();
    payload = verified;
    if (!Number.isFinite(payload.exp)) throw new Error();
    if (!['number', 'string'].includes(typeof payload.sub) || !Number.isSafeInteger(Number(payload.sub)) || Number(payload.sub) <= 0) throw new Error();
    id = sessionId(token, payload);
  } catch {
    res.status(401).json({ error: '登录已过期，请重新登录' });
    return;
  }
  try {
    const [admin, version, revoked] = await Promise.all([
      prisma.admin.findUnique({ where: { id: Number(payload.sub) }, select: { id: true, username: true } }),
      sessionVersion(prisma),
      sessionRevoked(id),
    ]);
    if (!admin || revoked || (payload.sv ?? '') !== version) {
      res.status(401).json({ error: '登录已过期，请重新登录' });
      return;
    }
    // 滑动续期沿用会话标识；退出任一凭证时，同一会话的新旧凭证一并失效。
    if (shouldRenewSession(payload)) {
      setAuthCookie(res, signSession({ id: admin.id, username: admin.username }, version, id, issuedAt));
    }
    (req as AuthedRequest).adminId = admin.id;
    (req as AuthedRequest).username = admin.username;
    next();
  } catch (error) {
    // 数据库故障不能伪装成登录过期，也不能放行请求。
    next(error);
  }
}

export interface AuthedRequest extends Request {
  adminId?: number;
  username?: string;
}
