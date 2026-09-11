import { test, expect, type Page } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });
test.beforeEach(async ({ request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
});

const details = (page: Page) => page.locator('.transaction-content');
const summary = (page: Page) => details(page).getByRole('region', { name: '本账单还款概况' });
const dialog = (page: Page) => page.getByRole('dialog', { name: '账单明细', exact: true });
const payment = (page: Page, width: number) => width < 1024 ? page.locator('.mobile-payment-flow') : page.getByRole('dialog', { name: /^标记还款/ });
const sourceRow = (page: Page, tail: string) => page.locator(`[data-row-key="bill:${({ '0988': 101, '2233': 102, '0988 / 8899': 103 } as Record<string, number>)[tail]}"]`)
  .filter({ has: page.getByText('卡尾 ' + tail, { exact: true }) });
async function partial(page: Page, width: number, amount: string) {
  const form = payment(page, width);
  await form.getByText(width < 1024 ? /记录部分还款|更正累计已还金额/ : '部分已还', { exact: width >= 1024 }).click();
  await form.getByRole('spinbutton').fill(amount);
  if (width >= 1024) {
    const input = await form.getByRole('spinbutton').boundingBox();
    const footer = await form.locator('.ant-modal-footer').boundingBox();
    expect(input!.y + input!.height, '金额输入框不能被底部按钮遮住').toBeLessThanOrEqual(footer!.y);
  }
}
async function save(page: Page, width: number, action: 'partial' | 'full' | 'unpaid') {
  await payment(page, width).getByRole('button', { name: width >= 1024 ? /确定$/ : action === 'partial' ? '保存还款' : action === 'full' ? '确认登记' : '确认恢复', exact: true }).click();
}

for (const width of [1440, 390]) test('空明细完成部分还款、全部还清与调整还款 ' + width, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const writes: { url: string; data: unknown }[] = [];
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/paid')) writes.push({ url: request.url(), data: request.postDataJSON() }); });
  await page.goto('/bills?bank=' + encodeURIComponent('交通银行'));
  const sourceUrl = page.url();
  await sourceRow(page, '2233').getByRole('button', { name: '明细', exact: true }).click();
  await expect(details(page).getByText('该账单暂无明细', { exact: true })).toBeVisible();
  await expect(details(page).getByRole('button', { name: '返回来源', exact: true })).toHaveCount(0);
  if (width >= 1024) await expect(page).toHaveURL(sourceUrl);
  else await expect(page).toHaveURL(/\/transactions\?billId=102$/);
  const detailUrl = page.url();
  await details(page).getByRole('button', { name: '还款', exact: true }).click();
  await partial(page, width, '10');
  await save(page, width, 'partial');
  await expect(payment(page, width)).toBeHidden();
  await expect(summary(page)).toContainText('¥24.60');
  await expect(summary(page)).toContainText('已还最低');
  await expect(page).toHaveURL(detailUrl);
  await page.screenshot({ path: testInfo.outputPath('partial.png'), animations: 'disabled' });

  await details(page).getByRole('button', { name: '还款', exact: true }).click();
  if (width < 1024) await payment(page, width).locator('.mobile-payment-actions .adm-list-item-content').first().click();
  else await payment(page, width).getByText('全部还清', { exact: true }).click();
  await save(page, width, 'full');
  await expect(summary(page).getByText('已还清', { exact: true })).toBeVisible();
  await expect(payment(page, width)).toBeHidden();
  await expect(page).toHaveURL(detailUrl);
  if (width >= 1024) await expect(sourceRow(page, '2233')).toHaveCount(0);

  await details(page).getByRole('button', { name: '调整还款', exact: true }).click();
  await payment(page, width).getByText(width < 1024 ? '恢复待还' : '恢复未还', { exact: width >= 1024 }).click();
  await save(page, width, 'unpaid');
  await expect(summary(page).getByText('待还', { exact: true })).toBeVisible();
  await expect(details(page).getByRole('button', { name: '还款', exact: true })).toBeEnabled();
  expect(writes.map(write => write.data)).toEqual([{ action: 'partial', paidAmount: 10 }, { action: 'full' }, { action: 'unpaid' }]);
  expect(writes.every(write => write.url.endsWith('/api/bills/102/paid'))).toBe(true);
  if (width >= 1024) await dialog(page).locator('.ant-modal-close').click();
  else {
    await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
    await page.locator('.mobile-nav-back-button').click();
  }
  await expect(page).toHaveURL(sourceUrl);
  await expect(sourceRow(page, '2233')).toBeVisible();
});

