import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { Admin, Prisma } from '../../generated/prisma/client';
import { prisma } from '../../lib/prisma';
import { config } from '../../config';
import { ApiError } from '../../lib/errors';
import {
  decrypt,
  derivePinKey,
  encrypt,
  isValidPinFormat,
  makePinVerifier,
  randomBytes,
  verifyPin,
} from '../../lib/crypto';
import { SESSION_VERSION_KEY, sessionVersion, signSession } from './session';
import { clearLoginFailures, consumeLoginProof, loginDifficulty, recordLoginFailure } from './login-guard';

async function getAdmin(db: Pick<Prisma.TransactionClient, 'admin'> = prisma) {
  const admin = await db.admin.findFirst({ orderBy: { id: 'asc' } });
  if (!admin) throw new ApiError(503, '系统未安装，请先完成安装向导');
  return admin;
}

/** 所有 PIN 验证、换钥和敏感字段写入共用数据库行锁，跨请求/进程保持一致。 */
async function withAdminLock<T>(run: (tx: Prisma.TransactionClient, admin: Admin) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM Admin ORDER BY id ASC LIMIT 1 FOR UPDATE`;
    return run(tx, await getAdmin(tx));
  });
}

export function validateNewPassword(password: string): void {
  if (password.length < 8) throw new ApiError(400, '新密码长度至少 8 位');
  // bcrypt 只使用前 72 个字节；按字符计数会把不同的中文长密码视作同一个密码。
  if (Buffer.byteLength(password, 'utf8') > 72) throw new ApiError(400, '密码不能超过 72 个字节');
}

// ===== 登录与密码 =====

export async function login(username: string, password: string, proof?: unknown): Promise<{ token: string }> {
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 1_024) {
    throw new ApiError(400, '用户名或密码格式错误');
  }
  const result = await withAdminLock(async (tx, admin) => {
    const difficulty = await loginDifficulty(tx);
    if ((difficulty || proof !== undefined) && !(await consumeLoginProof(tx, username, proof, difficulty))) {
      return { error: new ApiError(428, '请完成安全验证后重试') };
    }
    if (admin.username !== username || !(await bcrypt.compare(password, admin.passwordHash))) {
      await recordLoginFailure(tx);
      return { error: new ApiError(400, '用户名或密码错误') };
    }
    await clearLoginFailures(tx);
    return { token: signSession(admin, await sessionVersion(tx)) };
  });
  if ('error' in result) throw result.error;
  return result;
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<{ token: string }> {
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
    throw new ApiError(400, '参数格式错误');
  }
  validateNewPassword(newPassword);
  return withAdminLock(async (tx, admin) => {
    if (!(await bcrypt.compare(oldPassword, admin.passwordHash))) {
      throw new ApiError(400, '原密码错误');
    }
    await tx.admin.update({ where: { id: admin.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } });
    const version = randomUUID();
    await tx.appSetting.upsert({
      where: { key: SESSION_VERSION_KEY },
      create: { key: SESSION_VERSION_KEY, value: version },
      update: { value: version },
    });
    return { token: signSession(admin, version) };
  });
}

// ===== PIN 管理 =====

export interface PinStatus {
  hasPin: boolean;
  locked: boolean;
  lockedUntil: string | null;
}

export async function getPinStatus(): Promise<PinStatus> {
  const admin = await getAdmin();
  const locked = !!admin.pinLockedUntil && admin.pinLockedUntil > new Date();
  return {
    hasPin: !!admin.pinVerifier,
    locked,
    lockedUntil: locked ? admin.pinLockedUntil!.toISOString() : null,
  };
}

type PinCheck = { key: Buffer; error?: never } | { key?: never; error: ApiError };

async function checkPin(tx: Prisma.TransactionClient, admin: Admin, pin: unknown): Promise<PinCheck> {
  if (!admin.pinSalt || !admin.pinVerifier) return { error: new ApiError(400, '尚未设置 PIN，请先在设置页设置') };
  if (!isValidPinFormat(pin)) return { error: new ApiError(400, 'PIN 必须为 6 位数字') };
  const now = new Date();
  if (admin.pinLockedUntil && admin.pinLockedUntil > now) return { error: new ApiError(429, 'PIN 已锁定，请稍后再试') };
  const expired = !!admin.pinLockedUntil && admin.pinLockedUntil <= now;
  const key = verifyPin(config.encryptionKey, pin, Buffer.from(admin.pinSalt), Buffer.from(admin.pinVerifier));
  if (!key) {
    const failCount = (expired ? 0 : admin.pinFailCount) + 1;
    await tx.admin.update({
      where: { id: admin.id },
      data: { pinFailCount: failCount, pinLockedUntil: failCount >= 5 ? new Date(now.getTime() + 15 * 60_000) : null },
    });
    // 返回错误值，事务先提交失败计数，再由调用方抛出；不能让抛异常回滚防爆破状态。
    return { error: new ApiError(400, 'PIN 校验失败') };
  }
  if (admin.pinFailCount > 0 || admin.pinLockedUntil) {
    await tx.admin.update({ where: { id: admin.id }, data: { pinFailCount: 0, pinLockedUntil: null } });
  }
  return { key };
}

/** 验证和敏感字段读写在同一事务中完成，防止换 PIN 与保存卡信息交错。 */
export async function withValidPin<T>(pin: unknown, run: (key: Buffer, tx: Prisma.TransactionClient, admin: Admin) => Promise<T>): Promise<T> {
  const result = await withAdminLock(async (tx, admin) => {
    const check = await checkPin(tx, admin, pin);
    if (check.error) return { error: check.error };
    return { value: await run(check.key, tx, admin) };
  });
  if ('error' in result) throw result.error;
  return result.value;
}

/** 独立校验不缓存 PIN 或派生密钥，卡片读写仍需再次校验。 */
export async function requireValidPin(pin: unknown): Promise<Buffer> {
  return withValidPin(pin, async (key) => key);
}

export async function setPin(pin: unknown): Promise<void> {
  if (!isValidPinFormat(pin)) throw new ApiError(400, 'PIN 必须为 6 位数字');
  await withAdminLock(async (tx, admin) => {
    if (admin.pinVerifier) throw new ApiError(400, 'PIN 已设置，如需更换请使用修改功能');
    const pinSalt = randomBytes(16);
    const pinKey = derivePinKey(config.encryptionKey, pin, pinSalt);
    await tx.admin.update({
      where: { id: admin.id },
      data: { pinSalt, pinVerifier: makePinVerifier(pinKey), pinFailCount: 0, pinLockedUntil: null },
    });
  });
}

export async function changePin(oldPin: unknown, newPin: unknown): Promise<void> {
  if (!isValidPinFormat(newPin)) throw new ApiError(400, '新 PIN 必须为 6 位数字');
  await withValidPin(oldPin, async (oldKey, tx, admin) => {
    const pinSalt = randomBytes(16);
    const newKey = derivePinKey(config.encryptionKey, newPin, pinSalt);
    const cards = await tx.card.findMany({
      where: { OR: [{ cardNoFullEnc: { not: null } }, { expDateEnc: { not: null } }, { cvvEnc: { not: null } }] },
    });
    for (const card of cards) {
      const data: {
        cardNoFullEnc?: Uint8Array<ArrayBuffer> | null;
        expDateEnc?: Uint8Array<ArrayBuffer> | null;
        cvvEnc?: Uint8Array<ArrayBuffer> | null;
      } = {};
      if (card.cardNoFullEnc) data.cardNoFullEnc = encrypt(newKey, decrypt(oldKey, Buffer.from(card.cardNoFullEnc)));
      if (card.expDateEnc) data.expDateEnc = encrypt(newKey, decrypt(oldKey, Buffer.from(card.expDateEnc)));
      if (card.cvvEnc) data.cvvEnc = encrypt(newKey, decrypt(oldKey, Buffer.from(card.cvvEnc)));
      await tx.card.update({ where: { id: card.id }, data });
    }
    await tx.admin.update({
      where: { id: admin.id },
      data: { pinSalt, pinVerifier: makePinVerifier(newKey), pinFailCount: 0, pinLockedUntil: null },
    });
  });
}

/** 忘记 PIN：作废所有卡敏感密文（提醒体系不受影响），之后可重新设置 PIN */
export async function destroyPin(pin: unknown): Promise<{ destroyedCards: number }> {
  const result = await withAdminLock(async (tx, admin) => {
    if (admin.pinVerifier) {
      const check = await checkPin(tx, admin, pin);
      if (check.error) return { error: check.error };
    }
    const cleared = await tx.card.updateMany({
      where: { OR: [{ cardNoFullEnc: { not: null } }, { expDateEnc: { not: null } }, { cvvEnc: { not: null } }] },
      data: { cardNoFullEnc: null, expDateEnc: null, cvvEnc: null },
    });
    await tx.admin.update({
      where: { id: admin.id },
      data: { pinSalt: null, pinVerifier: null, pinFailCount: 0, pinLockedUntil: null },
    });
    return { destroyedCards: cleared.count };
  });
  if ('error' in result) throw result.error;
  return result;
}
