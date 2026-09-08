import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { api, ApiError } from '../api/client';
import { loginWithProof, solveLoginChallenge } from './loginProof';
import { findLoginProof } from './loginProof.solver';

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { TestWorker.instances.push(this); }
}
const challenge = { token: 'synthetic-challenge-token', nonce: '00'.repeat(16), difficulty: 18, expiresInMs: 120_000 };
beforeEach(() => { TestWorker.instances = []; vi.stubGlobal('Worker', TestWorker); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('登录工作量验证', () => {
  it('未触发挑战时不启动计算，直接完成登录', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce({ required: false }).mockResolvedValueOnce({ ok: true });
    const controller = new AbortController();
    await loginWithProof('admin', 'synthetic-password', controller.signal);
    expect(TestWorker.instances).toHaveLength(0);
    expect(post).toHaveBeenLastCalledWith('/api/auth/login', { username: 'admin', password: 'synthetic-password' }, { signal: controller.signal });
  });

  it('工作线程只收到公开挑战，成功、取消和异常时都立即终止', async () => {
    const controller = new AbortController();
    const solved = solveLoginChallenge(challenge, controller.signal);
    const worker = TestWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith({ nonce: challenge.nonce, difficulty: 18, expiresAt: expect.any(Number) });
    worker.onmessage!({ data: { counter: 123 } } as MessageEvent);
    await expect(solved).resolves.toEqual({ token: challenge.token, counter: 123 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    const cancelled = solveLoginChallenge(challenge, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(TestWorker.instances[1].terminate).toHaveBeenCalledOnce();
    const failed = solveLoginChallenge(challenge, new AbortController().signal);
    TestWorker.instances[2].onerror!();
    await expect(failed).rejects.toMatchObject({ status: 400 });
    expect(TestWorker.instances[2].terminate).toHaveBeenCalledOnce();
  });

  it('难度在预检后变化时只补取一次挑战，错误密码绝不自动重试', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce({ required: false })
      .mockRejectedValueOnce(new ApiError(428, '安全验证'))
      .mockResolvedValueOnce({ required: false }).mockResolvedValueOnce({ ok: true });
    await loginWithProof('admin', 'synthetic-password', new AbortController().signal);
    expect(post).toHaveBeenCalledTimes(4);
    post.mockReset().mockResolvedValueOnce({ required: false }).mockRejectedValueOnce(new ApiError(400, '密码错误'));
    await expect(loginWithProof('admin', 'wrong-password', new AbortController().signal)).rejects.toMatchObject({ status: 400 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('超时和畸形工作结果不会提交凭据', async () => {
    vi.useFakeTimers();
    const expired = solveLoginChallenge({ ...challenge, expiresInMs: 1 }, new AbortController().signal);
    const assertion = expect(expired).rejects.toMatchObject({ status: 400 });
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    const invalid = solveLoginChallenge(challenge, new AbortController().signal);
    TestWorker.instances[1].onmessage!({ data: { counter: -1 } } as MessageEvent);
    await expect(invalid).rejects.toMatchObject({ status: 400 });
  });

  it('真实 SHA-256 搜索的结果通过独立 Node 校验，过期或超限难度在计算前拒绝', () => {
    const input = { nonce: challenge.nonce, difficulty: 18, expiresAt: Date.now() + 20_000 };
    const counter = findLoginProof(input);
    const suffix = Buffer.alloc(4); suffix.writeUInt32BE(counter);
    const hash = createHash('sha256').update('login-pow-v1:' + input.nonce + ':').update(suffix).digest();
    expect(hash[0]).toBe(0); expect(hash[1]).toBe(0); expect(hash[2] >>> 6).toBe(0);
    expect(() => findLoginProof({ ...input, difficulty: 30 })).toThrow();
    expect(() => findLoginProof({ ...input, expiresAt: Date.now() - 1 })).toThrow();
  }, 25_000);
});
