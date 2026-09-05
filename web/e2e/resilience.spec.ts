import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
});

test('两端 PIN 输入在换肤时保留，退出后清除且不发送空 PIN', async ({ page, request }) => {
  for (const width of [1440, 390]) {
    await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
    await page.setViewportSize({ width, height: 900 }); await page.goto('/cards');
    await page.locator('.bank-card').first().getByRole('button', { name: /查看.*完整卡信息/ }).click();
    const input = page.getByPlaceholder('6 位数字 PIN'); await input.fill('123456');
    await request.put('/api/skins/active', { data: { id: 'warm-ledger', version: '1.0.0' } });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
    await expect(input).toHaveValue('123456');
    const pinRequests: string[] = []; const capture = (req: import('@playwright/test').Request) => { if (req.url().includes('/secret/view')) pinRequests.push(req.postData() ?? ''); }; page.on('request', capture);
    if (width === 390) await page.getByRole('button', { name: '取消', exact: true }).click();
    else await page.getByRole('dialog').locator('.ant-modal-close').click();
    await expect(input).toHaveCount(0); expect(pinRequests).toEqual([]); page.off('request', capture);
    await page.locator('.bank-card').first().getByRole('button', { name: /查看.*完整卡信息/ }).click();
    await expect(page.getByPlaceholder('6 位数字 PIN')).toHaveValue('');
    if (width === 390) await page.getByRole('button', { name: '取消', exact: true }).click();
    else await page.getByRole('dialog').locator('.ant-modal-close').click();
  }
});

test('应用保存失败保留当前皮肤和表单，重试可继续', async ({ page, request }) => {
  await page.goto('/settings'); await page.getByLabel('原密码', { exact: true }).fill('draft-only');
  await request.post('/__fixture', { data: { failNext: '/api/skins/active' } });
  const warm = page.locator('.skin-library-item').filter({ hasText: '温润账本' });
  await warm.getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.getByText('请求暂时失败，请重试', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'modern@1.0.0');
  await expect(page.getByLabel('原密码', { exact: true })).toHaveValue('draft-only');
  await warm.getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
  await expect(page.getByLabel('原密码', { exact: true })).toHaveValue('draft-only');
});

test('换肤保留在途还款锁，失败保留输入且只提交一次', async ({ page, request }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  await page.route('**/api/bills/101/paid', async route => { calls++; await gate; await route.fulfill({ status: 503, json: { error: '还款保存失败，请重试' } }); });
  await page.goto('/bills');
  await page.getByRole('row').filter({ hasText: '卡尾 0988' }).filter({ hasNotText: '/' }).getByRole('button', { name: '还款', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByText('部分已还', { exact: true }).click();
  await dialog.getByPlaceholder('累计已还金额').fill('3'); await dialog.getByRole('button', { name: '确定', exact: true }).dblclick();
  await request.put('/api/skins/active', { data: { id: 'warm-ledger', version: '1.0.0' } }); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
  await expect(dialog.getByPlaceholder('累计已还金额')).toHaveValue('3.00'); expect(calls).toBe(1);
  release(); await expect(page.getByText('还款保存失败，请重试', { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible(); await expect(dialog.getByPlaceholder('累计已还金额')).toHaveValue('3.00');
});

test('两端试解析原文绑定执行账户，读取失败留在原文并支持重试返回', async ({ page, request }) => {
  await request.post('/api/email/accounts', { data: { email: 'second@example.test', imapHost: 'imap.example.test', imapPort: 993, enabled: true } });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/parsers');
    await page.getByRole('button', { name: /开始试解析/ }).click();
    await expect(page.getByText('试解析完成：1 封中 1 封可解析')).toBeVisible();
    await page.getByLabel('邮箱账户', { exact: false }).click(); await page.getByText('second@example.test', { exact: true }).last().click();
    await request.post('/__fixture', { data: { failNext: '/api/email/accounts/1/messages/1234' } });
    await page.getByRole('button', { name: width < 1024 ? /查看邮件原文/ : /查看$/ }).click();
    const body = width < 1024 ? page.locator('section[aria-label="邮件原文"]') : page.getByRole('dialog');
    await expect(body.getByText('请求暂时失败，请重试', { exact: true })).toBeVisible();
    const loaded = page.waitForResponse('**/api/email/accounts/1/messages/1234'); await body.getByRole('button', { name: '重试', exact: true }).click(); expect((await loaded).status()).toBe(200);
    await expect(body.getByText('交通银行电子账单（示例）', { exact: false })).toBeVisible();
    if (width < 1024) await page.locator('.mobile-nav-back-button').click(); else await body.locator('.ant-modal-close').click();
    await expect(page.getByRole('button', { name: width < 1024 ? /查看邮件原文/ : /查看$/ })).toBeVisible();
    await expect(page.getByText('second@example.test', { exact: true }).first()).toBeVisible();
  }
});

test('历史摘要来自完整范围，组内分页与不存在账单保持边界', async ({ request, page }) => {
  const grouped = await (await request.get('/api/agenda?view=history&cardIds=1,2,3,4&pageSize=1')).json();
  expect(grouped.total).toBe(2); expect(grouped.recordCount).toBe(8); expect(grouped.groups[0].count).toBe(4);
  const detail = await (await request.get('/api/agenda?view=history&cardIds=1,2,3,4&period=2026-07&pageSize=1')).json();
  expect(detail.total).toBe(4); expect(detail.items).toHaveLength(1); expect(detail.summary.totalsByCurrency).toEqual(grouped.groups[0].totalsByCurrency);
  await page.goto('/transactions?billId=999999'); await expect(page.getByText('账单不存在', { exact: true })).toBeVisible();
  await expect(page.getByText('该账单暂无明细', { exact: true })).toHaveCount(0);
});

test('两端还款金额退出确认，取消退出保留输入', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/bills');
    const row = width < 1024 ? page.locator('.agenda-mobile-row').filter({ hasText: '卡尾 0988' }).filter({ hasNotText: '/' }) : page.getByRole('row').filter({ hasText: '卡尾 0988' }).filter({ hasNotText: '/' });
    await row.getByRole('button', { name: '还款', exact: true }).click();
    await page.getByText(width < 1024 ? '记录部分还款' : '部分已还', { exact: width >= 1024 }).click();
    const input = width < 1024 ? page.getByLabel('累计已还金额', { exact: true }) : page.getByPlaceholder('累计已还金额'); await input.fill('3');
    if (width < 1024) { await page.locator('.mobile-nav-back-button').click(); await page.locator('.mobile-nav-back-button').click(); }
    else await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    if (width < 1024) await page.getByText('记录部分还款', { exact: false }).click();
    await expect(input).toHaveValue('3.00');
    if (width < 1024) { await page.locator('.mobile-nav-back-button').click(); await page.locator('.mobile-nav-back-button').click(); }
    else await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click(); await expect(input).toHaveCount(0);
  }
});

test('损坏的本地皮肤缓存不会阻止页面进入', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('appearance.skin-cache', JSON.stringify({ manifest: { id: 'broken-cache', compatibility: { skinApi: 1 }, variants: { 'desktop-light': { tokens: {} } } } })));
  await request.post('/__fixture', { data: { failNext: '/api/skins/active' } });
  await page.goto('/bills'); await expect(page.locator('html')).toHaveAttribute('data-skin', 'modern@1.0.0');
  await expect(page.getByRole('button', { name: '还款', exact: true }).first()).toBeVisible();
});
