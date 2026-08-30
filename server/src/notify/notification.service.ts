import { config } from '../config';
import type { Prisma } from '../generated/prisma/client';
import { ApiError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { getNotificationProvider, listNotificationProviderDefinitions } from './registry';
import {
  isSealedNotificationConfig,
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

export const NOTIFICATION_CHANNELS_INITIALIZED_KEY = 'notificationChannelsInitialized';
export const LEGACY_BARK_URL_KEY = 'barkUrl';

export interface NotificationChannelView extends ResolvedNotificationChannel {
  configured: true;
}

export interface NotificationSettingsView {
  providers: NotificationProviderDefinition[];
  channels: NotificationChannelView[];
}

/**
 * 解析已启用渠道。旧实例没有初始化标记时，继续兼容 AppSetting.barkUrl 和 BARK_URL。
 * 新安装明确选择“暂不配置”后会写入初始化标记，因此不会被环境变量意外重新启用。
 */
export async function resolveNotificationChannels(options: { includeDisabled?: boolean } = {}): Promise<ResolvedNotificationChannel[]> {
  const stored = await prisma.notificationChannel.findMany({ orderBy: { id: 'asc' } });
  if (stored.length > 0) {
    // 旧版记录为明文 JSON；首次读取时原地升级为环境密钥加密信封。
    await Promise.all(stored
      .filter((channel) => !isSealedNotificationConfig(channel.config))
      .map((channel) => prisma.notificationChannel.update({
        where: { id: channel.id },
        data: { config: sealNotificationConfig(unsealNotificationConfig(channel.config)) as Prisma.InputJsonObject },
      })));
    return stored
      .filter((channel) => options.includeDisabled || channel.enabled)
      .map((channel) => ({
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        source: 'database' as const,
        config: unsealNotificationConfig(channel.config),
      }));
  }

  const initialized = await prisma.appSetting.findUnique({
    where: { key: NOTIFICATION_CHANNELS_INITIALIZED_KEY },
  });
  if (initialized) return [];

  const legacy = await prisma.appSetting.findUnique({ where: { key: LEGACY_BARK_URL_KEY } });
  const legacyUrl = legacy?.value?.trim();
  if (legacyUrl) {
    // AppSetting 时代的 Bark 地址同样迁入加密渠道表，避免旧凭据继续明文保管。
    await prisma.$transaction(async (tx) => {
      await tx.notificationChannel.upsert({
        where: { type: 'bark' },
        create: {
          type: 'bark',
          name: 'Bark',
          enabled: true,
          config: sealNotificationConfig({ url: legacyUrl }) as Prisma.InputJsonObject,
        },
        update: {
          name: 'Bark',
          enabled: true,
          config: sealNotificationConfig({ url: legacyUrl }) as Prisma.InputJsonObject,
        },
      });
      await tx.appSetting.upsert({
        where: { key: NOTIFICATION_CHANNELS_INITIALIZED_KEY },
        create: { key: NOTIFICATION_CHANNELS_INITIALIZED_KEY, value: 'true' },
        update: { value: 'true' },
      });
      await tx.appSetting.deleteMany({ where: { key: LEGACY_BARK_URL_KEY } });
    });
    return [{
      type: 'bark',
      name: 'Bark',
      enabled: true,
      source: 'legacy-setting',
      config: { url: legacyUrl },
    }];
  }
  if (config.barkUrl.trim()) {
    return [{
      type: 'bark',
      name: 'Bark',
      enabled: true,
      source: 'environment',
      config: { url: config.barkUrl.trim() },
    }];
  }
  return [];
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

  await prisma.$transaction(async (tx) => {
    await tx.notificationChannel.upsert({
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
    await tx.appSetting.upsert({
      where: { key: NOTIFICATION_CHANNELS_INITIALIZED_KEY },
      create: { key: NOTIFICATION_CHANNELS_INITIALIZED_KEY, value: 'true' },
      update: { value: 'true' },
    });
    if (type === 'bark') {
      await tx.appSetting.deleteMany({ where: { key: LEGACY_BARK_URL_KEY } });
    }
  });

  return {
    type,
    name: provider.definition.name,
    enabled,
    source: 'database',
    config: parsedConfig,
    configured: true,
  };
}

export async function removeNotificationChannel(type: string): Promise<void> {
  if (!getNotificationProvider(type)) throw new ApiError(404, '不支持该通知渠道');
  await prisma.$transaction(async (tx) => {
    await tx.notificationChannel.deleteMany({ where: { type } });
    await tx.appSetting.upsert({
      where: { key: NOTIFICATION_CHANNELS_INITIALIZED_KEY },
      create: { key: NOTIFICATION_CHANNELS_INITIALIZED_KEY, value: 'true' },
      update: { value: 'true' },
    });
    if (type === 'bark') {
      await tx.appSetting.deleteMany({ where: { key: LEGACY_BARK_URL_KEY } });
    }
  });
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

/** 旧代码兼容读取；新代码请使用 resolveNotificationChannels。 */
export async function getLegacyCompatibleBarkUrl(): Promise<string> {
  const channel = (await resolveNotificationChannels({ includeDisabled: true })).find((item) => item.type === 'bark');
  return typeof channel?.config.url === 'string' ? channel.config.url : '';
}
