import { describe, expect, it } from 'vitest';
import {
  decrypt,
  derivePinKey,
  encrypt,
  isValidPinFormat,
  makePinVerifier,
  randomBytes,
  toBytes,
  verifyPin,
} from '../src/lib/crypto';

const envKey = Buffer.alloc(32, 7); // 测试用固定密钥

describe('AES-256-GCM 加解密', () => {
  it('加解密往返一致', () => {
    const data = '6225 8812 3456 7890';
    const enc = encrypt(envKey, data);
    expect(enc).not.toEqual(Buffer.from(data));
    expect(decrypt(envKey, enc)).toBe(data);
  });

  it('同一明文两次加密产生不同密文（随机 IV）', () => {
    const a = encrypt(envKey, 'secret');
    const b = encrypt(envKey, 'secret');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('密文被篡改后解密失败（GCM 完整性校验）', () => {
    const enc = encrypt(envKey, 'secret');
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decrypt(envKey, tampered)).toThrow();
  });

  it('错误密钥解密失败', () => {
    const enc = encrypt(envKey, 'secret');
    const wrongKey = Buffer.alloc(32, 8);
    expect(() => decrypt(wrongKey, enc)).toThrow();
  });

  it('toBytes 产出独立 ArrayBuffer 背书的 Uint8Array', () => {
    const buf = Buffer.from('hello');
    const u8 = toBytes(buf);
    expect(u8 instanceof Uint8Array).toBe(true);
    expect(u8.buffer instanceof ArrayBuffer).toBe(true);
    expect(Buffer.from(u8).toString()).toBe('hello');
  });

  it('randomBytes 返回指定长度', () => {
    expect(randomBytes(16).byteLength).toBe(16);
    expect(randomBytes(32).byteLength).toBe(32);
  });
});

describe('PIN 双密钥派生', () => {
  it('正确 PIN 通过校验并返回派生密钥', () => {
    const salt = randomBytes(16);
    const pinKey = derivePinKey(envKey, '123456', salt);
    const verifier = makePinVerifier(pinKey);
    const verified = verifyPin(envKey, '123456', salt, verifier);
    expect(verified).not.toBeNull();
    expect(Buffer.from(verified!).equals(pinKey)).toBe(true);
  });

  it('错误 PIN 校验失败', () => {
    const salt = randomBytes(16);
    const pinKey = derivePinKey(envKey, '123456', salt);
    const verifier = makePinVerifier(pinKey);
    expect(verifyPin(envKey, '654321', salt, verifier)).toBeNull();
  });

  it('不同盐派生出不同密钥', () => {
    const k1 = derivePinKey(envKey, '123456', randomBytes(16));
    const k2 = derivePinKey(envKey, '123456', randomBytes(16));
    expect(k1.equals(k2)).toBe(false);
  });

  it('环境密钥参与派生（换环境密钥则旧密文不可解）', () => {
    const salt = randomBytes(16);
    const k1 = derivePinKey(envKey, '123456', salt);
    const k2 = derivePinKey(Buffer.alloc(32, 9), '123456', salt);
    expect(k1.equals(k2)).toBe(false);
  });

  it('PIN 格式校验', () => {
    expect(isValidPinFormat('123456')).toBe(true);
    expect(isValidPinFormat('12345')).toBe(false);
    expect(isValidPinFormat('1234567')).toBe(false);
    expect(isValidPinFormat('abcdef')).toBe(false);
    expect(isValidPinFormat(123456)).toBe(false);
  });

  it('PIN 密钥加密的数据只能用同一 PIN 解开', () => {
    const salt = randomBytes(16);
    const k1 = derivePinKey(envKey, '111111', salt);
    const k2 = derivePinKey(envKey, '222222', salt);
    const enc = encrypt(k1, '4000000000000000000');
    expect(() => decrypt(k2, enc)).toThrow();
    expect(decrypt(k1, enc)).toBe('4000000000000000000');
  });
});
