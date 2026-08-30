import { z } from 'zod';
import type { NotificationChannelConfig, NotificationProvider } from '../types';
import {
  aggregateMessages,
  connectionFailure,
  fetchNotification,
  httpFailure,
  httpUrlSchema,
  optionalTrimmedString,
  readJsonObject,
  serviceFailure,
  truncateText,
} from '../provider-utils';

const telegramConfigSchema = z.object({
  botToken: z
    .string()
    .trim()
    .max(500)
    .regex(/^\d+:[A-Za-z0-9_-]+$/, 'Telegram Bot Token 格式错误'),
  chatId: z.string().trim().min(1, '请输入 Telegram Chat ID').max(200),
  apiBaseUrl: optionalTrimmedString(1_000).pipe(httpUrlSchema('Telegram API 地址格式错误').optional()),
});

type TelegramConfig = z.infer<typeof telegramConfigSchema>;

export const telegramProvider: NotificationProvider = {
  definition: {
    type: 'telegram',
    name: 'Telegram Bot',
    description: '通过 Telegram 机器人向私聊、群组或频道发送通知。',
    fields: [
      { key: 'botToken', label: 'Bot Token', type: 'password', placeholder: '123456:ABC-DEF...', required: true },
      { key: 'chatId', label: 'Chat ID', type: 'text', placeholder: '用户、群组或频道 ID', required: true },
      { key: 'apiBaseUrl', label: 'API 地址', type: 'url', placeholder: '留空使用 https://api.telegram.org', required: false },
    ],
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return telegramConfigSchema.parse(input);
  },
  async sendBatch(config, messages) {
    if (messages.length === 0) return { ok: true };
    const parsed = telegramConfigSchema.parse(config) as TelegramConfig;
    const message = aggregateMessages(messages);
    const apiBaseUrl = parsed.apiBaseUrl || 'https://api.telegram.org';
    try {
      const response = await fetchNotification(
        `${apiBaseUrl.replace(/\/+$/, '')}/bot${parsed.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            chat_id: parsed.chatId,
            text: truncateText(`${message.title}\n\n${message.body}`, 4_096),
            disable_web_page_preview: true,
          }),
        },
      );
      if (!response.ok) return httpFailure(response);
      const result = await readJsonObject(response);
      return result?.ok === false ? serviceFailure(result.description) : { ok: true };
    } catch (error) {
      return connectionFailure(error);
    }
  },
};
