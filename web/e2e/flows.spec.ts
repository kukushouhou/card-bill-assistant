import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
});

test('两端卡片详情进入统一明细并返回原套卡', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/cards');
    await page.locator('.bank-card').first().click();
    const detail = width === 390 ? page.locator('.mobile-card-detail') : page.getByRole('dialog').filter({ hasText: '交通银行 · 4 张卡' });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('button', { name: '标记已还', exact: true })).toHaveCount(0);
    if (width === 390) await detail.locator('.agenda-row-body').filter({ hasText: '卡尾 2233' }).click();
    else await detail.getByRole('row').filter({ hasText: '卡尾 2233' }).getByRole('button', { name: /^\d+月$/ }).click();
    await expect(page).toHaveURL(/billId=102/);
    await expect(page.getByText('该账单暂无明细', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回来源', exact: true }).click();
    await expect(detail).toBeVisible();
    await expect(detail.getByText('卡尾 2233', { exact: true })).toBeVisible();
    await page.screenshot({ path: '../.ui-fixture/screenshots/card-detail-' + width + '.png', fullPage: true });
  }
});

test('提醒编辑保留管理来源与取消草稿，两端可用', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/bills');
    await page.getByRole('button', { name: '提醒设置', exact: false }).click();
    const manager = width === 390 ? page.locator('section[aria-label="提醒设置"]') : page.locator('.custom-reminder-manager-modal');
    await expect(manager).toBeVisible();
    await manager.getByRole('button', { name: '编辑', exact: true }).first().click();
    const form = page.locator('.custom-reminder-form');
    await form.getByLabel('名称', { exact: false }).fill('每月房租 · 调整');
    const editor = width === 390 ? page.locator('section[aria-label="编辑提醒"]') : page.locator('.custom-reminder-form-modal');
    await editor.getByRole('button', { name: width === 390 ? '保存' : '确定', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(manager.getByText('每月房租 · 调整', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '编辑', exact: true }).first().click();
    await page.locator('.custom-reminder-form').getByLabel('名称', { exact: false }).fill('不会保存的草稿');
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await expect(editor.getByText('放弃未保存的修改？', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '放弃修改', exact: true }).click();
    await expect(manager.getByText('每月房租 · 调整', { exact: true })).toBeVisible();
  }
});

test('还款按钮不跳转，连续确认只写一次，已还进入历史组', async ({ page }) => {
  await page.goto('/bills');
  let calls = 0;
  await page.route('**/api/bills/101/paid', async route => { calls++; await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
  const row = page.getByRole('row').filter({ hasText: '卡尾 0988' }).filter({ hasNotText: '/' });
  const period = await row.getByRole('button', { name: /^\d+月$/ }).innerText();
  await row.getByRole('button', { name: '还款', exact: true }).click();
  await expect(page).toHaveURL(/\/bills$/);
  const modal = page.getByRole('dialog');
  await modal.getByText('全部还清', { exact: true }).click();
  await modal.getByRole('button', { name: '确定', exact: true }).dblclick();
  await expect(row).toHaveCount(0); expect(calls).toBe(1);
  await page.getByText('历史', { exact: true }).click();
  await page.locator('.agenda-history-heading').filter({ has: page.getByText(period, { exact: true }) }).click();
  await expect(page.getByRole('row').filter({ hasText: '卡尾 0988' }).getByText('已还清', { exact: true })).toBeVisible();
});

test('邮箱测试不保存，日志带账户，进度退出后可从全局重开', async ({ page }) => {
  let saved = 0;
  page.on('request', request => { if (request.method() === 'PUT' && /\/api\/email\/accounts\/1$/.test(request.url())) saved++; });
  await page.goto('/email'); await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('登录账号', { exact: false }).fill('draft@example.test');
  await editor.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByText('连接成功，收件箱共 24 封邮件')).toBeVisible();
  expect(saved).toBe(0); await expect(editor.getByLabel('登录账号', { exact: false })).toHaveValue('draft@example.test');
  await editor.getByRole('button', { name: '取消', exact: true }).click(); await editor.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.getByRole('button', { name: '同步', exact: false }).filter({ hasNotText: '重新' }).first().click();
  await page.getByRole('button', { name: '查看日志', exact: true }).click();
  const requests: string[] = []; page.on('request', request => requests.push(request.url()));
  await expect(page.getByText('信用卡电子账单', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回邮箱账户' }).click();
  await page.getByRole('button', { name: '拉取历史', exact: false }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('任务将在后台继续，可离开此页面后从任务条返回查看。')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '返回邮箱绑定' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.desktop-header-actions').getByRole('button', { name: '历史拉取进度' }).click();
  await expect(page.getByRole('dialog').getByText(/33.3%/)).toBeVisible();
});

test('通知渠道切换取消保留旧渠道和输入', async ({ page }) => {
  await page.goto('/settings');
  const notifications = page.locator('.settings-grid-notifications');
  await notifications.getByLabel('推送地址', { exact: false }).fill('https://example.test/draft');
  await notifications.getByRole('combobox').first().click();
  await page.getByText('Gotify', { exact: true }).last().click();
  await expect(notifications.getByText('切换通知渠道？', { exact: true })).toBeVisible();
  await notifications.getByRole('button', { name: '取消', exact: true }).click();
  await expect(notifications.getByLabel('推送地址', { exact: false })).toHaveValue('https://example.test/draft');
});
