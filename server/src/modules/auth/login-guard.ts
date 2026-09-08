import { createHash, createHmac, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Prisma } from '../../generated/prisma/client';
import { config } from '../../config';
import { ApiError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

const FAILURE_KEY = 'auth.loginFailures';
const USED_PREFIX = 'auth.loginProof.';
const PURPOSE = 'login-pow-v1';
const WINDOW_MS = 15 * 60_000;
const CHALLENGE_SECONDS = 120;
type Database = Pick<Prisma.TransactionClient, 'appSetting'>;

interface FailureState { count: number; lastFailedAt: number }
export interface LoginProof { token: string; counter: number }
export interface LoginChallenge { token: string; nonce: string; difficulty: number; expiresInMs: number }

async function failures(db: Database): Promise<FailureState> {
  const row = await db.appSetting.findUnique({ where: { key: FAILURE_KEY } });
  if (row) {
    try {
      const state = JSON.parse(row.value) as FailureState;
      if (Number.isSafeInteger(state.count) && state.count >= 0 && Number.isFinite(state.lastFailedAt)
        && Date.now() - state.lastFailedAt < WINDOW_MS) return state;
    } catch { /* 损坏的计数不作为身份凭证，按新窗口重新记录。 */ }
  }
  return { count: 0, lastFailedAt: 0 };
}

/** 单管理员按账户累计失败，换 IP 或用户名不能把计算难度清零。 */
export async function loginDifficulty(db: Database): Promise<number> {
  const { count } = await failures(db);
  return count < 3 ? 0 : count < 6 ? 18 : count < 9 ? 20 : 22;
}

export async function recordLoginFailure(db: Database): Promise<void> {
  const previous = await failures(db);
  const value = JSON.stringify({ count: Math.min(100, previous.count + 1), lastFailedAt: Date.now() });
  await db.appSetting.upsert({ where: { key: FAILURE_KEY }, create: { key: FAILURE_KEY, value }, update: { value } });
}

export async function clearLoginFailures(db: Database): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: FAILURE_KEY } });
}

function signingKey(): Buffer {
  // 与登录凭证隔离用途，工作量挑战不能被当作登录 JWT 使用。
  return createHmac('sha256', config.jwtSecret).update(PURPOSE).digest();
}

export async function createLoginChallenge(username: unknown): Promise<{ required: false } | { required: true; challenge: LoginChallenge }> {
  if (typeof username !== 'string' || !username || username.length > 100) throw new ApiError(400, '用户名格式错误');
  const difficulty = await loginDifficulty(prisma);
  if (!difficulty) return { required: false };
  const nonce = randomBytes(16).toString('hex');
  const issuedAt = Math.floor(Date.now() / 1_000);
  const token = jwt.sign({ purpose: PURPOSE, username, nonce, difficulty, iat: issuedAt }, signingKey(), {
    algorithm: 'HS256', expiresIn: CHALLENGE_SECONDS,
  });
  return { required: true, challenge: { token, nonce, difficulty, expiresInMs: (issuedAt + CHALLENGE_SECONDS) * 1_000 - Date.now() } };
}

function hasWork(nonce: string, counter: number, difficulty: number): boolean {
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(counter);
  const hash = createHash('sha256').update(`${PURPOSE}:${nonce}:`).update(suffix).digest();
  const whole = Math.floor(difficulty / 8);
  for (let index = 0; index < whole; index++) if (hash[index] !== 0) return false;
  const rest = difficulty % 8;
  return rest === 0 || (hash[whole] >>> (8 - rest)) === 0;
}

/** 在管理员事务锁内验证并消费；即使密码猜错，已使用标记也必须提交。 */
export async function consumeLoginProof(db: Database, username: string, input: unknown, requiredDifficulty: number): Promise<boolean> {
  if (!input || typeof input !== 'object') return false;
  const { token, counter } = input as Partial<LoginProof>;
  if (typeof token !== 'string' || token.length > 2_000 || !Number.isSafeInteger(counter) || counter! < 0 || counter! > 0xffffffff) return false;
  let payload: jwt.JwtPayload;
  try {
    const parsed = jwt.verify(token, signingKey(), { algorithms: ['HS256'], maxAge: CHALLENGE_SECONDS + 's' });
    if (typeof parsed !== 'object' || !parsed) return false;
    payload = parsed;
  } catch { return false; }
  if (payload.purpose !== PURPOSE || payload.username !== username || !Number.isFinite(payload.exp)
    || typeof payload.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(payload.nonce)
    || ![18, 20, 22].includes(payload.difficulty) || payload.difficulty < requiredDifficulty
    || !hasWork(payload.nonce, counter!, payload.difficulty)) return false;
  await db.appSetting.deleteMany({ where: { key: { startsWith: USED_PREFIX }, value: { lt: new Date().toISOString() } } });
  try {
    await db.appSetting.create({ data: { key: USED_PREFIX + payload.nonce, value: new Date(payload.exp! * 1_000).toISOString() } });
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return false;
    throw error;
  }
}
