import { z } from 'zod';
import { optionalTrimmedString } from '../provider-utils';
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
  group: optionalTrimmedString(100),
  sound: optionalTrimmedString(100),
  level: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['active', 'timeSensitive', 'passive', 'critical'], {
      error: '通知级别无效',
    }).optional(),
  ),
  icon: optionalTrimmedString(1_000).refine((value) => {
    if (!value) return true;
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, '通知图标地址格式错误'),
});

interface BarkConfig extends NotificationChannelConfig {
  url: string;
  group?: string;
  sound?: string;
  level?: 'active' | 'timeSensitive' | 'passive' | 'critical';
  icon?: string;
}

const DEFAULT_BARK_ICON = 'https://assets.bark.day.app/card.png';

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
        group: config.group || group,
        icon: config.icon || DEFAULT_BARK_ICON,
        ...(config.sound ? { sound: config.sound } : {}),
        ...(config.level ? { level: config.level } : {}),
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
      {
        key: 'group',
        label: '推送分组',
        type: 'text',
        placeholder: '留空使用“还款提醒”',
        description: 'Bark 会按此名称归类通知；测试通知也会使用这里填写的分组。',
        required: false,
        advanced: true,
      },
      {
        key: 'sound',
        label: '通知铃声',
        type: 'text',
        placeholder: '留空使用 Bark 默认铃声',
        description: '填写 Bark 内置铃声或自定义铃声的名称。',
        required: false,
        advanced: true,
      },
      {
        key: 'level',
        label: '通知级别',
        type: 'select',
        placeholder: '使用 Bark 默认设置',
        description: '重要警报需要在 Bark 与系统设置中授予相应权限。',
        required: false,
        advanced: true,
        options: [
          { value: 'active', label: '主动通知' },
          { value: 'timeSensitive', label: '时效性通知' },
          { value: 'passive', label: '静默通知' },
          { value: 'critical', label: '重要警报' },
        ],
      },
      {
        key: 'icon',
        label: '通知图标',
        type: 'url',
        placeholder: DEFAULT_BARK_ICON,
        description: '留空使用小管家默认图标；自定义图标需要填写可公开访问的图片地址。',
        required: false,
        advanced: true,
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
