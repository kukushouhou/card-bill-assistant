import { z } from 'zod';
import { fetchNotification, httpFailure, httpUrlSchema, optionalTrimmedString, readJsonObject } from '../provider-utils';
import type {
  NotificationChannelConfig,
  NotificationProvider,
  NotificationSendResult,
} from '../types';

const barkConfigSchema = z.object({
  url: httpUrlSchema('推送地址格式错误，应形如 https://api.day.app/YourKey', 500),
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

// Bark 官方 Sounds 目录的内置名称；离线部署也能选择，不在设置页面临时请求外网。
// https://github.com/Finb/Bark/tree/master/Sounds
export const BARK_SOUNDS = [
  ['alarm', '闹钟'], ['anticipate', '期待'], ['bell', '铃铛'], ['birdsong', '鸟鸣'],
  ['bloom', '绽放'], ['calypso', '卡利普索'], ['chime', '钟声'], ['choo', '汽笛'],
  ['descent', '下降'], ['electronic', '电子音'], ['fanfare', '号角齐鸣'], ['glass', '玻璃'],
  ['gotosleep', '入睡'], ['healthnotification', '健康提醒'], ['horn', '喇叭'], ['ladder', '阶梯'],
  ['mailsent', '邮件发出'], ['minuet', '小步舞曲'], ['multiwayinvitation', '多人邀请'], ['newmail', '新邮件'],
  ['newsflash', '快讯'], ['noir', '黑色电影'], ['paymentsuccess', '支付成功'], ['shake', '摇动'],
  ['sherwoodforest', '舍伍德森林'], ['silence', '无声'], ['spell', '咒语'], ['suspense', '悬念'],
  ['telegraph', '电报'], ['tiptoes', '轻步'], ['typewriters', '打字机'], ['update', '更新'],
].map(([value, label]) => ({ value, label: label + ' · ' + value }));

async function sendBark(
  config: BarkConfig,
  title: string,
  body: string,
  group: string,
): Promise<NotificationSendResult> {
  try {
    const response = await fetchNotification(config.url.replace(/\/+$/, ''), {
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
    if (!response.ok) return httpFailure(response);
    const result = await readJsonObject(response);
    if (result?.code !== 200) return { ok: false, error: 'Bark 未接受通知，请检查推送地址' };
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: '无法连接通知服务，请检查推送地址或稍后重试',
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
        placeholder: '还款提醒',
        required: false,
        advanced: true,
      },
      {
        key: 'sound',
        label: '通知铃声',
        type: 'bark-sound',
        placeholder: '默认铃声',
        options: BARK_SOUNDS,
        required: false,
        advanced: true,
      },
      {
        key: 'level',
        label: '通知级别',
        type: 'select',
        placeholder: '普通通知',
        required: false,
        advanced: true,
        options: [
          { value: 'active', label: '普通通知' },
          { value: 'timeSensitive', label: '时效性通知' },
          { value: 'passive', label: '仅通知列表' },
          { value: 'critical', label: '重要警报' },
        ],
      },
      {
        key: 'icon',
        label: '通知图标',
        type: 'url',
        placeholder: DEFAULT_BARK_ICON,
        description: '填写可公开访问的图片地址，留空使用默认图标。',
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
