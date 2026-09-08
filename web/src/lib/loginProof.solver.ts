import { sha256 } from '@noble/hashes/sha2.js';

export interface WorkInput { nonce: string; difficulty: number; expiresAt: number }

/** 只在 Worker 中调用；使用可在局域网 HTTP 下运行的 SHA-256 实现。 */
export function findLoginProof({ nonce, difficulty, expiresAt }: WorkInput): number {
  if (!/^[a-f0-9]{32}$/.test(nonce) || ![18, 20, 22].includes(difficulty) || !Number.isFinite(expiresAt)) throw new Error('安全验证参数无效');
  const prefix = new TextEncoder().encode(`login-pow-v1:${nonce}:`);
  const input = new Uint8Array(prefix.length + 4);
  input.set(prefix);
  const counterBytes = new DataView(input.buffer, prefix.length, 4);
  const whole = Math.floor(difficulty / 8);
  const rest = difficulty % 8;
  for (let counter = 0; counter <= 0xffffffff; counter++) {
    if ((counter & 4095) === 0 && Date.now() >= expiresAt) throw new Error('安全验证已过期，请重试');
    counterBytes.setUint32(0, counter, false);
    const hash = sha256(input);
    let valid = true;
    for (let index = 0; index < whole; index++) if (hash[index] !== 0) { valid = false; break; }
    if (valid && (rest === 0 || (hash[whole] >>> (8 - rest)) === 0)) return counter;
  }
  throw new Error('安全验证未完成，请重试');
}
