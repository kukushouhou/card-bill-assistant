import { barkProvider } from './providers/bark.provider';
import type { NotificationProvider, NotificationProviderDefinition } from './types';

const providers = new Map<string, NotificationProvider>();

/** 注册通知提供方。应用启动时内置提供方在本模块末尾注册。 */
export function registerNotificationProvider(provider: NotificationProvider): void {
  if (providers.has(provider.definition.type)) {
    throw new Error(`通知提供方 ${provider.definition.type} 已注册`);
  }
  providers.set(provider.definition.type, provider);
}

export function getNotificationProvider(type: string): NotificationProvider | null {
  return providers.get(type) ?? null;
}

export function listNotificationProviderDefinitions(): NotificationProviderDefinition[] {
  return [...providers.values()].map((provider) => provider.definition);
}

registerNotificationProvider(barkProvider);
