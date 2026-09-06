// 仅连接隔离示例服务，生成 README 实际引用的全部界面截图。
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = path.join(root, 'docs/images');
const baseURL = 'http://127.0.0.1:4173';
const written = new Set();
await fs.mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function fixture(context, data) {
  const response = await context.request.post('/__fixture', { data });
  assert.equal(response.status(), 200, '必须先启动隔离示例服务');
  assert.deepEqual(await response.json(), { ok: true }, '当前地址不是隔离示例服务');
}

async function withPage(width, mode, skin, run) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: width < 1024 ? 844 : 1000 } });
  try {
    await fixture(context, { reset: true, installed: true, authed: true, upgrade: null, failNext: null });
    const selected = await context.request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    assert.equal(selected.status(), 200);
    await context.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
    const page = await context.newPage();
    const visit = async route => {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin + '@1.0.0');
      await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
      await page.evaluate(() => document.fonts.ready);
    };
    const save = async (name, element) => {
      await expect(page.locator('.ant-message-notice')).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      await (element ?? page).screenshot({ path: path.join(directory, name), ...(element ? {} : { fullPage: true }), animations: 'disabled' });
      written.add('./docs/images/' + name);
    };
    await run({ context, page, visit, save });
  } finally { await context.close(); }
}

try {
  await withPage(1440, 'light', 'modern', async ({ page, visit, save }) => {
    await visit('/'); await expect(page.locator('.trend-wrap canvas')).toBeVisible();
    await expect(page.locator('.dashboard-list-item').first()).toBeVisible();
    await save('dashboard-desktop.png');
    await visit('/bills'); await expect(page.locator('.agenda-totals')).toContainText('4,123.40');
    await save('bill-center-desktop.png');
    await visit('/transactions'); await expect(page.getByText('账单调整', { exact: true }).first()).toBeVisible();
    await save('transactions-desktop.png');
    await visit('/cards'); await expect(page.locator('.bank-card').first()).toBeVisible();
    await save('card-center-desktop.png');
    await visit('/email'); await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
    await save('email-desktop.png');
    await visit('/parsers'); await page.getByRole('button', { name: /开始试解析/ }).click();
    await expect(page.locator('.parser-bill-summary').first()).toBeVisible();
    await save('parser-center-desktop.png');
    await visit('/settings'); await expect(page.locator('.skin-library-item')).toHaveCount(2);
    await expect.poll(() => page.locator('.skin-library-preview img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    await save('skin-manager-desktop.png', page.locator('.skin-manager'));
  });

  await withPage(390, 'light', 'modern', async ({ page, visit, save }) => {
    await visit('/'); await expect(page.locator('.mobile-todo-card').first()).toBeVisible();
    await expect(page.locator('.trend-wrap canvas')).toBeVisible();
    await save('dashboard-mobile.png');
    await visit('/bills'); await expect(page.locator('.agenda-totals')).toContainText('4,123.40');
    await save('bill-center-mobile.png');
    await visit('/transactions?billId=101'); await expect(page.locator('.transaction-mobile-card').first()).toBeVisible();
    await save('transactions-mobile.png');
  });

  for (const [skin, mode] of [['modern', 'dark'], ['warm-ledger', 'light'], ['warm-ledger', 'dark']]) {
    await withPage(390, mode, skin, async ({ page, visit, save }) => {
      await visit('/bills'); await expect(page.locator('.agenda-totals')).toContainText('4,123.40');
      await save(skin + '-' + mode + '-mobile.png');
    });
  }

  for (const width of [1440, 390]) {
    await withPage(width, 'light', 'modern', async ({ context, page, visit, save }) => {
      await fixture(context, { installed: false, authed: false });
      await visit('/'); await page.getByRole('button', { name: '下一步', exact: true }).click();
      await page.getByLabel('登录密码', { exact: true }).fill('Ui-fixture-only-123');
      await page.getByLabel('确认密码', { exact: true }).fill('Ui-fixture-only-123');
      await page.getByRole('button', { name: '下一步', exact: true }).click();
      await page.getByRole('button', { name: '下一步', exact: true }).click();
      await expect(page.getByRole('region', { name: '外观主题' })).toBeVisible();
      await page.getByText('温润账本', { exact: true }).click();
      await expect.poll(() => page.locator('.builtin-skin-preview').evaluateAll(images => images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
      await save('setup-theme-' + (width < 1024 ? 'mobile' : 'desktop') + '.png');
    });
  }

  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  const referenced = new Set([...readme.matchAll(/["(](\.\/docs\/images\/[^"\)]+\.png)/g)].map(match => match[1]));
  assert.deepEqual([...referenced].filter(name => !written.has(name)), [], 'README 存在尚未更新的配图');
  console.log(`已更新 README 全部 ${referenced.size} 张界面配图。`);
} finally { await browser.close(); }
