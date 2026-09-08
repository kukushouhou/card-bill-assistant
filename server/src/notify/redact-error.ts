import type { NotificationSendResult } from './types';

/** 通知服务可能在错误中回显令牌。保留诊断文字，删除配置值及 URL 中的凭据。 */
export function redactNotificationError(result: NotificationSendResult, config: unknown): NotificationSendResult {
  if (result.ok) return result;
  const hidden = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      if (value.length >= 3) hidden.add(value);
      const bearer = /^Bearer\s+(.+)$/i.exec(value);
      if (bearer) hidden.add(bearer[1]);
      try {
        const url = new URL(value);
        for (const entry of [url.username, url.password, ...url.searchParams.values(), url.pathname.split('/').at(-1) ?? '']) {
          if (entry.length >= 3) {
            hidden.add(entry);
            try { hidden.add(decodeURIComponent(entry)); } catch { /* 非法百分号仍按原值脱敏。 */ }
          }
        }
      } catch { /* 普通文本不是 URL。 */ }
    } else if (value && typeof value === 'object') {
      for (const entry of Object.values(value)) visit(entry, depth + 1);
    }
  };
  visit(config, 0);
  let message = result.error || '通知服务拒绝了请求';
  for (const value of [...hidden].sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(value, '[已隐藏]');
    try { message = message.replaceAll(encodeURIComponent(value), '[已隐藏]'); } catch { /* 孤立代理字符按原值处理。 */ }
  }
  return { ok: false, error: message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) };
}
