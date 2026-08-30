import { z } from 'zod';
import type { NotificationChannelConfig, NotificationProvider } from '../types';
import {
  aggregateMessages,
  connectionFailure,
  fetchNotification,
  httpFailure,
  httpUrlSchema,
} from '../provider-utils';

const gotifyConfigSchema = z.object({
  serverUrl: httpUrlSchema('Gotify 服务地址格式错误'),
  token: z.string().trim().min(1, '请输入 Gotify 应用令牌').max(500),
  priority: z.preprocess(
    (value) => (value === '' || value == null ? 5 : Number(value)),
    z.number().int().min(0).max(10),
  ),
});

type GotifyConfig = z.infer<typeof gotifyConfigSchema>;

export const gotifyProvider: NotificationProvider = {
  definition: {
    type: 'gotify',
    name: 'Gotify',
    description: '向自建 Gotify 服务发送 Android 与 Web 通知。',
    fields: [
      { key: 'serverUrl', label: '服务地址', type: 'url', placeholder: 'https://push.example.com', required: true },
      { key: 'token', label: '应用令牌', type: 'password', placeholder: 'Gotify 应用 Token', required: true },
      { key: 'priority', label: '优先级', type: 'text', placeholder: '5', required: false },
    ],
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return gotifyConfigSchema.parse(input);
  },
  async sendBatch(config, messages) {
    if (messages.length === 0) return { ok: true };
    const parsed = gotifyConfigSchema.parse(config) as GotifyConfig;
    const message = aggregateMessages(messages);
    try {
      const response = await fetchNotification(`${parsed.serverUrl.replace(/\/+$/, '')}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Gotify-Key': parsed.token,
        },
        body: JSON.stringify({ title: message.title, message: message.body, priority: parsed.priority }),
      });
      return response.ok ? { ok: true } : httpFailure(response);
    } catch (error) {
      return connectionFailure(error);
    }
  },
};
