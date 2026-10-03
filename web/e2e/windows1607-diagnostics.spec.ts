import { test, expect, chromium, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import os from 'node:os';

// 故障注入验证的是诊断分辨力，不是模拟 Windows 1607 内核或驱动。
const snapshotScript = readFileSync(new URL('../scripts/diagnose-desktop.js', import.meta.url), 'utf8');
const failureMessage = '皮肤资源无法加载，已保留原皮肤';
test.setTimeout(60_000);

test.beforeEach(async ({ request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
});

async function snapshot(page: Page, info: TestInfo, name: string) {
  const result = await page.evaluate(snapshotScript);
  await info.attach(name, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  return result;
}

async function inspectPopups(page: Page, info: TestInfo, expectedInViewport = true) {
  for (const scenario of [
    { name: 'select', path: '/cards', trigger: () => page.getByRole('combobox', { name: '卡片排序方式' }), selector: '.ant-select-dropdown' },
    { name: 'dropdown', path: '/cards', trigger: () => page.getByRole('button', { name: '打开 交通银行（0988）卡片设置' }), selector: '.ant-dropdown' },
    { name: 'popconfirm', path: '/email', trigger: () => page.getByRole('button', { name: /重新同步$/ }), selector: '.ant-popover' },
  ]) {
    await page.goto(scenario.path);
    await scenario.trigger().click();
    const popup = page.locator(scenario.selector).last();
    await expect(popup).toBeAttached();
    if (expectedInViewport) {
      await expect(popup).toBeInViewport();
      await expect(popup).toHaveCSS('opacity', '1');
    } else {
      await expect(popup).not.toBeInViewport();
      if (scenario.name === 'select') await expect(scenario.trigger()).toHaveAttribute('aria-expanded', 'true');
    }
    const report = await snapshot(page, info, scenario.name);
    const evidence = report.popups.find((entry: { element: { classes: string } }) => entry.element.classes.split(' ').includes(scenario.selector.slice(1)));
    expect(evidence.outsideRoot).toBe(true);
    expect(evidence.inViewport).toBe(expectedInViewport);
    expect(evidence.hitInside).toBe(expectedInViewport);
    if (scenario.name === 'select') await info.attach('select-screen', { body: await page.screenshot(), contentType: 'image/png' });
  }
}

for (const software of [false, true]) {
  test(`${software ? '禁用 GPU 对照' : '默认图形路径'}：采集 portal 坐标、命中与独立皮肤加载结果`, async ({ baseURL }, info) => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true, args: software ? ['--disable-gpu'] : [] });
    try {
      const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
      const session = await browser.newBrowserCDPSession();
      const graphics = await session.send('SystemInfo.getInfo');
      await session.detach();
      await info.attach('host-and-graphics', { body: JSON.stringify({ host: os.release(), browser: browser.version(), software,
        featureStatus: graphics.gpu.featureStatus, devices: graphics.gpu.devices }, null, 2), contentType: 'application/json' });
      await inspectPopups(page, info);
      await page.goto('/settings');
      await page.locator('.skin-library-item').filter({ hasText: '温润账本' }).getByRole('button', { name: '应用', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
      await snapshot(page, info, 'skin-loaded');
    } finally { await browser.close(); }
  });
}

test('仅破坏弹层测量即可使三类弹层离屏，皮肤仍可应用', async ({ page }, info) => {
  await page.addInitScript(() => {
    const measure = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const rect = measure.call(this);
      return this.matches('.ant-select-dropdown, .ant-dropdown, .ant-popover') ? new DOMRect(rect.x, rect.y, 0, 0) : rect;
    };
  });
  await inspectPopups(page, info, false);
  await page.goto('/settings');
  await page.locator('.skin-library-item').filter({ hasText: '温润账本' }).getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
  await snapshot(page, info, 'skin-independent-of-popup-measurement');
});

for (const fault of [
  { name: '样式 404', path: '**/warm-ledger/1.0.0/styles/base.css', stage: 'stylesheet', status: 404, contentType: 'text/css', body: '' },
  { name: '字体请求被拦截', path: '**/warm-ledger/1.0.0/assets/Lora.ttf', stage: 'font', status: 0, contentType: '', body: '' },
  { name: '字体 HTTP 200 但内容损坏', path: '**/warm-ledger/1.0.0/assets/Lora.ttf', stage: 'font', status: 200, contentType: 'font/ttf', body: 'invalid-font' },
  { name: '手机预览图 HTTP 200 但内容损坏', path: '**/warm-ledger/1.0.0/previews/mobile-dark-*.png', stage: 'image', status: 200, contentType: 'image/png', body: 'invalid-image' },
]) {
  test(`${fault.name}：细分失败、保留原外观，三类弹层不受影响且可重试`, async ({ page, request }, info) => {
    const diagnostics: Promise<Record<string, unknown>>[] = [];
    const network: Record<string, unknown>[] = [];
    let saves = 0;
    page.on('console', message => {
      if (message.text().startsWith('[skin-resource-load]')) diagnostics.push(message.args()[1].jsonValue());
    });
    page.on('request', req => { if (req.method() === 'PUT' && req.url().endsWith('/api/skins/active')) saves++; });
    page.on('requestfailed', req => {
      if (req.url().includes('/api/skins/assets/warm-ledger/')) network.push({ path: new URL(req.url()).pathname, failure: req.failure()?.errorText });
    });
    page.on('response', response => {
      if (response.url().includes('/api/skins/assets/warm-ledger/')) network.push({ path: new URL(response.url()).pathname, status: response.status(), type: response.headers()['content-type'] });
    });
    await page.route(fault.path, route => fault.status === 0 ? route.abort('blockedbyclient')
      : route.fulfill({ status: fault.status, contentType: fault.contentType, body: fault.body }));
    await page.goto('/settings');
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'modern@1.0.0');
    const warm = page.locator('.skin-library-item').filter({ hasText: '温润账本' });
    await warm.getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.getByText(failureMessage, { exact: true })).toBeVisible();
    await expect.poll(() => diagnostics.length).toBeGreaterThan(0);
    const failures = await Promise.all(diagnostics);
    expect(failures[0]).toMatchObject({ skin: 'warm-ledger@1.0.0', variant: 'desktop-light', stage: fault.stage });
    expect(failures[0].resource).toMatch(/^\/api\/skins\/assets\/warm-ledger\/1\.0\.0\//);
    expect(failures[0].causeName).toBeTruthy();
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'modern@1.0.0');
    await expect(page.locator('link[data-skin-dynamic="pending"]')).toHaveCount(0);
    expect(saves).toBe(0);
    expect((await (await request.get('/api/skins/active')).json()).manifest.id).toBe('modern');
    await info.attach('resource-failure', { body: JSON.stringify({ failures, network }, null, 2), contentType: 'application/json' });
    await inspectPopups(page, info);
    await page.unroute(fault.path);
    await page.goto('/settings');
    await warm.getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
    expect(saves).toBe(1);
  });
}

test('字体 API 缺失与资源请求失败可通过能力快照区分', async ({ page }, info) => {
  await page.addInitScript(() => Object.defineProperty(window, 'FontFace', { configurable: true, value: undefined }));
  const diagnostics: Promise<Record<string, unknown>>[] = [];
  page.on('console', message => { if (message.text().startsWith('[skin-resource-load]')) diagnostics.push(message.args()[1].jsonValue()); });
  await page.goto('/settings');
  await page.locator('.skin-library-item').filter({ hasText: '温润账本' }).getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.getByText(failureMessage, { exact: true })).toBeVisible();
  await expect.poll(() => diagnostics.length).toBeGreaterThan(0);
  expect((await Promise.all(diagnostics))[0]).toMatchObject({ stage: 'font', causeName: 'TypeError' });
  const report = await snapshot(page, info, 'missing-font-api');
  expect(report.capabilities.fontFace).toBe(false);
  await inspectPopups(page, info);
});
