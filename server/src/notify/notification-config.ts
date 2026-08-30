import { config as appConfig } from '../config';
import { decrypt, encrypt } from '../lib/crypto';
import type { NotificationChannelConfig } from './types';

const SEALED_CONFIG_MARKER = 'notification-config-v1';

interface SealedNotificationConfig extends Record<string, string> {
  _sealed: typeof SEALED_CONFIG_MARKER;
  payload: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSealedNotificationConfig(value: unknown): value is SealedNotificationConfig {
  return isRecord(value)
    && value._sealed === SEALED_CONFIG_MARKER
    && typeof value.payload === 'string';
}

export function sealNotificationConfig(value: NotificationChannelConfig): SealedNotificationConfig {
  const encrypted = encrypt(appConfig.encryptionKey, JSON.stringify(value));
  return { _sealed: SEALED_CONFIG_MARKER, payload: Buffer.from(encrypted).toString('base64') };
}

export function unsealNotificationConfig(value: unknown): NotificationChannelConfig {
  if (!isSealedNotificationConfig(value)) return isRecord(value) ? value : {};
  try {
    const json = decrypt(appConfig.encryptionKey, Buffer.from(value.payload, 'base64'));
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) throw new Error('配置内容不是对象');
    return parsed;
  } catch {
    throw new Error('通知渠道配置无法解密，请确认 ENCRYPTION_KEY 未发生变化');
  }
}
