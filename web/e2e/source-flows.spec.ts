import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } }); });

test('桌面试解析第二页查看原文后仍停在第二页', async ({ page }) => {
  await page.route('**/api/email/dry-run', async route => {
    const response = await route.fetch(); const data = await response.json();
    await route.fulfill({ json: { results: Array.from({ length: 12 }, (_, index) => ({ ...data.results[0], uid: 1234 + index, subject: '账单样本 ' + (index + 1) })) } });
  });
  await page.goto('/parsers'); await page.getByRole('button', { name: /开始试解析/ }).click();
  await page.locator('.ant-pagination-item-2').click(); await expect(page.getByText('账单样本 11', { exact: true })).toBeVisible();
  await page.getByRole('row').filter({ hasText: '账单样本 11' }).getByRole('button', { name: /查看/ }).click();
  await expect(page.getByRole('dialog').getByText('交通银行电子账单（示例）', { exact: false })).toBeVisible();
  await page.getByRole('dialog').locator('.ant-modal-close').click();
  await expect(page.locator('.ant-pagination-item-active')).toHaveText('2'); await expect(page.getByText('账单样本 11', { exact: true })).toBeVisible();
});

test('手机退出历史拉取后可从全局任务入口重开同一进度', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/email');
  await page.getByRole('button', { name: '拉取历史', exact: true }).click();
  await page.getByRole('button', { name: '开始历史拉取', exact: true }).click();
  const progress = page.locator('section[aria-label="历史拉取进度"]'); await expect(progress.getByText(/33.3%/)).toBeVisible();
  await progress.getByRole('button', { name: '返回邮箱绑定', exact: true }).click();
  await expect(progress).toHaveCount(0); await page.locator('.mobile-history-task-bar').click();
  await expect(progress.getByText(/33.3%/)).toBeVisible(); await expect(progress).toContainText('demo@example.test');
});
