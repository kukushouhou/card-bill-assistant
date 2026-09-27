import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
});

test('桌面卡片排序下拉可选择', async ({ page }) => {
  await page.goto('/cards');
  await page.getByRole('combobox', { name: '卡片排序方式' }).click();
  await expect(page.locator('.ant-select-dropdown:visible')).toBeVisible();
  await page.locator('.ant-select-item-option').filter({ hasText: '出账日排序' }).click();
  await expect(page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '卡片排序方式' }) })).toContainText('出账日排序');
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
});

test('桌面卡片齿轮菜单可编辑', async ({ page }) => {
  await page.goto('/cards');
  await page.getByRole('button', { name: '打开 交通银行（0988）卡片设置' }).click();
  await page.getByRole('menuitem', { name: '编辑', exact: false }).click();
  await expect(page.getByRole('dialog', { name: '编辑卡片 - 交通银行（0988）' })).toBeVisible();
});

test('桌面邮箱重新同步可确认', async ({ page }) => {
  await page.goto('/email');
  await page.getByRole('button', { name: /重新同步$/ }).click();
  await expect(page.getByText('重新同步该邮箱？', { exact: true })).toBeVisible();
});

test('桌面可应用温润账本', async ({ page }) => {
  await page.goto('/settings');
  await page.locator('.skin-library-item').filter({ hasText: '温润账本' }).getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
});
