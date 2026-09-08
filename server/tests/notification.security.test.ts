import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/prisma', () => ({ prisma: {} }));
import { connectionFailure, discardResponse, MAX_NOTIFICATION_RESPONSE_BYTES, readJsonObject } from '../src/notify/provider-utils';
import { redactNotificationError } from '../src/notify/redact-error';
import { testNotificationConfig, sendNotificationChannelBatch } from '../src/notify/notification.service';
import { dingTalkProvider } from '../src/notify/providers/dingtalk.provider';
import { feishuProvider } from '../src/notify/providers/feishu.provider';
import { pushPlusProvider } from '../src/notify/providers/pushplus.provider';
import { serverChanProvider } from '../src/notify/providers/serverchan.provider';
import { telegramProvider } from '../src/notify/providers/telegram.provider';
import { weComProvider } from '../src/notify/providers/wecom.provider';
import { barkProvider } from '../src/notify/providers/bark.provider';
import { gotifyProvider } from '../src/notify/providers/gotify.provider';
import { ntfyProvider } from '../src/notify/providers/ntfy.provider';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('通知响应安全', () => {
  it('无效 JSON、缺少业务确认和空响应均不能误报发送成功', async () => {
    const providers = [
      [dingTalkProvider, { webhookUrl: 'https://example.test/hook' }],
      [feishuProvider, { webhookUrl: 'https://example.test/hook' }],
      [pushPlusProvider, { token: 'synthetic-token' }],
      [serverChanProvider, { sendKey: 'SCT-synthetic-token' }],
      [telegramProvider, { botToken: '123:synthetic', chatId: '456' }],
      [weComProvider, { webhookUrl: 'https://example.test/hook' }],
      [barkProvider, { url: 'https://example.test/key' }],
      [gotifyProvider, { serverUrl: 'https://example.test', token: 'synthetic-token' }],
      [ntfyProvider, { serverUrl: 'https://example.test', topic: 'synthetic-topic' }],
    ] as const;
    for (const [provider, config] of providers) {
      for (const body of ['<html>upstream login</html>', '', '{}', '{"code":null,"errcode":null,"ok":null}']) {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
        expect((await provider.sendBatch(provider.parseConfig(config), [{ title: 'test', body: 'test' }])).ok).toBe(false);
      }
    }
  });

  it('边读边检查解压后的实际响应大小，并取消超大响应', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_NOTIFICATION_RESPONSE_BYTES + 1)); }, cancel });
    expect(await readJsonObject(new Response(stream))).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await readJsonObject(new Response('{"ok":true}'))).toEqual({ ok: true });
  });

  it('只需状态码时取消正文，连接异常不回显 URL 或密码', async () => {
    const cancel = vi.fn();
    await discardResponse(new Response(new ReadableStream({ cancel })));
    expect(cancel).toHaveBeenCalledOnce();
    const error = connectionFailure(new Error('Failed URL https://user:synthetic-password@example.test/token'));
    expect(error.error).not.toContain('synthetic-password');
    expect(error.error).not.toContain('https://');
    expect(connectionFailure(new DOMException('test', 'TimeoutError')).error).toContain('超时');
  });

  it('保留业务诊断，但隐藏完整 URL、查询令牌和 Authorization 值', () => {
    const result = redactNotificationError({ ok: false, error: '无效令牌 secret-token，地址 https://host.test/hook/path-secret?key=secret-token，密钥 bearer-token\r\n伪造日志' }, {
      webhookUrl: 'https://host.test/hook/path-secret?key=secret-token', headers: [{ key: 'Authorization', value: 'Bearer bearer-token' }],
    });
    expect(result.error).toContain('无效令牌');
    for (const secret of ['secret-token', 'path-secret', 'bearer-token', '\r', '\n']) expect(result.error).not.toContain(secret);
    expect(redactNotificationError({ ok: false, error: 'x'.repeat(1000) }, { token: '\ud800token' }).error!.length).toBe(500);
  });

  it('草稿测试与定时发送共用脱敏出口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errcode: 1, errmsg: 'invalid secret-query-token' }))));
    const config = { webhookUrl: 'https://example.test/hook?access_token=secret-query-token' };
    const draft = await testNotificationConfig('dingtalk', config);
    const scheduled = await sendNotificationChannelBatch({ id: 1, type: 'dingtalk', name: 'test', enabled: true, deliveryKey: 'test', config }, [{ title: 'test', body: 'test' }]);
    expect(draft).toEqual(scheduled);
    expect(draft).toEqual({ ok: false, error: 'invalid [已隐藏]' });
  });
});
