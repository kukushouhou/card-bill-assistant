import crypto from 'node:crypto';
import { z } from 'zod';
import type { NotificationChannelConfig, NotificationProvider } from '../types';
import {
  aggregateMessages,
  connectionFailure,
  fetchNotification,
  httpFailure,
  httpUrlSchema,
  joinTitleAndBody,
  optionalTrimmedString,
  readJsonObject,
  serviceFailure,
} from '../provider-utils';

const feishuConfigSchema = z.object({
  webhookUrl: httpUrlSchema('飞书机器人 Webhook 地址格式错误'),
  secret: optionalTrimmedString(500),
});

type FeishuConfig = z.infer<typeof feishuConfigSchema>;

function sign(secret: string, timestamp: string): string {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

export const feishuProvider: NotificationProvider = {
  definition: {
    type: 'feishu',
    name: '飞书机器人',
    description: '向飞书自定义机器人所在群聊发送通知，支持签名校验。',
    fields: [
      { key: 'webhookUrl', label: 'Webhook 地址', type: 'url', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...', required: true },
      { key: 'secret', label: '签名密钥', type: 'password', placeholder: '未开启签名校验可留空', required: false },
    ],
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return feishuConfigSchema.parse(input);
  },
  async sendBatch(config, messages) {
    if (messages.length === 0) return { ok: true };
    const parsed = feishuConfigSchema.parse(config) as FeishuConfig;
    const message = aggregateMessages(messages);
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const payload: Record<string, unknown> = {
      msg_type: 'text',
      content: { text: joinTitleAndBody(message.title, message.body) },
    };
    if (parsed.secret) {
      payload.timestamp = timestamp;
      payload.sign = sign(parsed.secret, timestamp);
    }
    try {
      const response = await fetchNotification(parsed.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) return httpFailure(response);
      const result = await readJsonObject(response);
      const code = result?.code ?? result?.StatusCode;
      return result && Number(code) !== 0
        ? serviceFailure(result.msg ?? result.StatusMessage)
        : { ok: true };
    } catch (error) {
      return connectionFailure(error);
    }
  },
};
