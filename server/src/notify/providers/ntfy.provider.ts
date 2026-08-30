import { z } from 'zod';
import type { NotificationChannelConfig, NotificationProvider } from '../types';
import {
  aggregateMessages,
  connectionFailure,
  fetchNotification,
  httpFailure,
  httpUrlSchema,
  optionalTrimmedString,
} from '../provider-utils';

const ntfyConfigSchema = z.object({
  serverUrl: httpUrlSchema('ntfy 服务地址格式错误').default('https://ntfy.sh'),
  topic: z.string().trim().min(1, '请输入 ntfy 主题').max(200, 'ntfy 主题不能超过 200 个字符'),
  token: optionalTrimmedString(500),
});

type NtfyConfig = z.infer<typeof ntfyConfigSchema>;

export const ntfyProvider: NotificationProvider = {
  definition: {
    type: 'ntfy',
    name: 'ntfy',
    description: '向 ntfy 官方服务或自建服务发送跨端通知。',
    fields: [
      { key: 'serverUrl', label: '服务地址', type: 'url', placeholder: 'https://ntfy.sh', required: true },
      { key: 'topic', label: '主题', type: 'text', placeholder: '请输入不易猜测的主题名', required: true },
      { key: 'token', label: '访问令牌', type: 'password', placeholder: '公开主题可留空', required: false },
    ],
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return ntfyConfigSchema.parse(input);
  },
  async sendBatch(config, messages) {
    if (messages.length === 0) return { ok: true };
    const parsed = ntfyConfigSchema.parse(config) as NtfyConfig;
    const message = aggregateMessages(messages);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
      if (parsed.token) headers.Authorization = `Bearer ${parsed.token}`;
      const response = await fetchNotification(parsed.serverUrl.replace(/\/+$/, ''), {
        method: 'POST',
        headers,
        body: JSON.stringify({ topic: parsed.topic, title: message.title, message: message.body }),
      });
      return response.ok ? { ok: true } : httpFailure(response);
    } catch (error) {
      return connectionFailure(error);
    }
  },
};
