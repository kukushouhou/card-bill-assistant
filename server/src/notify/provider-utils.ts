import { z } from 'zod';
import type { NotificationMessage, NotificationSendResult } from './types';

const REQUEST_TIMEOUT_MS = 15_000;

export function httpUrlSchema(message: string, max = 1_000) {
  return z
    .string()
    .trim()
    .max(max, `地址不能超过 ${max} 个字符`)
    .refine((value) => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, message);
}

export function optionalTrimmedString(max = 500) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(max).optional(),
  );
}

export function aggregateMessages(messages: NotificationMessage[]): NotificationMessage & { count: number } {
  if (messages.length === 1) return { ...messages[0], count: 1 };
  return {
    title: `今日提醒（${messages.length} 条）`,
    body: messages.map((message, index) => `${index + 1}. ${message.title}\n${message.body}`).join('\n\n'),
    count: messages.length,
  };
}

export function joinTitleAndBody(title: string, body: string): string {
  return body ? `${title}\n\n${body}` : title;
}

export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export async function fetchNotification(url: string | URL, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function httpFailure(response: Response): NotificationSendResult {
  return { ok: false, error: `通知服务返回 HTTP ${response.status}` };
}

export function connectionFailure(error: unknown): NotificationSendResult {
  return {
    ok: false,
    error: error instanceof Error ? `无法连接通知服务：${error.message}` : '无法连接通知服务',
  };
}

export function serviceFailure(value: unknown, fallback = '通知服务拒绝了请求'): NotificationSendResult {
  return { ok: false, error: typeof value === 'string' && value.trim() ? value.trim() : fallback };
}
