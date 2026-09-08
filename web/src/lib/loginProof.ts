import { api, ApiError } from '../api/client';
import type { WorkInput } from './loginProof.solver';

interface Challenge extends Omit<WorkInput, 'expiresAt'> { token: string; expiresInMs: number }
interface Proof { token: string; counter: number }
type ChallengeResponse = { required: false } | { required: true; challenge: Challenge };

export function solveLoginChallenge(challenge: Challenge, signal: AbortSignal): Promise<Proof> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('请求已取消', 'AbortError')); return; }
    let worker: Worker;
    try { worker = new Worker(new URL('./loginProof.worker.ts', import.meta.url), { type: 'module' }); }
    catch { reject(new ApiError(400, '当前浏览器无法完成安全验证，请更新浏览器后重试')); return; }
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { worker.terminate(); clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('请求已取消', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ counter?: number; error?: string }>) => {
      cleanup();
      if (!Number.isSafeInteger(event.data.counter) || event.data.counter! < 0 || event.data.counter! > 0xffffffff) {
        reject(new ApiError(400, '安全验证未完成，请重试'));
      } else resolve({ token: challenge.token, counter: event.data.counter! });
    };
    worker.onerror = () => { cleanup(); reject(new ApiError(400, '安全验证未完成，请重试')); };
    // 使用相对有效期，避免客户端时钟与服务器时钟不一致导致正常用户无法登录。
    const remaining = Math.min(120_000, Math.max(1, challenge.expiresInMs));
    timer = setTimeout(() => { cleanup(); reject(new ApiError(400, '安全验证已过期，请重试')); }, remaining);
    // 工作线程只接收公开挑战，不接收密码或登录凭证。
    worker.postMessage({ nonce: challenge.nonce, difficulty: challenge.difficulty, expiresAt: Date.now() + remaining });
  });
}

export async function loginWithProof(username: string, password: string, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await api.post<ChallengeResponse>('/api/auth/login-challenge', { username }, { signal });
    const proof = response.required ? await solveLoginChallenge(response.challenge, signal) : undefined;
    try {
      await api.post('/api/auth/login', { username, password, ...(proof ? { proof } : {}) }, { signal });
      return;
    } catch (error) {
      // 预检后难度改变或挑战刚好过期时，只重新取一次挑战；密码错误绝不自动重试。
      if (!(error instanceof ApiError) || error.status !== 428 || attempt > 0) throw error;
    }
  }
}
