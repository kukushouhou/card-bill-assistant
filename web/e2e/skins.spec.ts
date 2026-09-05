import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test.beforeEach(async ({ request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
});

test('独立皮肤包导入、隔离预览、应用、导出重导入与删除', async ({ page, request }) => {
  await request.delete('/api/skins/graphite-notebook/1.0.0', { data: { restoreDefault: true } });
  await page.goto('/settings');
  await page.locator('.skin-manager input[type=file]').setInputFiles('../docs/skins/examples/graphite-notebook.zip');
  const preview = page.getByRole('dialog').filter({ hasText: '预览 · 石墨账本示例' });
  await expect(preview).toBeVisible();
  const frame = page.frameLocator('iframe[title="皮肤效果预览"]');
  await expect(frame.locator('html')).toHaveAttribute('data-skin', 'graphite-notebook@1.0.0');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'modern@1.0.0');
  await expect(frame.getByRole('button', { name: '还款', exact: true }).first()).toHaveCSS('border-radius', '3px');
  await preview.getByText('手机', { exact: true }).click();
  await preview.locator('.skin-preview-controls').getByText('深色', { exact: true }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(frame.locator('.agenda-mobile-row').first()).toBeVisible();
  await preview.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'modern@1.0.0');
  const sample = page.locator('.skin-library-item').filter({ hasText: '石墨账本示例' });
  await sample.getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'graphite-notebook@1.0.0');
  expect(await page.locator('.desktop-app-header').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Skin Lora');
  await expect(page.locator('.desktop-app-sider [data-skin-icon="CreditCardOutlined"] img')).toHaveAttribute('src', /graphite-notebook/);
  const download = page.waitForEvent('download'); await sample.getByRole('link', { name: '导出', exact: true }).click();
  const file = await download; await file.saveAs('../.ui-fixture/exported-skin.zip');
  expect((await fs.stat('../.ui-fixture/exported-skin.zip')).size).toBeGreaterThan(1000);
  await page.locator('.skin-manager input[type=file]').setInputFiles('../.ui-fixture/exported-skin.zip');
  await expect(page.getByText('该皮肤版本已存在')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await sample.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '恢复默认并删除', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'modern@1.0.0');
  await expect(page.locator('.skin-library-item').filter({ hasText: '石墨账本示例' })).toHaveCount(0);
});

test('跨设备同步皮肤，本地明暗互不覆盖并支持跟随系统', async ({ browser, request }) => {
  const first = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const second = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  try {
    const a = await first.newPage(); const b = await second.newPage();
    await a.goto('/bills'); await b.goto('/bills');
    await expect(a.locator('html')).toHaveAttribute('data-mode', 'light');
    await expect(b.locator('html')).toHaveAttribute('data-mode', 'dark');
    await a.locator('.desktop-header-actions').getByText('浅色', { exact: true }).click();
    await request.put('/api/skins/active', { data: { id: 'warm-ledger', version: '1.0.0' } });
    await a.evaluate(() => window.dispatchEvent(new Event('focus'))); await b.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(a.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
    await expect(b.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
    await expect(a.locator('html')).toHaveAttribute('data-mode', 'light');
    await expect(b.locator('html')).toHaveAttribute('data-mode', 'dark');
    await b.emulateMedia({ colorScheme: 'light' });
    await expect(b.locator('html')).toHaveAttribute('data-mode', 'light');
    await a.reload(); await expect(a.locator('html')).toHaveAttribute('data-mode', 'light');
  } finally { await first.close(); await second.close(); }
});

test('删除前另一设备应用了目标皮肤时，不擅自恢复默认', async ({ page, request }) => {
  await request.post('/api/skins/import', { headers: { 'Content-Type': 'application/zip' }, data: await fs.readFile('../docs/skins/examples/graphite-notebook.zip') });
  await page.goto('/settings'); const sample = page.locator('.skin-library-item').filter({ hasText: '石墨账本示例' });
  await sample.getByRole('button', { name: '删除', exact: true }).click();
  await request.put('/api/skins/active', { data: { id: 'graphite-notebook', version: '1.0.0' } });
  const rejected = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/api/skins/graphite-notebook'));
  await page.getByRole('dialog').getByRole('button', { name: '删除皮肤', exact: true }).click(); expect((await rejected).status()).toBe(409);
  expect((await (await request.get('/api/skins/active')).json()).manifest.id).toBe('graphite-notebook');
  await request.delete('/api/skins/graphite-notebook/1.0.0', { data: { restoreDefault: true } });
});
