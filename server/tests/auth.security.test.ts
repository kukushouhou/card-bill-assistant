import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  admin: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  appSetting: { findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  card: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $queryRaw: vi.fn(), $transaction: vi.fn(),
}));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
import { config } from '../src/config';
import { ApiError } from '../src/lib/errors';
import { derivePinKey, encrypt, decrypt, makePinVerifier } from '../src/lib/crypto';
import { changePassword, changePin, destroyPin, login, requireValidPin, setPin, withValidPin } from '../src/modules/auth/auth.service';
import { SESSION_VERSION_KEY } from '../src/modules/auth/session';
import { requireAuth } from '../src/routes/middleware';
import { apiSecurity, attemptLimit, securityHeaders } from '../src/routes/security.middleware';
import { createLoginChallenge, loginDifficulty } from '../src/modules/auth/login-guard';
import authRouter from '../src/routes/auth.routes';

const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const originalJwtSecret = process.env.JWT_SECRET;
let admin: any;
let settings: Map<string, string>;
let cards: any[];
let queue: Promise<unknown>;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '91'.repeat(32);
  process.env.JWT_SECRET = 'security-test-session-key-with-no-real-credentials';
  vi.clearAllMocks();
  settings = new Map(); cards = []; queue = Promise.resolve();
  const pinSalt = Buffer.alloc(16, 8);
  admin = { id: 1, username: 'admin', passwordHash: bcrypt.hashSync('old-password', 4), pinSalt,
    pinVerifier: makePinVerifier(derivePinKey(config.encryptionKey, '123456', pinSalt)), pinFailCount: 0, pinLockedUntil: null };
  db.admin.findFirst.mockImplementation(async () => structuredClone(admin));
  db.admin.findUnique.mockImplementation(async ({ where }) => where.id === admin.id ? structuredClone(admin) : null);
  db.admin.update.mockImplementation(async ({ data }) => Object.assign(admin, data));
  db.appSetting.findUnique.mockImplementation(async ({ where }) => settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null);
  db.appSetting.upsert.mockImplementation(async ({ where, create, update }) => { settings.set(where.key, settings.has(where.key) ? update.value : create.value); });
  db.appSetting.create.mockImplementation(async ({ data }) => {
    if (settings.has(data.key)) throw Object.assign(new Error('重复标记'), { code: 'P2002' });
    settings.set(data.key, data.value);
  });
  db.appSetting.deleteMany.mockImplementation(async ({ where }) => {
    for (const [key, value] of settings) {
      if ((typeof where.key === 'string' ? key === where.key : key.startsWith(where.key.startsWith))
        && (!where.value?.lt || value < where.value.lt)) settings.delete(key);
    }
  });
  db.card.findMany.mockImplementation(async () => structuredClone(cards));
  db.card.update.mockImplementation(async ({ where, data }) => Object.assign(cards.find(card => card.id === where.id), data));
  db.card.updateMany.mockImplementation(async ({ data }) => { cards.forEach(card => Object.assign(card, data)); return { count: cards.length }; });
  db.$transaction.mockImplementation((run: (tx: typeof db) => Promise<unknown>) => {
    const work = queue.then(async () => {
      const snapshot = structuredClone({ admin, cards, settings });
      try { return await run(db); }
      catch (error) { admin = snapshot.admin; cards = snapshot.cards; settings = snapshot.settings; throw error; }
    });
    queue = work.catch(() => undefined);
    return work;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalJwtSecret;
});