for (const width of [1440, 390]) test('提交失败保留输入，保存后的读取重试不再提交 ' + width, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/transactions?billId=102');
  await details(page).getByRole('button', { name: '还款', exact: true }).click();
  await partial(page, width, '12.34');
  let writes = 0, failRead = true;
  await page.route('**/api/bills/102/paid', async route => {
    writes++;
    if (writes === 1) await route.fulfill({ status: 500, json: { error: '还款保存暂时失败' } });
    else await route.continue();
  });
  await save(page, width, 'partial');
  await expect(page.getByText('还款保存暂时失败', { exact: true })).toBeVisible();
  await expect(payment(page, width).getByRole('spinbutton')).toHaveValue('12.34');
  await page.route('**/api/transactions?*', async route => {
    if (failRead) { failRead = false; await route.fulfill({ status: 500, json: { error: '暂时无法读取账单' } }); }
    else await route.continue();
  });
  await save(page, width, 'partial');
  await expect(payment(page, width)).toBeHidden();
  await expect(details(page).getByText('还款已保存，账单明细刷新失败', { exact: true })).toBeVisible();
  await expect(details(page).getByRole('button', { name: '还款', exact: true })).toBeDisabled();
  await details(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect(summary(page)).toContainText('¥22.26');
  expect(writes).toBe(2);
});

test('合并账单使用承接卡与真实账单编号，历史和全局查询无来源还款', async ({ page, request }) => {
  const data = await (await request.get('/api/transactions?billId=103')).json();
  expect(data.context).toMatchObject({ billId: 103, cardId: 1, cardLast4: '0988', cards: [{ id: 1 }, { id: 4 }] });
  await page.goto('/bills');
  await sourceRow(page, '0988 / 8899').getByRole('button', { name: '明细', exact: true }).click();
  await details(page).getByRole('button', { name: '还款', exact: true }).click();
  const form = payment(page, 1440);
  await expect(form).toContainText('交通银行（0988）');
  await expect(form).toContainText('$12.60');
  await form.getByText('全部还清', { exact: true }).click();
  const saved = page.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith('/api/bills/103/paid'));
  await save(page, 1440, 'full'); await saved;
  await expect(summary(page).getByText('已还清', { exact: true })).toBeVisible();
  expect((await (await request.get('/api/transactions?billId=101')).json()).context.paidStatus).toBe('unpaid');
  await details(page).getByText('历史明细', { exact: true }).click();
  await expect(details(page).getByRole('button', { name: /^(还款|调整还款)$/ })).toHaveCount(0);
  await details(page).getByRole('button', { name: '查看全部明细', exact: true }).click();
  await expect(details(page).getByRole('button', { name: /^(还款|调整还款)$/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\/bills$/);
});

test('首页还款只刷新统计、待办和未来安排，明细留在原处', async ({ page }) => {
  const reads = new Map<string, number>();
  page.on('request', request => {
    if (request.method() === 'GET') { const path = new URL(request.url()).pathname; reads.set(path, (reads.get(path) ?? 0) + 1); }
  });
  await page.goto('/');
  const todo = page.locator('.dashboard-bill-link').filter({ hasText: '2233' });
  await expect(todo).toBeVisible();
  await expect.poll(() => reads.get('/api/bills/trend')).toBeGreaterThan(0);
  const before = new Map(reads);
  await todo.click();
  await expect(page).toHaveURL(/\/$/);
  await details(page).getByRole('button', { name: '还款', exact: true }).click();
  await payment(page, 1440).getByText('全部还清', { exact: true }).click();
  await save(page, 1440, 'full');
  await expect(summary(page).getByText('已还清', { exact: true })).toBeVisible();
  await expect(todo).toHaveCount(0);
  for (const path of ['/api/dashboard/summary', '/api/reminders/todos', '/api/reminders/upcoming']) {
    await expect.poll(() => reads.get(path) ?? 0).toBeGreaterThan(before.get(path) ?? 0);
  }
  expect(reads.get('/api/bills/trend')).toBe(before.get('/api/bills/trend'));
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('.ant-modal-close').click();
  await expect(page).toHaveURL(/\/$/);
});

test('桌面关闭最上层还款与明细后保留套卡弹窗及滚动位置', async ({ page }) => {
  await page.goto('/cards');
  await page.locator('.bank-card').first().click();
  const group = page.getByRole('dialog', { name: '交通银行 · 4 张卡', exact: true });
  const row = group.locator('[data-row-key="bill:102"]');
  await row.scrollIntoViewIfNeeded();
  const scrollBefore = await group.locator('.ant-modal-body').evaluate(element => element.scrollTop);
  await row.getByRole('button', { name: '明细', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(group).toBeVisible();
  await details(page).getByRole('button', { name: '还款', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(payment(page, 1440)).toBeHidden();
  await expect(dialog(page)).toBeVisible();
  await expect(group).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(group).toBeVisible();
  await expect(page).toHaveURL(/\/cards$/);
  await expect(row.getByText('卡尾 2233', { exact: true })).toBeVisible();
  expect(await group.locator('.ant-modal-body').evaluate(element => element.scrollTop)).toBe(scrollBefore);
});

for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) for (const width of [1440, 390]) {
  test(`还款表单布局 ${skin} ${mode} ${width}`, async ({ page, request }, testInfo) => {
    await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/bills');
    await sourceRow(page, '2233').getByRole('button', { name: '明细', exact: true }).click();
    await details(page).getByRole('button', { name: '还款', exact: true }).click();
    await partial(page, width, '10');
    await expect(page.locator('html')).toHaveAttribute('data-skin', skin + '@1.0.0');
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
    if (width < 1024) await expect(page.locator('.ant-modal:visible')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('repayment.png'), animations: 'disabled' });
  });
}
