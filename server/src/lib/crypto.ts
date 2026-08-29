import crypto from 'node:crypto';

/**
 * 加密体系（双密钥设计）：
 * - 环境密钥（32B，来自 ENCRYPTION_KEY）：加密服务自主运行所需的数据（邮箱授权码）
 * - PIN 派生密钥：仅用于卡号/有效期/CVV。派生方式：
 *     pinMaterial = PBKDF2-SHA256(PIN, pinSalt, 100000, 32B)
 *     pinKey      = HKDF-SHA256(ikm=envKey, salt=pinMaterial, info="card-secret-v1", 32B)
 *   PIN 本身与派生密钥均不落库、不进日志，请求结束即弃。
 *
 * 密文格式：iv(12B) + authTag(16B) + ciphertext（AES-256-GCM）
 */

const PIN_KDF_ITERATIONS = 100_000;
const PIN_HKDF_INFO = Buffer.from('card-secret-v1', 'utf8');
const PIN_VERIFIER_PLAINTEXT = 'pin-verify-v1';

export function encrypt(key: Buffer, plaintext: string): Uint8Array<ArrayBuffer> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return toBytes(Buffer.concat([iv, tag, enc]));
}

export function decrypt(key: Buffer, data: Uint8Array | Buffer): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 28) throw new Error('密文格式非法');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Buffer → 独立 ArrayBuffer 背书的 Uint8Array（Prisma Bytes 字段类型要求） */
export function toBytes(b: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
}

/** 随机字节（Prisma Bytes 兼容类型） */
export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return toBytes(crypto.randomBytes(n));
}

/** 由 PIN + 盐 + 环境密钥派生卡敏感信息加密密钥 */
export function derivePinKey(envKey: Buffer, pin: string, pinSalt: Uint8Array | Buffer): Buffer {
  const pinMaterial = crypto.pbkdf2Sync(pin, pinSalt, PIN_KDF_ITERATIONS, 32, 'sha256');
  return Buffer.from(crypto.hkdfSync('sha256', envKey, pinMaterial, PIN_HKDF_INFO, 32));
}

/** 生成 PIN 校验密文（用于在不存储 PIN 的前提下验证 PIN 正确性） */
export function makePinVerifier(pinKey: Buffer): Uint8Array<ArrayBuffer> {
  return encrypt(pinKey, PIN_VERIFIER_PLAINTEXT);
}

/** 校验 PIN：成功返回派生密钥，失败返回 null */
export function verifyPin(
  envKey: Buffer,
  pin: string,
  pinSalt: Uint8Array | Buffer,
  pinVerifier: Uint8Array | Buffer,
): Buffer | null {
  try {
    const key = derivePinKey(envKey, pin, pinSalt);
    const s = decrypt(key, pinVerifier);
    return s === PIN_VERIFIER_PLAINTEXT ? key : null;
  } catch {
    return null;
  }
}

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{6}$/.test(pin);
}