async function withServer(run: (url: string) => Promise<void>) {
  const app = express();
  app.use(securityHeaders, apiSecurity, express.json(), cookieParser());
  app.use('/api/auth', authRouter);
  app.get('/private', requireAuth, (_req, res) => res.json({ ok: true }));
  app.post('/write', (_req, res) => res.json({ ok: true }));
  app.post('/limited', attemptLimit(3), (_req, res) => res.status(400).json({ error: '密码错误' }));
  app.post('/successful', attemptLimit(3), (_req, res) => res.json({ ok: true }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ApiError ? error.status : 500).json({ error: error.message });
  });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + (server.address() as AddressInfo).port); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe('登录与会话安全', () => {
  it('旧版正常凭证可平滑升级，改密后所有旧凭证失效，当前新凭证可用', async () => {
    const legacy = jwt.sign({ sub: 1, username: 'admin' }, config.jwtSecret, { expiresIn: '7d' });
    const old = await login('admin', 'old-password');
    await withServer(async url => {
      const get = (token: string) => fetch(url + '/private', { headers: { Cookie: 'drc_token=' + token } });
      expect((await get(legacy)).status).toBe(200);
      expect((await get(old.token)).status).toBe(200);
      const updated = await changePassword('old-password', 'new-password');
      expect(settings.get(SESSION_VERSION_KEY)).toBeTruthy();
      expect((await get(legacy)).status).toBe(401);
      expect((await get(old.token)).status).toBe(401);
      expect((await get(updated.token)).status).toBe(200);
      await expect(login('admin', 'old-password')).rejects.toMatchObject({ status: 400 });
      expect((await get((await login('admin', 'new-password')).token)).status).toBe(200);
    });
  });

  it('错误密码不改变登录状态，UTF-8 超过 bcrypt 字节上限的密码被拒绝', async () => {
    await expect(changePassword('wrong-password', 'new-password')).rejects.toMatchObject({ status: 400 });
    await expect(changePassword('old-password', '密'.repeat(25))).rejects.toMatchObject({ status: 400 });
    expect(settings.size).toBe(0);
    expect(await bcrypt.compare('old-password', admin.passwordHash)).toBe(true);
  });

  it('非法签名、算法、管理员编号与不存在账户均不能访问', async () => {
    await withServer(async url => {
      const tokens = ['invalid', jwt.sign({ sub: 1 }, 'wrong-secret'),
        jwt.sign({ sub: 1 }, config.jwtSecret, { algorithm: 'HS384' }),
        jwt.sign({ sub: 1 }, config.jwtSecret),
        ...[undefined, 0, -1, 1.5, 'x', 999].map(sub => jwt.sign({ sub }, config.jwtSecret, { expiresIn: '7d' }))];
      for (const token of tokens) expect((await fetch(url + '/private', { headers: { Cookie: 'drc_token=' + token } })).status).toBe(401);
    });
  });

  it('数据库异常返回错误而非误报未登录，且不放行受保护接口', async () => {
    const { token } = await login('admin', 'old-password');
    db.admin.findUnique.mockRejectedValue(new Error('测试数据库不可用'));
    await withServer(async url => expect((await fetch(url + '/private', { headers: { Cookie: 'drc_token=' + token } })).status).toBe(500));
  });

  it('退出后原 Cookie 无法重放，另一设备的登录继续有效', async () => {
    const current = await login('admin', 'old-password');
    const other = (await login('admin', 'old-password')).token;
    expect(other).not.toBe(current.token);
    await withServer(async url => {
      const response = await fetch(url + '/api/auth/logout', { method: 'POST', headers: { Cookie: 'drc_token=' + current.token } });
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970');
      expect((await fetch(url + '/private', { headers: { Cookie: 'drc_token=' + current.token } })).status).toBe(401);
      expect((await fetch(url + '/private', { headers: { Cookie: 'drc_token=' + other } })).status).toBe(200);
      expect([...settings.values()].some(value => value.includes(current.token))).toBe(false);
    });
  });
});

function proof(overrides: Record<string, unknown> = {}) {
  const token = jwt.sign({ purpose: 'login-pow-v1', username: 'admin', nonce: '00'.repeat(16), difficulty: 22,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, ...overrides },
  createHmac('sha256', config.jwtSecret).update('login-pow-v1').digest(), { algorithm: 'HS256' });
  // 固定合成挑战的已知解，SHA-256 为 00000115...；测试无需反复执行高难度搜索。
  return { token, counter: 7944001 };
}

