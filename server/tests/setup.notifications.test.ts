import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
  admin: { count: vi.fn(), create: vi.fn() },
  notificationChannel: { upsert: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock('../src/lib/prisma', () => ({ prisma }));

import setupRouter from '../src/routes/setup.routes';
import { ApiError } from '../src/lib/errors';

async function withServer(run: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/setup', setupRouter);
  app.use((error: Error & { status?: number; issues?: Array<{ message: string }> }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (Array.isArray(error.issues)) {
      res.status(400).json({ error: error.issues.map((issue) => issue.message).join('; ') });
      return;
    }
    res.status(500).json({ error: error.message });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('安装向导通知渠道', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.appSetting.findUnique.mockResolvedValue(null);
    prisma.admin.count.mockResolvedValue(0);
    prisma.admin.create.mockResolvedValue({});
    prisma.appSetting.create.mockResolvedValue({});
    prisma.notificationChannel.upsert.mockResolvedValue({});
    prisma.appSetting.upsert.mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma));
  });

  it('安装时可以选择并绑定已注册通知渠道', async () => {
    await withServer(async (url) => {
      const response = await fetch(`${url}/api/setup/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: 'password123',
          notification: { type: 'bark', config: { url: 'https://api.day.app/setup-key' } },
        }),
      });
      expect(response.status).toBe(200);
    });

    expect(prisma.notificationChannel.upsert).toHaveBeenCalledWith({
      where: { type: 'bark' },
      create: {
        type: 'bark',
        name: 'Bark',
        config: { url: 'https://api.day.app/setup-key' },
        enabled: true,
      },
      update: {
        name: 'Bark',
        config: { url: 'https://api.day.app/setup-key' },
        enabled: true,
      },
    });
    expect(prisma.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'notificationChannelsInitialized' },
      create: { key: 'notificationChannelsInitialized', value: 'true' },
      update: { value: 'true' },
    });
  });

  it('选择暂不配置时只记录选择，不创建渠道', async () => {
    await withServer(async (url) => {
      const response = await fetch(`${url}/api/setup/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'password123', notification: { type: 'none' } }),
      });
      expect(response.status).toBe(200);
    });

    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
    expect(prisma.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'notificationChannelsInitialized' },
      create: { key: 'notificationChannelsInitialized', value: 'true' },
      update: { value: 'true' },
    });
  });
});
