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

const dingTalkConfigSchema = z.object({
  webhookUrl: httpUrlSchema('钉钉机器人 Webhook 地址格式错误'),
  secret: optionalTrimmedString(500),
});

type DingTalkConfig = z.infer<typeof dingTalkConfigSchema>;

function signedUrl(webhookUrl: string, secret?: string): string {
  if (!secret) return webhookUrl;
  const timestamp = Date.now().toString();
  const sign = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
  const url = new URL(webhookUrl);
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('sign', sign);
  return url.toString();
}

export const dingTalkProvider: NotificationProvider = {
  definition: {
    type: 'dingtalk',
    name: '钉钉机器人',
    description: '向钉钉自定义机器人所在群聊发送通知，支持加签安全设置。',
    fields: [
      { key: 'webhookUrl', label: 'Webhook 地址', type: 'url', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...', required: true },
      { key: 'secret', label: '加签密钥', type: 'password', placeholder: '未开启加签可留空', required: false },
    ],
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return dingTalkConfigSchema.parse(input);
  },
  async sendBatch(config, messages) {
    if (messages.length === 0) return { ok: true };
    const parsed = dingTalkConfigSchema.parse(config) as DingTalkConfig;
    const message = aggregateMessages(messages);
    try {
      const response = await fetchNotification(signedUrl(parsed.webhookUrl, parsed.secret), {
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
