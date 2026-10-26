import { test, expect, type Page } from '@playwright/test';
import type { AnnualFeeNotice, PagedTransactions } from '../src/api/types';
import { displayPeriod } from '../src/lib/displayDate';

test.use({ reducedMotion: 'reduce' });
test.beforeEach(async ({ request }) => {
  await request.post('/__fixture', { data: { reset: true, annualFees: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
});

const billRow = (page: Page, id: number) => page.locator('[data-row-key="bill:' + id + '"]');
const summary = (page: Page) => page.getByRole('region', { name: '本账单还款概况' });

for (const mode of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
  test(`年费标签与交易高亮 ${mode} ${width}`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/bills');
    await expect(billRow(page, 104).getByText('含年费 ¥200.00', { exact: true })).toBeVisible();
    await expect(billRow(page, 103).getByText('含年费 USD $12.60', { exact: true })).toBeVisible();
    await expect(billRow(page, 102).getByText('含年费 ¥20.00', { exact: true })).toBeVisible();
    await expect(billRow(page, 101).getByText(/含年费/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('bills.png'), fullPage: true, animations: 'disabled' });

    // 从真实列表入口进入桌面弹窗或手机明细页，不能只测孤立标签组件。
    await billRow(page, 104).getByRole('button', { name: '明细', exact: true }).click();
    await expect(summary(page).getByText('含年费 ¥200.00', { exact: true })).toBeVisible();
    const rows = page.locator(width < 1024 ? '.transaction-mobile-card' : '.transaction-table .ant-table-row');
    await expect(rows).toHaveCount(7);
    await expect(rows.filter({ hasText: '信用卡年费' })).toHaveClass(/annual-fee-row/);
    await expect(rows.locator('.ant-tag').filter({ hasText: /^年费$/ })).toHaveCount(1);
    await expect(page.locator('.transaction-content .annual-fee-row')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('details.png'), fullPage: true, animations: 'disabled' });
  });
}

for (const width of [1440, 390]) {
  test(`确认首页提醒和还款后仍保留账单年费 ${width}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const data: PagedTransactions = await (await request.get('/api/transactions?billId=104')).json();
    const bill = data.context!;
    const notice: AnnualFeeNotice = {
      billCount: 1, acknowledgeThroughBillId: 104,
      items: [{ billId: 104, bankName: bill.bankName, cardTails: [bill.cardLast4], period: bill.period, currency: 'CNY', annualFeeAmount: 200, hasDetails: true }],
      banks: [{ bankName: bill.bankName, billCount: 1, cardTails: [bill.cardLast4], totalsByCurrency: [{ currency: 'CNY', amount: 200 }] }],
    };
    // 首页确认沿用独立通知状态；账单与明细继续走实际路由和内存账单。
    let acknowledged = false;
    await page.route('**/api/dashboard/summary', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), annualFeeNotice: acknowledged ? null : notice } });
    });
    await page.route('**/api/dashboard/annual-fee-notice/acknowledge', async route => {
      expect(route.request().postDataJSON()).toEqual({ acknowledgeThroughBillId: 104 });
      acknowledged = true;
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/');
    await page.getByRole('status', { name: '年费提醒' }).getByRole('button', { name: '知道了', exact: true }).click();
    await expect(page.getByRole('status', { name: '年费提醒' })).toHaveCount(0);
    expect(acknowledged).toBe(true);
    await page.goto('/bills');
    await expect(billRow(page, 104).getByText('含年费 ¥200.00', { exact: true })).toBeVisible();

    await request.put('/api/bills/104/paid', { data: { action: 'partial', paidAmount: 300 } });
    await page.reload();
    await expect(billRow(page, 104).getByText('含年费 ¥200.00', { exact: true })).toBeVisible();
    await billRow(page, 104).getByRole('button', { name: '明细', exact: true }).click();
    await expect(summary(page).getByText('含年费 ¥200.00', { exact: true })).toBeVisible();
    await expect(summary(page)).toContainText('¥980.00');

    await request.put('/api/bills/104/paid', { data: { action: 'full' } });
    await page.goto('/bills?view=history');
    await page.locator('.agenda-history-heading').filter({ has: page.getByText(displayPeriod(bill.period), { exact: true }) }).click();
    await expect(billRow(page, 104).getByText('含年费 ¥200.00', { exact: true })).toBeVisible();
    await billRow(page, 104).getByRole('button', { name: '明细', exact: true }).click();
    await expect(summary(page).getByText('已还清', { exact: true })).toBeVisible();
    await expect(summary(page).getByText('含年费 ¥200.00', { exact: true })).toBeVisible();
    await expect(page.locator('.transaction-content .annual-fee-row')).toHaveCount(1);
  });

  test(`年费概况不依赖明细分页或有无交易 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/transactions?billId=104&page=2&pageSize=1');
    await expect(summary(page).getByText('含年费 ¥200.00', { exact: true })).toBeVisible();
    await expect(page.locator('.transaction-content .annual-fee-row')).toHaveCount(0);
    await page.goto('/transactions?billId=102');
    await expect(page.getByText('该账单暂无明细', { exact: true })).toBeVisible();
    await expect(summary(page).getByText('含年费 ¥20.00', { exact: true })).toBeVisible();
    await page.goto('/transactions?billId=103');
    await expect(summary(page).getByText('含年费 USD $12.60', { exact: true })).toBeVisible();
    await page.goto('/transactions?billId=101');
    await expect(summary(page).getByText(/含年费/)).toHaveCount(0);
    await page.goto('/transactions?billId=200');
    await expect(summary(page).getByText(/含年费/)).toHaveCount(0);
  });
}
