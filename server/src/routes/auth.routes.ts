import { Router, type Request, type Response } from 'express';
import { asyncHandler, ApiError } from '../lib/errors';
import { config } from '../config';
import { requireAuth } from './middleware';
import * as authService from '../modules/auth/auth.service';

const router = Router();

function setAuthCookie(res: Response, token: string): void {
  res.cookie('drc_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: 7 * 24 * 3600_000,
    path: '/',
  });
}

// 登录
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) throw new ApiError(400, '请输入用户名和密码');
    const { token } = await authService.login(username, password);
    setAuthCookie(res, token);
    res.json({ ok: true });
  }),
);

// 登出
router.post('/logout', (req, res) => {
  res.clearCookie('drc_token', { path: '/' });
  res.json({ ok: true });
});

// 当前登录态
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = req as { username?: string };
    const pin = await authService.getPinStatus();
    res.json({ username: me.username, pin });
  }),
);

// 修改登录密码
router.post(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string };
    if (!oldPassword || !newPassword) throw new ApiError(400, '请输入原密码和新密码');
    await authService.changePassword(oldPassword, newPassword);
    res.json({ ok: true });
  }),
);

// ===== PIN 生命周期 =====

router.get(
  '/pin',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(await authService.getPinStatus());
  }),
);

// 独立 PIN 校验（敏感信息弹窗前置验证；复用防爆破，PIN 不落库不缓存）
router.post(
  '/pin/verify',
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.requireValidPin(req.body?.pin);
    res.json({ ok: true });
  }),
);

// 首次设置 PIN
router.post(
  '/pin',
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.setPin(req.body?.pin);
    res.json({ ok: true });
  }),
);

// 修改 PIN（重加密所有卡的敏感字段）
router.put(
  '/pin',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { oldPin, newPin } = req.body as { oldPin?: string; newPin?: string };
    await authService.changePin(oldPin, newPin);
    res.json({ ok: true });
  }),
);

// 忘记 PIN：作废所有卡敏感密文
router.delete(
  '/pin',
  requireAuth,
  asyncHandler(async (req, res) => {
    const pin = req.body?.pin ?? req.query?.pin;
    // 若已设置 PIN，需先验证当前 PIN 才能作废，防误操作
    const status = await authService.getPinStatus();
    if (status.hasPin) await authService.requireValidPin(pin);
    const result = await authService.destroyPin();
    res.json({ ok: true, destroyedCards: result.destroyedCards });
  }),
);

export default router;
