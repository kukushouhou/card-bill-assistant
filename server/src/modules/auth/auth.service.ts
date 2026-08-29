import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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

const JWT_EXPIRES_IN = '7d';

async function getAdmin() {
  const admin = await prisma.admin.findFirst({ orderBy: { id: 'asc' } });
  if (!admin) throw new ApiError(503, '系统未安装，请先完成安装向导');
  return admin;
}

// ===== 登录与密码 =====

export async function login(username: string, password: string): Promise<{ token: string }> {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new ApiError(400, '用户名或密码格式错误');
  }
  const admin = await getAdmin();
  if (admin.username !== username || !(await bcrypt.compare(password, admin.passwordHash))) {
    throw new ApiError(400, '用户名或密码错误');
  }
  const token = jwt.sign({ sub: admin.id, username: admin.username }, config.jwtSecret, {
    expiresIn: JWT_EXPIRES_IN,
  });
  return { token };
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
    throw new ApiError(400, '参数格式错误');
  }
  if (newPassword.length < 8) throw new ApiError(400, '新密码长度至少 8 位');
  const admin = await getAdmin();
  if (!(await bcrypt.compare(oldPassword, admin.passwordHash))) {
    throw new ApiError(400, '原密码错误');
  }
  await prisma.admin.update({
    where: { id: admin.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
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

/** 校验 PIN 并返回派生密钥。含防爆破：连续 5 次失败锁定 15 分钟。PIN 校验后立即弃用，不落库不缓存。 */
export async function requireValidPin(pin: unknown): Promise<Buffer> {
  const admin = await getAdmin();
  if (!admin.pinSalt || !admin.pinVerifier) throw new ApiError(400, '尚未设置 PIN，请先在设置页设置');
  if (!isValidPinFormat(pin)) throw new ApiError(400, 'PIN 必须为 6 位数字');

  // 锁定期已过则重置计数
  if (admin.pinLockedUntil && admin.pinLockedUntil <= new Date() && admin.pinFailCount > 0) {
    await prisma.admin.update({
      where: { id: admin.id },
      data: { pinFailCount: 0, pinLockedUntil: null },
    });
    admin.pinFailCount = 0;
  }
  if (admin.pinLockedUntil && admin.pinLockedUntil > new Date()) {
    throw new ApiError(429, 'PIN 已锁定，请稍后再试');
  }

  const key = verifyPin(config.encryptionKey, pin, Buffer.from(admin.pinSalt), Buffer.from(admin.pinVerifier));
  if (!key) {
    const failCount = admin.pinFailCount + 1;
    const locked = failCount >= 5;
    await prisma.admin.update({
      where: { id: admin.id },
      data: {
        pinFailCount: locked ? 0 : failCount,
        pinLockedUntil: locked ? new Date(Date.now() + 15 * 60_000) : null,
      },
    });
    throw new ApiError(400, 'PIN 校验失败');
  }
  if (admin.pinFailCount > 0) {
    await prisma.admin.update({
      where: { id: admin.id },
      data: { pinFailCount: 0, pinLockedUntil: null },
    });
  }
  return key;
}

export async function setPin(pin: unknown): Promise<void> {
  if (!isValidPinFormat(pin)) throw new ApiError(400, 'PIN 必须为 6 位数字');
  const admin = await getAdmin();
  if (admin.pinVerifier) throw new ApiError(400, 'PIN 已设置，如需更换请使用修改功能');
  const pinSalt = randomBytes(16);
  const pinKey = derivePinKey(config.encryptionKey, pin, pinSalt);
  await prisma.admin.update({
    where: { id: admin.id },
    data: {
      pinSalt,
      pinVerifier: makePinVerifier(pinKey),
      pinFailCount: 0,
      pinLockedUntil: null,
    },
  });
}

export async function changePin(oldPin: unknown, newPin: unknown): Promise<void> {
  if (!isValidPinFormat(newPin)) throw new ApiError(400, '新 PIN 必须为 6 位数字');
  const oldKey = await requireValidPin(oldPin); // 含防爆破
  const admin = await getAdmin();
  const pinSalt = randomBytes(16);
  const newKey = derivePinKey(config.encryptionKey, newPin, pinSalt);

  const cards = await prisma.card.findMany({
    where: { OR: [{ cardNoFullEnc: { not: null } }, { expDateEnc: { not: null } }, { cvvEnc: { not: null } }] },
  });
  await prisma.$transaction(async (tx) => {
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
export async function destroyPin(): Promise<{ destroyedCards: number }> {
  const admin = await getAdmin();
  const result = await prisma.card.updateMany({
    where: { OR: [{ cardNoFullEnc: { not: null } }, { expDateEnc: { not: null } }, { cvvEnc: { not: null } }] },
    data: { cardNoFullEnc: null, expDateEnc: null, cvvEnc: null },
  });
  await prisma.admin.update({
    where: { id: admin.id },
    data: { pinSalt: null, pinVerifier: null, pinFailCount: 0, pinLockedUntil: null },
  });
  return { destroyedCards: result.count };
}
