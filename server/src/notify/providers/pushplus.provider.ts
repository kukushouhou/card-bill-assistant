import { z } from 'zod';
import type { NotificationChannelConfig, NotificationProvider } from '../types';
import {
  aggregateMessages,
  connectionFailure,
  fetchNotification,
  httpFailure,
  optionalTrimmedString,
  readJsonObject,
  serviceFailure,
} from '../provider-utils';

const pushPlusConfigSchema = z.object({
  token: z.string().trim().min(1, '请输入 PushPlus Token').max(500),
  channel: optionalTrimmedString(100),
  topic: optionalTrimmedString(200),
});

type PushPlusConfig = z.infer<typeof pushPlusConfigSchema>;

export const pushPlusProvider: NotificationProvider = {
  definition: {
    type: 'pushplus',
    name: 'PushPlus',
    description: '通过 PushPlus 向账户默认渠道或指定渠道发送通知。',
    fields: [
      { key: 'token', label: 'Token', type: 'password', placeholder: '用户 Token 或消息 Token', required: true },
      { key: 'channel', label: '发送渠道', type: 'text', placeholder: '留空使用账户默认渠道', required: false },
      { key: 'topic', label: '群组编码', type: 'text', placeholder: '一对一推送可留空', required: false },
    ],
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return pushPlusConfigSchema.parse(input);
  },
  async sendBatch(config, messages) {
    if (messages.length === 0) return { ok: true };
    const parsed = pushPlusConfigSchema.parse(config) as PushPlusConfig;
    const message = aggregateMessages(messages);
    try {
      const payload: Record<string, string> = {
        token: parsed.token,
        title: message.title,
        content: message.body,
        template: 'markdown',
      };
      if (parsed.channel) payload.channel = parsed.channel;
      if (parsed.topic) payload.topic = parsed.topic;
      const response = await fetchNotification('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) return httpFailure(response);
      const result = await readJsonObject(response);
      return result && Number(result.code) !== 200
        ? serviceFailure(result.msg)
        : { ok: true };
    } catch (error) {
      return connectionFailure(error);
    }
  },
};
