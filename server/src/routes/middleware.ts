import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { sessionRevoked, sessionVersion } from '../modules/auth/session';

export const COOKIE_NAME = 'drc_token';

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set('Cache-Control', 'no-store');
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  let payload: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof verified !== 'object' || verified === null) throw new Error();
    payload = verified;
    if (!Number.isFinite(payload.exp)) throw new Error();
    if (!['number', 'string'].includes(typeof payload.sub) || !Number.isSafeInteger(Number(payload.sub)) || Number(payload.sub) <= 0) throw new Error();
  } catch {
    res.status(401).json({ error: '登录已过期，请重新登录' });
    return;
  }
  try {
    const [admin, version, revoked] = await Promise.all([
      prisma.admin.findUnique({ where: { id: Number(payload.sub) }, select: { id: true, username: true } }),
      sessionVersion(prisma),
      sessionRevoked(token),
    ]);
    if (!admin || revoked || (payload.sv ?? '') !== version) {
      res.status(401).json({ error: '登录已过期，请重新登录' });
      return;
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
