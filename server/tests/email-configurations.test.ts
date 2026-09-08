import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ emailAccount: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() }, $transaction: vi.fn() }));
const testConnection = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/lib/crypto', () => ({ decrypt: () => 'synthetic-old-secret' }));
vi.mock('../src/config', () => ({ config: { encryptionKey: Buffer.alloc(32) } }));
vi.mock('../src/routes/middleware', () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../src/modules/email/email.service', () => ({ testConnection, encryptAuthPassword: (value: string) => Buffer.from(`sealed:${value}`) }));
vi.mock('../src/parsers/registry', () => ({ listParsers: vi.fn() }));
import emailRoutes from '../src/routes/email.routes';
import { ApiError } from '../src/lib/errors';
import { isUpgradeBusinessBlocked, setUpgradeRuntimeState, upgradeBusinessGate } from '../src/modules/upgrades/upgrade.runtime';

let server: Server;
let base: string;
const accounts = [1, 2].map(id => ({ id, email: `mail${id}@example.test`, authUser: `mail${id}@example.test`,
  imapHost: 'imap.qq.com', imapPort: id === 1 ? 993 : 143, tls: id === 1, authPasswordEnc: Buffer.from('synthetic-old-cipher') }));
beforeEach(async () => {
  vi.resetAllMocks();
  db.emailAccount.findMany.mockResolvedValue(accounts);
  db.$transaction.mockImplementation(async run => run(db));
  testConnection.mockResolvedValue({ ok: true, mailboxCount: 10 });
  setUpgradeRuntimeState({ mode: 'failed', planId: 8, message: '邮箱无法读取' });
  const app = express();
  app.use(express.json());
  app.use('/api', upgradeBusinessGate);
  app.use('/api/email', emailRoutes);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ApiError ? error.status : 400).json({ error: error instanceof Error ? error.message : '失败' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  setUpgradeRuntimeState({ mode: 'ready', planId: null, message: null });
});
const save = (rows: unknown[]) => fetch(`${base}/api/email/accounts/configurations`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts: rows }),
});

describe('迁移内多邮箱设置', () => {
  it('邮箱失败时设置接口放行，全部验证后同一事务保存，不推进迁移', async () => {
    expect(isUpgradeBusinessBlocked()).toBe(false);
    const response = await save([{ id: 1, authPassword: 'synthetic-new' }, { id: 2, imapHost: 'imap.163.com' }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(testConnection).toHaveBeenCalledTimes(2);
    expect(testConnection.mock.calls[1][0]).toMatchObject({ authPassword: 'synthetic-old-secret', imapHost: 'imap.163.com', imapPort: 143, tls: false });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.emailAccount.update).toHaveBeenCalledTimes(2);
    expect(db.emailAccount.update.mock.invocationCallOrder[0]).toBeGreaterThan(testConnection.mock.invocationCallOrder[1]);
  });

  it('任意邮箱验证失败时不保存任何配置，错误不泄露授权码', async () => {
    testConnection.mockRejectedValueOnce(new Error('AUTH failed secret-value'));
    const response = await save([{ id: 1, authPassword: 'secret-value' }, { id: 2 }]);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('mail1@example.test');
    expect(body).not.toContain('secret-value');
    expect(db.emailAccount.update).not.toHaveBeenCalled();
  });

  it('账户已删除或重复提交时不连接邮箱、不覆盖其他账户', async () => {
    db.emailAccount.findMany.mockResolvedValue([accounts[0]]);
    expect((await save([{ id: 1 }, { id: 2 }])).status).toBe(409);
    expect((await save([{ id: 1 }, { id: 1 }])).status).toBe(400);
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('正在执行迁移时仍等待该次执行结束，不能并发改邮箱', async () => {
    setUpgradeRuntimeState({ mode: 'executing', planId: 8, message: null });
    expect((await save([{ id: 1 }])).status).toBe(503);
    expect(testConnection).not.toHaveBeenCalled();
  });
});