describe('渐进式工作量挑战', () => {
  it('账户前三次失败后触发，换用户名不能降低难度，窗口过去后恢复', async () => {
    expect(await createLoginChallenge('admin')).toEqual({ required: false });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => login('name-' + index, 'wrong-password')));
    const errors = outcomes.map(outcome => outcome.status === 'rejected' ? outcome.reason.status : 200);
    expect(errors.filter(status => status === 400)).toHaveLength(3);
    expect(errors.filter(status => status === 428)).toHaveLength(5);
    const first = await createLoginChallenge('admin');
    const second = await createLoginChallenge('another-name');
    expect(first).toMatchObject({ required: true, challenge: { difficulty: 18 } });
    expect(second).toMatchObject({ required: true, challenge: { difficulty: 18 } });
    if (first.required && second.required) {
      expect(first.challenge.nonce).not.toBe(second.challenge.nonce);
      expect(first.challenge.expiresInMs).toBeLessThanOrEqual(120_000);
    }
    for (const [count, difficulty] of [[6, 20], [9, 22], [100, 22]]) {
      settings.set('auth.loginFailures', JSON.stringify({ count, lastFailedAt: Date.now() }));
      expect(await loginDifficulty(db as any)).toBe(difficulty);
    }
    settings.set('auth.loginFailures', JSON.stringify({ count: 100, lastFailedAt: Date.now() - 16 * 60_000 }));
    expect(await loginDifficulty(db as any)).toBe(0);
  });

  it('验证错误、过期、跨用户名、跨用途及降级挑战均在校验密码前拒绝', async () => {
    settings.set('auth.loginFailures', JSON.stringify({ count: 9, lastFailedAt: Date.now() }));
    const compare = vi.spyOn(bcrypt, 'compare');
    for (const input of [undefined, null, { ...proof(), counter: 1 }, { ...proof(), counter: -1 },
      { ...proof(), counter: 0x100000000 }, { ...proof(), token: 'invalid' },
      proof({ difficulty: 18 }), proof({ username: 'someone-else' }), proof({ purpose: 'another-purpose' }),
      proof({ iat: Math.floor(Date.now() / 1000) - 300, exp: Math.floor(Date.now() / 1000) - 180 })]) {
      await expect(login('admin', 'old-password', input)).rejects.toMatchObject({ status: 428 });
    }
    expect(compare).not.toHaveBeenCalled();
    expect(db.appSetting.create).not.toHaveBeenCalled();
  });

  it('一次解答只允许一次猜测，错误密码仍消费挑战，并发重放被拒绝', async () => {
    settings.set('auth.loginFailures', JSON.stringify({ count: 3, lastFailedAt: Date.now() }));
    settings.set('auth.loginProof.expired-test', new Date(Date.now() - 1).toISOString());
    settings.set('unrelated', '2000-01-01T00:00:00.000Z');
    const input = proof();
    const result = await Promise.allSettled([login('admin', 'wrong-password', input), login('admin', 'wrong-password', input)]);
    expect(result.map(outcome => outcome.status === 'rejected' ? outcome.reason.status : 200)).toEqual([400, 428]);
    expect(JSON.parse(settings.get('auth.loginFailures')!).count).toBe(4);
    expect(settings.has('auth.loginProof.' + '00'.repeat(16))).toBe(true);
    expect(settings.has('auth.loginProof.expired-test')).toBe(false);
    expect(settings.has('unrelated')).toBe(true);
  });

  it('正确解答与密码可以登录并清除失败状态，已消费挑战仍不可重复使用', async () => {
    settings.set('auth.loginFailures', JSON.stringify({ count: 9, lastFailedAt: Date.now() }));
    const input = proof();
    expect((await login('admin', 'old-password', input)).token).toBeTruthy();
    expect(await createLoginChallenge('admin')).toEqual({ required: false });
    await expect(login('admin', 'old-password', input)).rejects.toMatchObject({ status: 428 });
    expect((await login('admin', 'old-password')).token).toBeTruthy();
  });

  it('真实路由执行挑战门禁并设置安全 Cookie，改密后当前 Cookie 自动更新', async () => {
    await withServer(async url => {
      const post = (route: string, body: unknown, cookie?: string) => fetch(url + '/api/auth' + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
      });
      for (let index = 0; index < 3; index++) expect((await post('/login', { username: 'admin', password: 'wrong-password' })).status).toBe(400);
      expect((await post('/login', { username: 'admin', password: 'old-password' })).status).toBe(428);
      const challenge = await post('/login-challenge', { username: 'admin' });
      expect(await challenge.json()).toMatchObject({ required: true, challenge: { difficulty: 18 } });
      const loggedIn = await post('/login', { username: 'admin', password: 'old-password', proof: proof() });
      expect(loggedIn.status).toBe(200);
      expect(loggedIn.headers.get('set-cookie')).toContain('HttpOnly');
      expect(loggedIn.headers.get('set-cookie')).toContain('SameSite=Lax');
      const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
      const changed = await post('/password', { oldPassword: 'old-password', newPassword: 'new-password' }, cookie);
      expect(changed.status).toBe(200);
      const updated = changed.headers.get('set-cookie')!.split(';')[0];
      expect((await fetch(url + '/private', { headers: { Cookie: cookie } })).status).toBe(401);
      expect((await fetch(url + '/private', { headers: { Cookie: updated } })).status).toBe(200);
    });
  });
});

