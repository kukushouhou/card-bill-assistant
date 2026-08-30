import { z } from 'zod';
import { config as appConfig } from '../../config';
import type { NotificationChannelConfig, NotificationProvider } from '../types';
import {
  aggregateMessages,
  connectionFailure,
  fetchNotification,
  httpFailure,
} from '../provider-utils';

const ALLOWED_PLACEHOLDERS = new Set(['title', 'body', 'group', 'count', 'appName']);
const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g;

function hasOnlyAllowedPlaceholders(value: string): boolean {
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    if (!ALLOWED_PLACEHOLDERS.has(match[1])) return false;
  }
  return true;
}

const templateString = (max: number) => z
  .string()
  .max(max)
  .refine(hasOnlyAllowedPlaceholders, '仅支持 title、body、group、count、appName 占位符');

const pairSchema = z.object({
  key: z.string().trim().min(1, '参数名不能为空').max(200),
  value: templateString(10_000),
});

const pairsSchema = z.array(pairSchema).max(50, '同一区域最多配置 50 个参数').default([]);

const customHttpConfigSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).default('POST'),
  url: templateString(2_000).refine((value) => {
    try {
      const rendered = value.replace(PLACEHOLDER_PATTERN, 'preview');
      return ['http:', 'https:'].includes(new URL(rendered).protocol);
    } catch {
      return false;
    }
  }, '自定义推送 URL 格式错误'),
  parameters: pairsSchema,
  queryParams: pairsSchema,
  headers: pairsSchema,
  bodyType: z.enum(['json', 'form', 'text', 'none']).default('json'),
  bodyTemplate: templateString(50_000).optional().default(''),
}).superRefine((value, ctx) => {
  if (value.bodyType === 'json' && value.bodyTemplate.trim()) {
    try {
      JSON.parse(value.bodyTemplate);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['bodyTemplate'], message: 'JSON 正文模板格式错误' });
    }
  }
});

type CustomHttpConfig = z.infer<typeof customHttpConfigSchema>;
type TemplateVars = Record<'title' | 'body' | 'group' | 'count' | 'appName', string>;

export function renderNotificationTemplate(value: string, vars: TemplateVars): string {
  return value.replace(PLACEHOLDER_PATTERN, (_match, key: keyof TemplateVars) => vars[key] ?? '');
}

function renderJsonValue(value: unknown, vars: TemplateVars): unknown {
  if (typeof value === 'string') return renderNotificationTemplate(value, vars);
  if (Array.isArray(value)) return value.map((item) => renderJsonValue(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderJsonValue(item, vars)]));
  }
  return value;
}

function applyPairs(target: URLSearchParams, pairs: Array<{ key: string; value: string }>, vars: TemplateVars): void {
  for (const pair of pairs) target.append(pair.key, renderNotificationTemplate(pair.value, vars));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function buildBody(
  config: CustomHttpConfig,
  vars: TemplateVars,
  headers: Record<string, string>,
): string | undefined {
  if (config.method === 'GET' || config.bodyType === 'none') return undefined;
  if (config.bodyTemplate.trim()) {
    if (config.bodyType === 'json') {
      const parsed = JSON.parse(config.bodyTemplate);
      if (!hasHeader(headers, 'Content-Type')) headers['Content-Type'] = 'application/json; charset=utf-8';
      return JSON.stringify(renderJsonValue(parsed, vars));
    }
    if (!hasHeader(headers, 'Content-Type')) {
      headers['Content-Type'] = config.bodyType === 'form'
        ? 'application/x-www-form-urlencoded; charset=utf-8'
        : 'text/plain; charset=utf-8';
    }
    return renderNotificationTemplate(config.bodyTemplate, vars);
  }

  if (config.bodyType === 'form') {
    const form = new URLSearchParams();
    applyPairs(form, config.parameters, vars);
    if (!hasHeader(headers, 'Content-Type')) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    return form.toString();
  }
  if (config.bodyType === 'text') {
    if (!hasHeader(headers, 'Content-Type')) headers['Content-Type'] = 'text/plain; charset=utf-8';
    return config.parameters.map((pair) => renderNotificationTemplate(pair.value, vars)).join('\n');
  }
  if (!hasHeader(headers, 'Content-Type')) headers['Content-Type'] = 'application/json; charset=utf-8';
  return JSON.stringify(Object.fromEntries(
    config.parameters.map((pair) => [pair.key, renderNotificationTemplate(pair.value, vars)]),
  ));
}

export const customHttpProvider: NotificationProvider = {
  definition: {
    type: 'custom-http',
    name: '自定义 HTTP 推送',
    description: '向自定义 URL 发送结构化 HTTP 请求，默认填写方法、URL 和参数，高级设置可配置查询、请求头与正文模板。',
    fields: [],
    configMode: 'custom-http',
  },
  parseConfig(input: unknown): NotificationChannelConfig {
    return customHttpConfigSchema.parse(input);
  },
  async sendBatch(config, messages, group = '还款提醒') {
    if (messages.length === 0) return { ok: true };
    const parsed = customHttpConfigSchema.parse(config) as CustomHttpConfig;
    const message = aggregateMessages(messages);
    const vars: TemplateVars = {
      title: message.title,
      body: message.body,
      group,
      count: String(message.count),
      appName: appConfig.appName,
    };
    try {
      const url = new URL(renderNotificationTemplate(parsed.url, vars));
      applyPairs(url.searchParams, parsed.queryParams, vars);
      if (parsed.method === 'GET') applyPairs(url.searchParams, parsed.parameters, vars);

      const headers = Object.fromEntries(
        parsed.headers.map((pair) => [pair.key, renderNotificationTemplate(pair.value, vars)]),
      );
      const body = buildBody(parsed, vars, headers);
      const response = await fetchNotification(url, { method: parsed.method, headers, body });
      return response.ok ? { ok: true } : httpFailure(response);
    } catch (error) {
      return connectionFailure(error);
    }
  },
};
