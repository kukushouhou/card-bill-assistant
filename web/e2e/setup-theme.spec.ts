import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { SkinDescriptor, SkinVariant } from '../src/skins/types';

test.use({ actionTimeout: 8_000 });
async function begin(page: Page, request: APIRequestContext, width: number) {
  await request.post('/__fixture', { data: { reset: true, installed: false, authed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
  await request.post('/__fixture', { data: { authed: false } });
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/'); await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByLabel('登录密码', { exact: true }).fill('Ui-fixture-only-123');
  await page.getByLabel('确认密码', { exact: true }).fill('Ui-fixture-only-123');
}

for (const width of [360, 390, 768, 1024, 1440]) {
  test('安装主题步骤与明暗预览 ' + width, async ({ page, request }) => {
    await begin(page, request, width);
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(page.getByRole('button', { name: '完成安装', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(page.getByRole('region', { name: '外观主题', exact: true })).toBeVisible();
    if (width < 1024) await expect(page.locator('.setup-mobile-progress')).toContainText('步骤 4 / 5');
    else await expect(page.locator('.ant-steps')).toContainText('外观主题');
    await page.getByText('温润账本', { exact: true }).click();
    await page.getByRole('button', { name: '上一步', exact: true }).click();
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(page.getByRole('radio', { name: /温润账本/ })).toBeChecked();
    const directory = '../.ui-fixture/setup-theme'; await fs.mkdir(directory, { recursive: true });
    for (const [mode, label] of [['light', '浅色'], ['dark', '深色']]) {
      await page.getByRole('radiogroup', { name: '明暗模式' }).getByText(label, { exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
      const previews = page.locator('.builtin-skin-preview'); await expect(previews).toHaveCount(2);
      for (const preview of await previews.all()) {
        await expect(preview).toHaveAttribute('src', new RegExp((width < 1024 ? 'mobile' : 'desktop') + '-' + mode + '-[a-f0-9]{12}\\.png$'));
        await expect(preview).toHaveCSS('object-fit', 'contain');
      }
      await expect.poll(() => previews.evaluateAll(elements => elements.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      const choices = await page.locator('.builtin-skin-option').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      if (width >= 1024) expect(Math.abs(choices[0].y - choices[1].y)).toBeLessThan(1);
      else expect(choices[1].y).toBeGreaterThanOrEqual(choices[0].bottom);
      for (const choice of choices) expect(choice.right).toBeLessThanOrEqual(width);
      const captions = await page.locator('.builtin-skin-caption').evaluateAll(elements => elements.map(element => {
        const baseline = (node: Element | null) => { if (!node) throw new Error('缺少预览标题'); const marker = document.createElement('span'); Object.assign(marker.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' }); node.append(marker); const y = marker.getBoundingClientRect().y; marker.remove(); return y; };
        return { title: baseline(element.querySelector('strong')), selected: element.querySelector(':scope > span') ? baseline(element.querySelector(':scope > span')) : null };
      }));
      if (width >= 1024) expect(Math.abs(captions[0].title - captions[1].title)).toBeLessThan(.5);
      for (const caption of captions) if (caption.selected != null) expect(Math.abs(caption.title - caption.selected)).toBeLessThan(.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: directory + '/theme-' + mode + '-' + width + '.png', fullPage: true, animations: 'disabled' });
    }
    await page.getByRole('radiogroup', { name: '明暗模式' }).getByText('跟随系统', { exact: true }).click();
    await page.emulateMedia({ colorScheme: 'light' }); await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
    await page.emulateMedia({ colorScheme: 'dark' }); await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  });
}

for (const width of [1440, 390]) test('安装返回、失败重试和主题切换保留全部配置 ' + width, async ({ page, request }) => {
  await begin(page, request, width);
  await page.getByLabel('PIN 码', { exact: true }).fill('123456');
  await page.getByLabel('确认 PIN', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '添加渠道', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Bark', exact: true }).click();
  await page.getByLabel('推送地址', { exact: true }).fill('https://example.test/setup-notify');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByText('温润账本', { exact: true }).click();
  await page.getByRole('radiogroup', { name: '明暗模式' }).getByText('深色', { exact: true }).click();
  await request.post('/__fixture', { data: { failNext: '/api/setup/install' } });
  const first = page.waitForRequest('**/api/setup/install');
  await page.getByRole('button', { name: '完成安装', exact: true }).click();
  const payload = (await first).postDataJSON();
  expect(payload).toMatchObject({ skinId: 'warm-ledger', password: 'Ui-fixture-only-123', pin: '123456', notifications: [{ type: 'bark', config: { url: 'https://example.test/setup-notify' } }] });
  await expect(page.getByText('请求暂时失败，请重试', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.getByLabel('推送地址', { exact: true })).toHaveValue('https://example.test/setup-notify');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.getByLabel('PIN 码', { exact: true })).toHaveValue('123456');
  await expect(page.getByLabel('登录密码', { exact: true })).toHaveValue('Ui-fixture-only-123');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('radio', { name: /温润账本/ })).toBeChecked();
  let calls = 0;
  await page.route('**/api/setup/install', async route => { calls++; await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
  const submitted = page.waitForRequest('**/api/setup/install');
  await page.getByRole('button', { name: '完成安装', exact: true }).dblclick();
  expect((await submitted).postDataJSON()).toEqual(payload);
  await expect(page.getByText('安装完成！', { exact: true })).toBeVisible();
  expect(calls).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
});

test('皮肤管理共用两端日夜的实际预览文件', async ({ page, request }) => {
  await request.post('/__fixture', { data: { reset: true, installed: true, authed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
  const builtins: SkinDescriptor[] = await (await request.get('/api/skins/builtins')).json();
  for (const width of [1440, 390]) for (const mode of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: mode });
    await page.goto('/settings'); await expect(page.locator('.skin-library-item')).toHaveCount(2);
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
    const variant = ((width < 1024 ? 'mobile' : 'desktop') + '-' + mode) as SkinVariant;
    for (const skin of builtins) {
      const filename = skin.manifest.previews[variant];
      const preview = page.locator('.skin-library-item').filter({ hasText: skin.manifest.name }).locator('.skin-library-preview img');
      await expect(preview).toHaveAttribute('src', skin.baseUrl + filename);
      await expect(preview).toHaveCSS('object-fit', 'contain');
      const response = await request.get(skin.baseUrl + filename);
      expect(response.status()).toBe(200);
      const bytes = await response.body();
      expect(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
      expect(filename).toContain(createHash('sha256').update(bytes).digest('hex').slice(0, 12));
    }
    await page.locator('.skin-manager').screenshot({ path: '../.ui-fixture/setup-theme/manager-' + mode + '-' + width + '.png', animations: 'disabled' });
  }
});
