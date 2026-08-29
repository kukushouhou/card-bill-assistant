import { getNotificationProvider } from './registry';
import { getLegacyCompatibleBarkUrl } from './notification.service';
import type { NotificationSendResult } from './types';

/**
 * Bark 推送（https://bark.day.app）：
 * - 地址来源：设置页配置（AppSetting）或环境变量 BARK_URL，形如 https://api.day.app/YourKey
 * - 未配置时静默跳过（不影响主流程）
 */

export type BarkResult = NotificationSendResult;

export async function sendBark(title: string, body: string, group = '还款提醒'): Promise<BarkResult> {
  const provider = getNotificationProvider('bark');
  const url = await getLegacyCompatibleBarkUrl();
  if (!provider || !url) return { ok: false, error: '未配置通知渠道' };
  return provider.sendBatch({ url }, [{ title, body }], group);
}

/** 批量推送：多条事件合并为一条消息（避免同日轰炸） */
export async function sendBarkBatch(
  messages: Array<{ title: string; body: string }>,
  group = '还款提醒',
): Promise<BarkResult> {
  const provider = getNotificationProvider('bark');
  const url = await getLegacyCompatibleBarkUrl();
  if (!provider || !url) return { ok: false, error: '未配置通知渠道' };
  return provider.sendBatch({ url }, messages, group);
}
