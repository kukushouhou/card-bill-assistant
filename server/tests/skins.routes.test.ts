import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as yazl from 'yazl';

const mocked = vi.hoisted(() => ({
  directory: process.cwd() + '/tests/.skin-service-' + process.pid,
  settings: new Map<string, string>(), failSave: false,
}));
vi.mock('../src/config', () => ({ config: { skinStorageDir: mocked.directory, builtinSkinDir: process.cwd() + '/skins' } }));
vi.mock('../src/lib/prisma', () => ({ prisma: { appSetting: {
  findUnique: async ({ where }: any) => mocked.settings.has(where.key) ? { value: mocked.settings.get(where.key) } : null,
  upsert: async ({ where, create, update }: any) => {
    if (mocked.failSave) throw new Error('保存失败');
    mocked.settings.set(where.key, mocked.settings.has(where.key) ? update.value : create.value);
  },
} } }));
vi.mock('../src/routes/middleware', () => ({ requireAuth: (req: any, res: any, next: () => void) => req.headers['x-test-auth'] === 'yes' ? next() : res.status(401).json({ error: '未登录' }) }));
import router from '../src/routes/skins.routes';
import { skins } from '../src/modules/skins/service';
import type { SkinDescriptor } from '../src/modules/skins/manifest';

let server: http.Server; let url: string;
const headers = { 'Content-Type': 'application/json', 'x-test-auth': 'yes' };
const active = async () => (await (await fetch(url + '/api/skins/active')).json()) as SkinDescriptor;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/skins', router);
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? (error.issues ? 400 : 500)).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!path.resolve(mocked.directory).startsWith(path.resolve('tests') + path.sep)) throw new Error('测试目录越界');
  await fs.rm(mocked.directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
});

async function customZip() {
  const pack = await skins.read('modern', '1.0.0'); pack.manifest.id = 'api-sample'; pack.manifest.name = '接口测试';
  pack.files.set('skin.json', Buffer.from(JSON.stringify(pack.manifest)));
  const zip = new yazl.ZipFile(); const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('error', reject); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); });
  pack.files.forEach((value, key) => zip.addBuffer(value, key)); zip.end(); return output;
}

describe('皮肤 HTTP 管理事务', () => {
  beforeEach(async () => {
    mocked.failSave = false; mocked.settings.clear();
    if (!path.resolve(mocked.directory).startsWith(path.resolve('tests') + path.sep)) throw new Error('测试目录越界');
    await fs.rm(mocked.directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    const response = await fetch(url + '/api/skins/import', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: await customZip() as any });
    expect(response.status).toBe(200);
  });
  it('只读活动皮肤可公开读取，导入需要认证且不会自动应用', async () => {
    expect((await fetch(url + '/api/skins/active')).status).toBe(200);
    const bytes = await customZip();
    expect((await fetch(url + '/api/skins/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes as any })).status).toBe(401);
    expect((await fetch(url + '/api/skins/import', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: bytes as any })).status).toBe(200);
    expect((await active()).manifest.id).toBe('modern');
  });
  it('保存失败保留原选择，成功应用后删除当前皮肤必须明确恢复默认', async () => {
    mocked.failSave = true;
    const request = { method: 'PUT', headers, body: JSON.stringify({ id: 'api-sample', version: '1.0.0' }) };
    expect((await fetch(url + '/api/skins/active', request)).status).toBe(500);
    expect((await active()).manifest.id).toBe('modern');
    mocked.failSave = false;
    expect((await fetch(url + '/api/skins/active', request)).status).toBe(200);
    expect((await fetch(url + '/api/skins/api-sample/1.0.0', { method: 'DELETE', headers })).status).toBe(409);
    expect((await active()).manifest.id).toBe('api-sample');
  });
  it('磁盘资源损坏后回退默认、管理列表仍可删除，并修正持久选择', async () => {
    expect((await fetch(url + '/api/skins/active', { method: 'PUT', headers, body: JSON.stringify({ id: 'api-sample', version: '1.0.0' }) })).status).toBe(200);
    await fs.unlink(path.join(mocked.directory, 'api-sample/1.0.0/assets/ledger.svg'));
    expect((await active()).manifest.id).toBe('modern');
    const listed = await (await fetch(url + '/api/skins', { headers })).json() as { items: SkinDescriptor[] };
    expect(listed.items.find(item => item.manifest.id === 'api-sample')?.available).toBe(false);
    const response = await fetch(url + '/api/skins/api-sample/1.0.0', { method: 'DELETE', headers, body: JSON.stringify({ restoreDefault: true }) });
    expect(response.status).toBe(200);
    expect(JSON.parse(mocked.settings.get('appearance.skin')!).id).toBe('modern');
    await expect(fs.stat(path.join(mocked.directory, 'api-sample/1.0.0'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
