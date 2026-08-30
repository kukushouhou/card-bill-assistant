import { z } from 'zod';
import type { NotificationChannelConfig, NotificationProvider } from '../types';
import {
  aggregateMessages,
  connectionFailure,
  fetchNotification,
  httpFailure,
  readJsonObject,
  serviceFailure,
  truncateText,
} from '../provider-utils';

const serverChanConfigSchema = z.object({
  sendKey: z
    .string()
    .trim()
    .min(1, '请输入 Server酱 SendKey')
    .max(500)
    .refine((value) => value.startsWith('SCT') || /^sctp\d+t/.test(value), 'SendKey 应以 SCT 或 sctp 开头'),
});

type ServerChanConfig = z.infer<typeof serverChanConfigSchema>;

function resolveEndpoint(sendKey: string): string {
  const sc3 = /^sctp(\d+)t/.exec(sendKey);
  if (sc3) return `https://${sc3[1]}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send`;
  return `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
}

export const serverChanProvider: NotificationProvider = {
  definition: {
    type: 'serverchan',
    name: 'Server酱',
    description: '通过 Server酱 Turbo 或 Server酱³ 向微信、App 等目标发送通知。',
    fields: [
      { key: 'sendKey', label: 'SendKey', type: 'password', placeholder: 'SCT... 或 sctp...', required: true },
    ],
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return serverChanConfigSchema.parse(input);
  },
  async sendBatch(config, messages) {
    if (messages.length === 0) return { ok: true };
    const parsed = serverChanConfigSchema.parse(config) as ServerChanConfig;
    const message = aggregateMessages(messages);
    try {
      const response = await fetchNotification(resolveEndpoint(parsed.sendKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ title: truncateText(message.title.replace(/\r?\n/g, ' '), 32), desp: message.body }),
      });
      if (!response.ok) return httpFailure(response);
      const result = await readJsonObject(response);
      return result && Number(result.code) !== 0
        ? serviceFailure(result.message ?? result.msg)
        : { ok: true };
    } catch (error) {
      return connectionFailure(error);
    }
  },
};
