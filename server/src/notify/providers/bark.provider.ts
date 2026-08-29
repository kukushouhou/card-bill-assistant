import { z } from 'zod';
import type {
  NotificationChannelConfig,
  NotificationMessage,
  NotificationProvider,
  NotificationSendResult,
} from '../types';

const barkConfigSchema = z.object({
  url: z
    .string()
    .trim()
    .url('推送地址格式错误，应形如 https://api.day.app/YourKey')
    .max(500, '推送地址不能超过 500 个字符'),
});

interface BarkConfig extends NotificationChannelConfig {
  url: string;
}

async function sendBark(
  config: BarkConfig,
  title: string,
  body: string,
  group: string,
): Promise<NotificationSendResult> {
  try {
    const response = await fetch(config.url.replace(/\/+$/, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        title,
        body,
        group,
        icon: 'https://assets.bark.day.app/card.png',
      }),
    });
    if (!response.ok) return { ok: false, error: `通知服务返回 HTTP ${response.status}` };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `无法连接通知服务：${error.message}` : '无法连接通知服务',
    };
  }
}

export const barkProvider: NotificationProvider = {
  definition: {
    type: 'bark',
    name: 'Bark',
    description: '向 iPhone 或 iPad 上的 Bark 应用发送系统通知。',
    fields: [
      {
        key: 'url',
        label: '推送地址',
        type: 'url',
        placeholder: 'https://api.day.app/YourKey',
        required: true,
      },
    ],
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return barkConfigSchema.parse(input);
  },
  async sendBatch(config, messages, group = '还款提醒') {
    if (messages.length === 0) return { ok: true };
    const parsed = barkConfigSchema.parse(config) as BarkConfig;
    if (messages.length === 1) {
      return sendBark(parsed, messages[0].title, messages[0].body, group);
    }
    const title = `今日提醒（${messages.length} 条）`;
    const body = messages.map((message, index) => `${index + 1}. ${message.title}\n${message.body}`).join('\n\n');
    return sendBark(parsed, title, body, group);
  },
};
