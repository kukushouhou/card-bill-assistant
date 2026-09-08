import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config';
import type { NotificationChannel, Prisma } from '../generated/prisma/client';
import { ApiError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { getNotificationProvider, listNotificationProviderDefinitions } from './registry';
import { sealNotificationConfig, unsealNotificationConfig } from './notification-config';
import { redactNotificationError } from './redact-error';
import type { NotificationMessage, NotificationProviderDefinition, NotificationSendResult, ResolvedNotificationChannel } from './types';

export const notificationCreateSchema = z.object({
  type: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1, '请输入渠道名称').max(100, '渠道名称不能超过 100 个字符').optional(),
  enabled: z.boolean().optional(),
  config: z.unknown(),
});
export const notificationUpdateSchema = notificationCreateSchema.omit({ type: true }).partial().strict();

export interface NotificationChannelView extends Omit<ResolvedNotificationChannel, 'deliveryKey'> { configured: true }
export interface NotificationSettingsView {
  providers: NotificationProviderDefinition[];
  channels: NotificationChannelView[];
}

function requireProvider(type: string) {
  const provider = getNotificationProvider(type);
  if (!provider) throw new ApiError(400, '不支持该通知渠道');
  return provider;
}

/** 设置页与安装向导共用，新增实例必须一次性取得不可变的发送标识。 */
export function prepareNotificationChannel(input: z.infer<typeof notificationCreateSchema>): Prisma.NotificationChannelCreateInput {
  const values = notificationCreateSchema.parse(input);
  const provider = requireProvider(values.type);
  return {
    type: values.type,
    name: values.name ?? provider.definition.name,
    enabled: values.enabled ?? true,
    deliveryKey: 'instance:' + randomUUID(),
    config: sealNotificationConfig(provider.parseConfig(values.config)) as Prisma.InputJsonObject,
  };
}

function resolveChannel(row: NotificationChannel): ResolvedNotificationChannel {
  const identity = { id: row.id, type: row.type, name: row.name, enabled: row.enabled, deliveryKey: row.deliveryKey };
  try {
    return { ...identity, config: unsealNotificationConfig(row.config) };
  } catch {
    // 单份损坏配置不能阻断其他渠道，错误不携带密文或地址。
    return { ...identity, config: {}, configError: '渠道配置无法读取，请重新填写并保存' };
  }
}

function channelView(row: NotificationChannel): NotificationChannelView {
  const { deliveryKey: _key, ...view } = resolveChannel(row);
  return { ...view, configured: true };
}

async function requireChannel(id: number): Promise<NotificationChannel> {
  const row = await prisma.notificationChannel.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, '通知渠道不存在或已删除');
  return row;
}

export async function resolveNotificationChannels(options: { includeDisabled?: boolean } = {}): Promise<ResolvedNotificationChannel[]> {
  const rows = await prisma.notificationChannel.findMany({ orderBy: { id: 'asc' } });
  return rows.filter(row => options.includeDisabled || row.enabled).map(resolveChannel);
}

export async function getNotificationSettings(): Promise<NotificationSettingsView> {
  const rows = await prisma.notificationChannel.findMany({ orderBy: { id: 'asc' } });
  return { providers: listNotificationProviderDefinitions(), channels: rows.map(channelView) };
}

export async function createNotificationChannel(input: z.infer<typeof notificationCreateSchema>): Promise<NotificationChannelView> {
  return channelView(await prisma.notificationChannel.create({ data: prepareNotificationChannel(input) }));
}

export async function updateNotificationChannel(id: number, input: z.infer<typeof notificationUpdateSchema>): Promise<NotificationChannelView> {
  const values = notificationUpdateSchema.parse(input);
  const existing = await requireChannel(id);
  const data: Prisma.NotificationChannelUpdateInput = {};
  if (values.name !== undefined) data.name = values.name;
  if (values.enabled !== undefined) data.enabled = values.enabled;
  if (values.config !== undefined) data.config = sealNotificationConfig(requireProvider(existing.type).parseConfig(values.config)) as Prisma.InputJsonObject;
  // 不更新类型、发送标识；启停和改名也不重存配置密文。
  return channelView(await prisma.notificationChannel.update({ where: { id }, data }));
}

export async function removeNotificationChannel(id: number): Promise<void> {
  await requireChannel(id);
  await prisma.notificationChannel.delete({ where: { id } });
}

export async function testNotificationConfig(type: string, rawConfig: unknown, name?: string): Promise<NotificationSendResult> {
  const provider = requireProvider(type);
  const parsed = provider.parseConfig(rawConfig);
  return redactNotificationError(await provider.sendBatch(parsed, [{ title: '测试通知 · ' + (name?.trim() || provider.definition.name), body: config.appName + '的测试通知' }]), parsed);
}

export async function testNotificationChannel(id: number): Promise<NotificationSendResult> {
  const channel = resolveChannel(await requireChannel(id));
  if (channel.configError) return { ok: false, error: channel.configError };
  return testNotificationConfig(channel.type, channel.config, channel.name);
}

export async function sendNotificationChannelBatch(channel: ResolvedNotificationChannel, messages: NotificationMessage[]): Promise<NotificationSendResult> {
  if (channel.configError) return { ok: false, error: channel.configError };
  const provider = getNotificationProvider(channel.type);
  if (!provider) return { ok: false, error: '通知渠道不可用或未安装' };
  try {
    const parsed = provider.parseConfig(channel.config);
    return redactNotificationError(await provider.sendBatch(parsed, messages), parsed);
  } catch {
    return { ok: false, error: '通知渠道配置无效，请检查该渠道设置' };
  }
}
