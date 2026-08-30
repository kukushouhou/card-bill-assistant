import { barkProvider } from './providers/bark.provider';
import { customHttpProvider } from './providers/custom-http.provider';
import { dingTalkProvider } from './providers/dingtalk.provider';
import { feishuProvider } from './providers/feishu.provider';
import { gotifyProvider } from './providers/gotify.provider';
import { ntfyProvider } from './providers/ntfy.provider';
import { pushPlusProvider } from './providers/pushplus.provider';
import { serverChanProvider } from './providers/serverchan.provider';
import { telegramProvider } from './providers/telegram.provider';
import { weComProvider } from './providers/wecom.provider';
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
registerNotificationProvider(ntfyProvider);
registerNotificationProvider(gotifyProvider);
registerNotificationProvider(telegramProvider);
registerNotificationProvider(serverChanProvider);
registerNotificationProvider(pushPlusProvider);
registerNotificationProvider(weComProvider);
registerNotificationProvider(dingTalkProvider);
registerNotificationProvider(feishuProvider);
registerNotificationProvider(customHttpProvider);
