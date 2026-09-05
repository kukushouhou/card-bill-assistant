import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test.beforeEach(async ({ request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
});

test('统一明细空态、相关卡片历史和返回来源', async ({ page }) => {
  await page.goto('/bills');
  await page.getByRole('row').filter({ hasText: '卡尾 2233' }).getByRole('button', { name: /^\d+月$/ }).click();
  await expect(page).toHaveURL(/billId=102/);
  await expect(page.getByText('该账单暂无明细', { exact: true })).toBeVisible();
  await page.getByText('历史明细', { exact: true }).click();
  await expect(page).toHaveURL(/scopeBillId=102/);
  await expect(page.getByText('交通银行（2233）').first()).toBeVisible();
  await expect(page.getByText('交通银行（0988）')).toHaveCount(0);
  await page.getByRole('button', { name: '返回来源' }).click();
  await expect(page).toHaveURL(/\/bills$/);
  await page.getByRole('row').filter({ hasText: '卡尾 0988' }).filter({ hasNotText: '/' }).getByRole('button', { name: /^\d+月$/ }).click();
  await expect(page.getByText('账单调整', { exact: true })).toBeVisible();
  await expect(page.getByText('7月28日', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看全部明细' }).click();
  await expect(page).toHaveURL(/\/transactions$/);
  await page.getByRole('searchbox', { name: '搜索交易描述' }).fill('未出账消费');
  await page.getByRole('searchbox', { name: '搜索交易描述' }).press('Enter');
  await expect(page.getByText('未出账消费')).toBeVisible();
});

test('皮肤预览隔离、应用和明暗切换保留表单', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/settings');
  const warm = page.locator('.skin-library-item').filter({ hasText: '温润账本' });
  await warm.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '预览 · 温润账本' })).toBeVisible();
  await expect(page.frameLocator('iframe[title="皮肤效果预览"]').getByRole('heading', { name: '账单中心' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'modern@1.0.0');
  await page.getByRole('dialog', { name: '预览 · 温润账本' }).getByRole('button', { name: '取消', exact: true }).click();
  await page.getByLabel('原密码', { exact: false }).fill('example-draft');
  await warm.getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
  await expect(page.getByLabel('原密码', { exact: false })).toHaveValue('example-draft');
  await page.locator('.desktop-header-actions').getByText('深色', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(page.getByLabel('原密码', { exact: false })).toHaveValue('example-draft');
  await page.screenshot({ path: '../.ui-fixture/screenshots/warm-desktop-dark-settings.png', fullPage: true });
  await page.getByRole('menuitem', { name: '账单中心', exact: false }).click();
  await expect(page.getByRole('dialog', { name: '有未保存的修改' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑' }).click();
  await expect(page.getByLabel('原密码', { exact: false })).toHaveValue('example-draft');
  expect(errors).toEqual([]);
});

test('账单中心两端加载与卡片身份', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/bills');
  await expect(page.locator('html')).toHaveAttribute('data-skin', /@1.0.0/);
  await expect(page.getByText('卡尾 0988', { exact: true })).toBeVisible();
  await expect(page.getByText('卡尾 2233', { exact: true })).toBeVisible();
  await fs.mkdir('../.ui-fixture/screenshots', { recursive: true });
  await page.screenshot({ path: '../.ui-fixture/screenshots/desktop-bills.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.agenda-mobile-row').first()).toBeVisible();
  await expect(page.locator('.mobile-bottom-nav').getByText('提醒', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: '../.ui-fixture/screenshots/mobile-bills.png', fullPage: true });
  expect(errors).toEqual([]);
});