describe('PIN 事务与并发安全', () => {
  it('并发错误尝试只校验五次，此后的请求被锁定，失败次数必须提交', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => requireValidPin('000000')));
    const errors = outcomes.map(outcome => outcome.status === 'rejected' ? outcome.reason.status : 200);
    expect(errors.filter(status => status === 400)).toHaveLength(5);
    expect(errors.filter(status => status === 429)).toHaveLength(7);
    expect(admin.pinFailCount).toBe(5);
    expect(admin.pinLockedUntil.getTime()).toBeGreaterThan(Date.now());
    expect(db.$queryRaw).toHaveBeenCalledTimes(12);
    expect(db.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    await expect(requireValidPin('123456')).rejects.toMatchObject({ status: 429 });
  });

  it('锁定到期后重新开始计数，正确 PIN 清除失败状态', async () => {
    admin.pinFailCount = 5; admin.pinLockedUntil = new Date(Date.now() - 1);
    await expect(requireValidPin('000000')).rejects.toMatchObject({ status: 400 });
    expect(admin.pinFailCount).toBe(1); expect(admin.pinLockedUntil).toBeNull();
    await requireValidPin('123456');
    expect(admin.pinFailCount).toBe(0);
  });

  it('保存敏感信息与更换 PIN 并发时最终全部使用新密钥', async () => {
    const save = withValidPin('123456', async (key, tx) => {
      expect(tx).toBe(db);
      await new Promise(resolve => setTimeout(resolve, 10));
      cards.push({ id: 1, cardNoFullEnc: encrypt(key, '6222000011111234'), expDateEnc: encrypt(key, '12/29'), cvvEnc: null });
    });
    await Promise.all([save, changePin('123456', '654321')]);
    const key = await requireValidPin('654321');
    expect(decrypt(key, cards[0].cardNoFullEnc)).toBe('6222000011111234');
    expect(decrypt(key, cards[0].expDateEnc)).toBe('12/29');
    await expect(requireValidPin('123456')).rejects.toMatchObject({ status: 400 });
  });

  it('换 PIN 中途失败时回滚全部密文和校验信息', async () => {
    const key = await requireValidPin('123456');
    cards = [1, 2].map(id => ({ id, cvvEnc: encrypt(key, '123'), cardNoFullEnc: null, expDateEnc: null }));
    const before = structuredClone(cards);
    db.card.update.mockImplementation(async ({ where, data }) => {
      if (where.id === 2) throw new Error('写入失败');
      Object.assign(cards[0], data);
    });
    await expect(changePin('123456', '654321')).rejects.toThrow('写入失败');
    expect(cards).toEqual(before);
    expect(decrypt(await requireValidPin('123456'), cards[0].cvvEnc)).toBe('123');
  });

  it('并发首次设置只有一个成功；销毁必须验证 PIN 且整体提交', async () => {
    admin.pinSalt = null; admin.pinVerifier = null;
    const result = await Promise.allSettled([setPin('123456'), setPin('654321')]);
    expect(result.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    await expect(destroyPin('000000')).rejects.toMatchObject({ status: 400 });
    expect(admin.pinVerifier).not.toBeNull();
    await destroyPin('123456');
    expect(admin.pinVerifier).toBeNull();
    expect(db.card.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('浏览器边界', () => {
  it('阻断跨站和同站不同源写入，支持正常同源和非浏览器调用', async () => {
    await withServer(async url => {
      for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: 'null' },
        { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        expect((await fetch(url + '/write', { method: 'POST', headers })).status).toBe(403);
      }
      for (const headers of [{ Origin: url }, { 'Sec-Fetch-Site': 'same-origin', Origin: url }, {}]) {
        expect((await fetch(url + '/write', { method: 'POST', headers })).status).toBe(200);
      }
    });
  });

  it('认证响应禁止缓存并防止第三方框架嵌套', async () => {
    await withServer(async url => {
      const response = await fetch(url + '/private');
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    });
  });

  it('并发请求和伪造转发头均不能绕过尝试次数限制', async () => {
    await withServer(async url => {
      const responses = await Promise.all(Array.from({ length: 9 }, (_, index) => fetch(url + '/limited', {
        method: 'POST', headers: { 'X-Forwarded-For': `203.0.113.${index + 1}` },
      })));
      expect(responses.filter(response => response.status === 400)).toHaveLength(3);
      expect(responses.filter(response => response.status === 429)).toHaveLength(6);
      expect(responses.find(response => response.status === 429)?.headers.get('retry-after')).toBeTruthy();
    });
  });

  it('成功登录不累积失败额度', async () => {
    await withServer(async url => {
      for (let index = 0; index < 8; index++) expect((await fetch(url + '/successful', { method: 'POST' })).status).toBe(200);
    });
  });
});
