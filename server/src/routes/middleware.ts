import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export const COOKIE_NAME = 'drc_token';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub?: unknown; username?: unknown };
    (req as AuthedRequest).adminId = Number(payload.sub);
    (req as AuthedRequest).username = String(payload.username ?? '');
    next();
  } catch {
    res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

export interface AuthedRequest extends Request {
  adminId?: number;
  username?: string;
}
