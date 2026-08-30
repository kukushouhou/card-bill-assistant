import { z } from 'zod';
import type { NotificationChannelConfig, NotificationProvider } from '../types';
import {
  aggregateMessages,
  connectionFailure,
  fetchNotification,
  httpFailure,
  httpUrlSchema,
  joinTitleAndBody,
  readJsonObject,
  serviceFailure,
} from '../provider-utils';

const weComConfigSchema = z.object({
  webhookUrl: httpUrlSchema('企业微信机器人 Webhook 地址格式错误'),
});

type WeComConfig = z.infer<typeof weComConfigSchema>;

export const weComProvider: NotificationProvider = {
  definition: {
    type: 'wecom',
    name: '企业微信机器人',
    description: '向企业微信群机器人所在群聊发送通知。',
    fields: [
      { key: 'webhookUrl', label: 'Webhook 地址', type: 'url', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...', required: true },
    ],
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return weComConfigSchema.parse(input);
  },
  async sendBatch(config, messages) {
    if (messages.length === 0) return { ok: true };
    const parsed = weComConfigSchema.parse(config) as WeComConfig;
    const message = aggregateMessages(messages);
    try {
      const response = await fetchNotification(parsed.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ msgtype: 'text', text: { content: joinTitleAndBody(message.title, message.body) } }),
      });
      if (!response.ok) return httpFailure(response);
      const result = await readJsonObject(response);
      return result && Number(result.errcode) !== 0
        ? serviceFailure(result.errmsg)
        : { ok: true };
    } catch (error) {
      return connectionFailure(error);
    }
  },
};
