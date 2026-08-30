import { config } from '../config';
import type { Prisma } from '../generated/prisma/client';
import { ApiError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { getNotificationProvider, listNotificationProviderDefinitions } from './registry';
import {
  sealNotificationConfig,
  unsealNotificationConfig,
} from './notification-config';
import type {
  NotificationChannelConfig,
  NotificationMessage,
  NotificationProviderDefinition,
  NotificationSendResult,
  ResolvedNotificationChannel,
} from './types';

export interface NotificationChannelView extends ResolvedNotificationChannel {
  configured: true;
}

export interface NotificationSettingsView {
  providers: NotificationProviderDefinition[];
  channels: NotificationChannelView[];
}

export async function resolveNotificationChannels(options: { includeDisabled?: boolean } = {}): Promise<ResolvedNotificationChannel[]> {
  const stored = await prisma.notificationChannel.findMany({ orderBy: { id: 'asc' } });
  return stored
    .filter((channel) => options.includeDisabled || channel.enabled)
    .map((channel) => ({
      type: channel.type,
      name: channel.name,
      enabled: channel.enabled,
      config: unsealNotificationConfig(channel.config),
    }));
}

export async function getNotificationSettings(): Promise<NotificationSettingsView> {
  const channels = await resolveNotificationChannels({ includeDisabled: true });
  return {
    providers: listNotificationProviderDefinitions(),
    channels: channels.map((channel) => ({ ...channel, configured: true })),
  };
}

export async function saveNotificationChannel(
  type: string,
  input: { enabled?: boolean; config: unknown },
): Promise<NotificationChannelView> {
  const provider = getNotificationProvider(type);
  if (!provider) throw new ApiError(404, '不支持该通知渠道');
  const parsedConfig = provider.parseConfig(input.config);
  const enabled = input.enabled ?? true;

  await prisma.notificationChannel.upsert({
    where: { type },
    create: {
      type,
      name: provider.definition.name,
      enabled,
      config: sealNotificationConfig(parsedConfig) as Prisma.InputJsonObject,
    },
    update: {
      name: provider.definition.name,
      enabled,
      config: sealNotificationConfig(parsedConfig) as Prisma.InputJsonObject,
    },
  });

  return {
    type,
    name: provider.definition.name,
    enabled,
    config: parsedConfig,
    configured: true,
  };
}

export async function removeNotificationChannel(type: string): Promise<void> {
  if (!getNotificationProvider(type)) throw new ApiError(404, '不支持该通知渠道');
  await prisma.notificationChannel.deleteMany({ where: { type } });
}

export async function testNotificationChannel(type: string, rawConfig?: unknown): Promise<NotificationSendResult> {
  const provider = getNotificationProvider(type);
  if (!provider) throw new ApiError(404, '不支持该通知渠道');
  let channelConfig: NotificationChannelConfig;
  if (rawConfig !== undefined) {
    channelConfig = provider.parseConfig(rawConfig);
  } else {
    const channel = (await resolveNotificationChannels({ includeDisabled: true })).find((item) => item.type === type);
    if (!channel) throw new ApiError(400, '请先配置通知渠道');
    channelConfig = provider.parseConfig(channel.config);
  }
  return provider.sendBatch(channelConfig, [{ title: config.appName, body: '通知渠道配置成功' }], '测试');
}

export async function sendNotificationChannelBatch(
  channel: ResolvedNotificationChannel,
  messages: NotificationMessage[],
): Promise<NotificationSendResult> {
  const provider = getNotificationProvider(channel.type);
  if (!provider) return { ok: false, error: '通知渠道不可用或未安装' };
  try {
    const parsedConfig = provider.parseConfig(channel.config);
    return await provider.sendBatch(parsedConfig, messages);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '通知渠道配置无效',
    };
  }
}
