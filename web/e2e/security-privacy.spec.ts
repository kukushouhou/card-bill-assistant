import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
});

test('页面进入返回缓存前清除卡片明文和 PIN，过期响应不能恢复明文', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto('/cards');
    await page.locator('.bank-card-eye').first().click();
    await page.getByPlaceholder('6 位数字 PIN').fill('123456');
    await page.getByRole('button', { name: '验证', exact: true }).click();
    await expect(page.getByText('4111 1111 1111 0988', { exact: true })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.getByText('4111 1111 1111 0988', { exact: true })).toHaveCount(0);
    await page.locator('.bank-card-eye').first().click();
    await expect(page.getByPlaceholder('6 位数字 PIN')).toHaveValue('');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.getByPlaceholder('6 位数字 PIN')).toHaveCount(0);

    let release: () => void = () => {};
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/cards/1/secret/view', async route => { await responseGate; await route.continue(); });
    await page.locator('.bank-card-eye').first().click();
    await page.getByPlaceholder('6 位数字 PIN').fill('123456');
    const pending = page.waitForRequest('**/api/cards/1/secret/view');
    await page.getByRole('button', { name: '验证', exact: true }).click();
    await pending;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    const completed = page.waitForResponse('**/api/cards/1/secret/view');
    release(); await completed;
    await expect(page.getByText('4111 1111 1111 0988', { exact: true })).toHaveCount(0);
    await page.unroute('**/api/cards/1/secret/view');
  }
});
