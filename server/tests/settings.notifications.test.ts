import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  admin: { findUnique: vi.fn(async () => ({ id: 1, username: 'admin' })) },
  appSetting: { findUnique: vi.fn(async () => null) },
  notificationChannel: {
  findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
} }));
vi.mock('../src/lib/prisma', () => ({ prisma }));
import settingsRouter from '../src/routes/settings.routes';
import { config } from '../src/config';
import { ApiError } from '../src/lib/errors';
import { barkProvider } from '../src/notify/providers/bark.provider';
import { unsealNotificationConfig } from '../src/notify/notification-config';
import type { NotificationSettingsView } from '../src/notify/notification.service';

interface Channel { id: number; type: string; name: string; config: unknown; enabled: boolean; deliveryKey: string | null }
let rows: Channel[];
beforeEach(() => {
  vi.clearAllMocks(); rows = [];
  prisma.notificationChannel.findMany.mockImplementation(async () => rows);
  prisma.notificationChannel.findUnique.mockImplementation(async ({ where }) => rows.find(row => row.id === where.id) ?? null);
  prisma.notificationChannel.create.mockImplementation(async ({ data }) => {
    const row = { id: rows.length + 1, ...data }; rows.push(row); return row;
  });
  prisma.notificationChannel.update.mockImplementation(async ({ where, data }) => {
    const row = rows.find(item => item.id === where.id)!; Object.assign(row, data); return row;
  });
  prisma.notificationChannel.delete.mockImplementation(async ({ where }) => { rows = rows.filter(row => row.id !== where.id); });
});
afterEach(() => vi.restoreAllMocks());

async function withServer(run: (call: (path: string, method?: string, body?: unknown, authed?: boolean) => Promise<Response>) => Promise<void>) {
  const app = express(); app.use(express.json(), cookieParser()); app.use('/api/settings', settingsRouter);
  app.use((error: Error & { issues?: unknown[] }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ApiError ? error.status : error.issues ? 400 : 500).json({ error: error.message });
  });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const cookie = 'drc_token=' + jwt.sign({ sub: '1', username: 'admin' }, config.jwtSecret, { expiresIn: '7d' });
  try {
    await run((path, method = 'GET', body, authed = true) => fetch(url + '/api/settings' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(authed ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe('通知实例接口与鉴权', () => {
  it('所有读取、写入和测试入口都要求登录', async () => {
    await withServer(async call => {
      for (const [path, method] of [['', 'GET'], ['/notification-channels', 'GET'], ['/notification-channels', 'POST'],
        ['/notification-channels/1', 'PUT'], ['/notification-channels/1', 'DELETE'], ['/notification-channels/test', 'POST'], ['/notification-channels/1/test', 'POST']]) {
        expect((await call(path, method, undefined, false)).status).toBe(401);
      }
    });
    expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
    expect(prisma.notificationChannel.create).not.toHaveBeenCalled();
  });

  it('两个 Bark 独立创建，编辑及停用再启用不改变发送身份或另一实例', async () => {
    await withServer(async call => {
      for (const name of ['我的手机', '备用手机']) expect((await call('/notification-channels', 'POST', { type: 'bark', name, config: { url: 'https://example.test/' + rows.length } })).status).toBe(201);
      const keys = rows.map(row => row.deliveryKey); const second = JSON.stringify(rows[1]); const cipher = JSON.stringify(rows[0].config);
      expect(keys[0]).not.toBe(keys[1]);
      for (const body of [{ name: '新名称' }, { enabled: false }, { enabled: true }]) expect((await call('/notification-channels/1', 'PUT', body)).status).toBe(200);
      expect(JSON.stringify(rows[0].config)).toBe(cipher);
      expect((await call('/notification-channels/1', 'PUT', { config: { url: 'https://example.test/updated', sound: 'bell' } })).status).toBe(200);
      expect(rows.map(row => row.deliveryKey)).toEqual(keys); expect(JSON.stringify(rows[1])).toBe(second);
      expect(unsealNotificationConfig(rows[0].config)).toMatchObject({ sound: 'bell' });
      const settings = await (await call('')).json() as { notifications: NotificationSettingsView };
      expect(settings.notifications.channels).toHaveLength(2); expect(settings.notifications.channels[0]).not.toHaveProperty('deliveryKey');
      expect((await call('/notification-channels/1', 'DELETE')).status).toBe(200);
      expect(rows.map(row => row.id)).toEqual([2]);
    });
  });

  it('非法编号和身份变更不能写入，不存在的实例返回 404', async () => {
    await withServer(async call => {
      for (const id of ['bark', '0', '-1', '1.5']) expect((await call('/notification-channels/' + id, 'PUT', { enabled: false })).status).toBe(400);
      for (const body of [{ type: 'ntfy' }, { deliveryKey: 'bark' }]) expect((await call('/notification-channels/1', 'PUT', body)).status).toBe(400);
      expect((await call('/notification-channels/999', 'PUT', { enabled: false })).status).toBe(404);
      expect(prisma.notificationChannel.update).not.toHaveBeenCalled();
    });
  });

  it('草稿和停用实例均可测试，发送失败返回 502，测试不保存也不启用', async () => {
    const send = vi.spyOn(barkProvider, 'sendBatch').mockResolvedValue({ ok: true });
    await withServer(async call => {
      expect((await call('/notification-channels', 'POST', { type: 'bark', enabled: false, config: { url: 'https://example.test/saved' } })).status).toBe(201);
      const before = JSON.stringify(rows);
      expect((await call('/notification-channels/test', 'POST', { type: 'bark', name: '草稿', config: { url: 'https://example.test/draft', sound: 'minuet' } })).status).toBe(200);
      expect(send.mock.calls[0][0]).toMatchObject({ url: 'https://example.test/draft', sound: 'minuet' });
      expect((await call('/notification-channels/1/test', 'POST')).status).toBe(200);
      send.mockResolvedValue({ ok: false, error: '通知服务暂不可用' });
      expect((await call('/notification-channels/1/test', 'POST')).status).toBe(502);
      expect(JSON.stringify(rows)).toBe(before);
      expect(prisma.notificationChannel.update).not.toHaveBeenCalled();
    });
  });
});
