import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({ notificationChannel: {
  findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
} }));
vi.mock('../src/lib/prisma', () => ({ prisma }));
import { createNotificationChannel, getNotificationSettings, notificationUpdateSchema, resolveNotificationChannels,
  sendNotificationChannelBatch, testNotificationChannel, testNotificationConfig, updateNotificationChannel, removeNotificationChannel } from '../src/notify/notification.service';
import { sealNotificationConfig, unsealNotificationConfig } from '../src/notify/notification-config';
import { barkProvider, BARK_SOUNDS } from '../src/notify/providers/bark.provider';
const row = (overrides = {}) => ({ id: 7, type: 'bark', name: '旧手机', enabled: true, deliveryKey: null,
  config: sealNotificationConfig({ url: 'https://api.day.app/test-key' }), ...overrides });
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  prisma.notificationChannel.findMany.mockResolvedValue([]);
  prisma.notificationChannel.findUnique.mockResolvedValue(row());
  prisma.notificationChannel.create.mockImplementation(async ({ data }) => ({ id: 8, ...data }));
  prisma.notificationChannel.update.mockImplementation(async ({ data }) => ({ ...row(), ...data }));
});

describe('渠道实例与旧数据兼容', () => {
  it('返回实例编号与铃声选项，不公开内部发送标识', async () => {
    prisma.notificationChannel.findMany.mockResolvedValue([row()]);
    const result = await getNotificationSettings();
    expect(result.channels[0]).toMatchObject({ id: 7, name: '旧手机', configured: true });
    expect(result.channels[0]).not.toHaveProperty('deliveryKey');
    expect(BARK_SOUNDS).toHaveLength(32);
    expect(result.providers.find(item => item.type === 'bark')?.fields.find(item => item.key === 'sound')).toMatchObject({ type: 'bark-sound', options: BARK_SOUNDS });
  });
  it('同类型每次新增独立标识且加密保存，重建不会复用已删除身份', async () => {
    for (const name of ['我的手机', '备用手机']) await createNotificationChannel({ type: 'bark', name, config: { url: 'https://api.day.app/key' } });
    const first = prisma.notificationChannel.create.mock.calls[0][0].data;
    const second = prisma.notificationChannel.create.mock.calls[1][0].data;
    expect(first.deliveryKey).toMatch(/^instance:/);
    expect(second.deliveryKey).not.toBe(first.deliveryKey);
    expect(unsealNotificationConfig(first.config)).toEqual({ url: 'https://api.day.app/key' });
    expect(JSON.stringify(first.config)).not.toContain('api.day.app');
    await removeNotificationChannel(7);
    expect(prisma.notificationChannel.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });
  it('改名与启停只更新指定字段，不写配置密文或原发送标识', async () => {
    await updateNotificationChannel(7, { name: '我的手机', enabled: false });
    expect(prisma.notificationChannel.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { name: '我的手机', enabled: false } });
    expect(() => notificationUpdateSchema.parse({ deliveryKey: 'other' })).toThrow();
    expect(() => notificationUpdateSchema.parse({ type: 'ntfy' })).toThrow();
  });
  it('编辑高级配置保持旧实例身份，新实例不受影响', async () => {
    await updateNotificationChannel(7, { config: { url: 'https://api.day.app/key', sound: 'minuet', group: '家庭' } });
    const data = prisma.notificationChannel.update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(['config']);
    expect(unsealNotificationConfig(data.config)).toMatchObject({ sound: 'minuet', group: '家庭' });
    prisma.notificationChannel.findUnique.mockResolvedValue(null);
    await expect(updateNotificationChannel(99, { name: '消失的渠道' })).rejects.toThrow('不存在');
  });
  it('单份损坏密文不会使其他渠道无法发送', async () => {
    prisma.notificationChannel.findMany.mockResolvedValue([row({ config: {} }), row({ id: 8, deliveryKey: 'instance:8' })]);
    const channels = await resolveNotificationChannels();
    expect(channels[0].configError).toBeTruthy();
    expect(channels[1].configError).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"code":200}')));
    expect((await sendNotificationChannelBatch(channels[0], [{ title: '测试', body: '内容' }])).ok).toBe(false);
    expect((await sendNotificationChannelBatch(channels[1], [{ title: '测试', body: '内容' }])).ok).toBe(true);
  });
});
describe('Bark 测试通知', () => {
  it('未保存配置直接测试全部参数且不写数据库', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"code":200}'));
    vi.stubGlobal('fetch', fetchMock);
    const values = { url: 'https://api.day.app/draft', group: '家庭', sound: 'minuet', level: 'timeSensitive', icon: 'https://example.test/icon.png' };
    expect(await testNotificationConfig('bark', values, '我的手机')).toEqual({ ok: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ group: '家庭', sound: 'minuet', level: 'timeSensitive', icon: values.icon, title: '测试通知 · 我的手机' });
    expect(prisma.notificationChannel.create).not.toHaveBeenCalled();
    expect(prisma.notificationChannel.update).not.toHaveBeenCalled();
  });
  it('停用的已保存实例可测试且不自动启用', async () => {
    prisma.notificationChannel.findUnique.mockResolvedValue(row({ enabled: false }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"code":200}')));
    expect(await testNotificationChannel(7)).toEqual({ ok: true });
    expect(prisma.notificationChannel.update).not.toHaveBeenCalled();
  });
  it('默认分组与正式发送一致，HTTP 200 的业务失败不误报成功', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{"code":200}'));
    vi.stubGlobal('fetch', fetchMock);
    await testNotificationConfig('bark', { url: 'https://api.day.app/test' });
    await barkProvider.sendBatch({ url: 'https://api.day.app/test' }, [{ title: '提醒', body: '内容' }]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).group).toBe(JSON.parse(fetchMock.mock.calls[1][1].body).group);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).group).toBe('还款提醒');
    fetchMock.mockResolvedValue(new Response('{"code":400}'));
    expect((await testNotificationChannel(7)).ok).toBe(false);
  });
});
