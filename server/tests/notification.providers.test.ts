import { afterEach, describe, expect, it, vi } from 'vitest';
import { listNotificationProviderDefinitions } from '../src/notify/registry';
import { customHttpProvider } from '../src/notify/providers/custom-http.provider';
import { dingTalkProvider } from '../src/notify/providers/dingtalk.provider';
import { feishuProvider } from '../src/notify/providers/feishu.provider';
import { gotifyProvider } from '../src/notify/providers/gotify.provider';
import { ntfyProvider } from '../src/notify/providers/ntfy.provider';
import { pushPlusProvider } from '../src/notify/providers/pushplus.provider';
import { serverChanProvider } from '../src/notify/providers/serverchan.provider';
import { telegramProvider } from '../src/notify/providers/telegram.provider';
import { weComProvider } from '../src/notify/providers/wecom.provider';

const messages = [
  { title: '还款提醒', body: '招商银行（1234）今天还款' },
  { title: '年费提醒', body: '建设银行（5678）年费日临近' },
];

function response(body: Record<string, unknown> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('通知提供方注册表', () => {
  it('注册完整常见渠道与自定义 HTTP 推送', () => {
    expect(listNotificationProviderDefinitions().map((item) => item.type)).toEqual([
      'bark',
      'ntfy',
      'gotify',
      'telegram',
      'serverchan',
      'pushplus',
      'wecom',
      'dingtalk',
      'feishu',
      'custom-http',
    ]);
  });
});

describe('个人通知渠道协议', () => {
  it('ntfy 使用主题、令牌和聚合消息发布 JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    const config = ntfyProvider.parseConfig({ serverUrl: 'https://ntfy.example.com/', topic: 'credit', token: 'secret' });

    await expect(ntfyProvider.sendBatch(config, messages)).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ntfy.example.com');
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer secret' }));
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ topic: 'credit', title: '今日提醒（2 条）' }));
  });

  it('Gotify 使用应用令牌请求消息接口', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    const config = gotifyProvider.parseConfig({ serverUrl: 'https://gotify.example.com', token: 'app-token', priority: '8' });

    await expect(gotifyProvider.sendBatch(config, messages)).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gotify.example.com/message');
    expect(init.headers).toEqual(expect.objectContaining({ 'X-Gotify-Key': 'app-token' }));
    expect(JSON.parse(String(init.body)).priority).toBe(8);
  });

  it('Telegram Bot 校验业务响应并发送到指定 Chat ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const config = telegramProvider.parseConfig({ botToken: '123:abc', chatId: '-10001' });

    await expect(telegramProvider.sendBatch(config, messages)).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ chat_id: '-10001' }));
  });

  it('Server酱按 SendKey 前缀选择 Server酱³ 地址', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ code: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = serverChanProvider.parseConfig({ sendKey: 'sctp123tABC' });

    await expect(serverChanProvider.sendBatch(config, messages)).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe('https://123.push.ft07.com/send/sctp123tABC.send');
  });

  it('PushPlus 按业务返回码识别失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ code: 500, msg: 'Token 无效' })));
    const config = pushPlusProvider.parseConfig({ token: 'push-token' });

    await expect(pushPlusProvider.sendBatch(config, messages)).resolves.toEqual({ ok: false, error: 'Token 无效' });
  });
});

describe('企业机器人渠道协议', () => {
  it('企业微信发送文本并校验 errcode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ errcode: 0, errmsg: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const config = weComProvider.parseConfig({ webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc' });

    await expect(weComProvider.sendBatch(config, messages)).resolves.toEqual({ ok: true });
    const payload = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(payload.msgtype).toBe('text');
    expect(payload.text.content).toContain('今日提醒（2 条）');
  });

  it('钉钉开启加签时附加 timestamp 与 sign', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ errcode: 0, errmsg: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const config = dingTalkProvider.parseConfig({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
      secret: 'SEC123',
    });

    await expect(dingTalkProvider.sendBatch(config, messages)).resolves.toEqual({ ok: true });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('access_token')).toBe('abc');
    expect(url.searchParams.get('timestamp')).toMatch(/^\d+$/);
    expect(url.searchParams.get('sign')).toBeTruthy();
  });

  it('飞书开启签名校验时把 timestamp 与 sign 放入正文', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ code: 0, msg: 'success' }));
    vi.stubGlobal('fetch', fetchMock);
    const config = feishuProvider.parseConfig({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', secret: 'secret' });

    await expect(feishuProvider.sendBatch(config, messages)).resolves.toEqual({ ok: true });
    const payload = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(payload.timestamp).toMatch(/^\d+$/);
    expect(payload.sign).toBeTruthy();
  });
});

describe('自定义 HTTP 推送', () => {
  it('默认模式把 GET 基础参数加入查询串', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    const config = customHttpProvider.parseConfig({
      method: 'GET',
      url: 'https://example.com/hook',
      parameters: [
        { key: 'subject', value: '{{title}}' },
        { key: 'content', value: '{{body}}' },
      ],
    });

    await expect(customHttpProvider.sendBatch(config, messages)).resolves.toEqual({ ok: true });
    const [rawUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const url = new URL(rawUrl);
    expect(url.searchParams.get('subject')).toBe('今日提醒（2 条）');
    expect(url.searchParams.get('content')).toContain('招商银行');
    expect(init.body).toBeUndefined();
  });

  it('高级模式渲染查询、请求头和 JSON 正文模板', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    const config = customHttpProvider.parseConfig({
      method: 'POST',
      url: 'https://example.com/hook',
      parameters: [],
      queryParams: [{ key: 'count', value: '{{count}}' }],
      headers: [{ key: 'Authorization', value: 'Bearer fixed-token' }],
      bodyType: 'json',
      bodyTemplate: '{"subject":"{{title}}","content":"{{body}}","app":"{{appName}}"}',
    });

    await expect(customHttpProvider.sendBatch(config, messages, '测试')).resolves.toEqual({ ok: true });
    const [rawUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(new URL(rawUrl).searchParams.get('count')).toBe('2');
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer fixed-token' }));
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      subject: '今日提醒（2 条）',
      app: '守候信用卡小管家',
    }));
  });
});
