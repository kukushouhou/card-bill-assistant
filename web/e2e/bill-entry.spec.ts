import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import type { AgendaResult } from '../src/api/types';

const output = (process.env.UI_FIXTURE_OUTPUT || '../.ui-fixture/test-results') + '/screenshots';
test.use({ reducedMotion: 'reduce' });
const rowFor = (page: Page, tail: string) => page.locator(tail === '6677'
  ? '.agenda-table .ant-table-row, .agenda-mobile-row'
  : `[data-row-key="bill:${({ '0988': 101, '2233': 102, '8855': 104 } as Record<string, number>)[tail]}"]`)
  .filter({ has: page.getByText('卡尾 ' + tail, { exact: true }) });
const detailDialog = (page: Page) => page.getByRole('dialog', { name: '账单明细', exact: true });
async function closeDetail(page: Page, width: number) {
  if (width < 1024) await page.locator('.mobile-nav-back-button').click();
  else { await detailDialog(page).locator('.ant-modal-close').click(); await expect(detailDialog(page)).toBeHidden(); }
}
test.beforeEach(async ({ request }) => {
  const reset = await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  expect(await reset.json()).toEqual({ ok: true });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
});

test('实际待处理接口与两端页面保持还款日排序', async ({ page, request }) => {
  const agenda: AgendaResult = await (await request.get('/api/agenda?view=open')).json();
  const sorted = [...agenda.items].sort((a, b) => Number(!a.daysOverdue) - Number(!b.daysOverdue) || a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  expect(agenda.items.map(item => item.key)).toEqual(sorted.map(item => item.key));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/bills');
    const rows = page.locator('.agenda-table .ant-table-row, .agenda-mobile-row');
    await expect(rows).toHaveCount(agenda.items.length);
    expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-row-key')))).toEqual(agenda.items.map(item => item.key));
  }
});

for (const width of [1024, 1440, 390]) test('整格点击与缺账卡片历史 ' + width, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const source = '/bills?bank=' + encodeURIComponent('交通银行');
  for (const tail of ['0988', '2233', '6677']) for (const column of width < 1024 ? [0] : [0, 1]) {
    await page.goto(source);
    const row = rowFor(page, tail); await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: '明细', exact: true })).toBeEnabled();
    const cell = width < 1024 ? row.locator('.agenda-row-body') : row.locator('td').nth(column);
    // 特意点击单元格左上角留白，不能只验证文字按钮。
    await cell.click({ position: { x: 4, y: 4 } });
    if (tail === '6677') {
      if (width < 1024) await expect(page).toHaveURL(/transactions\?cardId=3$/);
      else await expect(detailDialog(page)).toBeVisible();
      await expect(page.locator('.transaction-context')).toContainText('历史明细');
      await expect(page.getByText('交通银行（6677）').first()).toBeVisible();
      await expect(page.getByText('交通银行（0988）')).toHaveCount(0);
      await expect(page.getByRole('region', { name: '本账单还款概况' })).toHaveCount(0);
    } else {
      if (width < 1024) await expect(page).toHaveURL(new RegExp('transactions\\?billId=' + (tail === '0988' ? '101' : '102') + '$'));
      else await expect(detailDialog(page)).toBeVisible();
      const summary = page.getByRole('region', { name: '本账单还款概况' });
      await expect(summary).toContainText(tail === '0988' ? '¥8.80' : '¥34.60');
      await expect(summary.getByText('待还', { exact: true })).toBeVisible();
      if (tail === '2233') await expect(page.getByText('该账单暂无明细', { exact: true })).toBeVisible();
      else await expect(page.getByText('账单调整', { exact: true })).toBeVisible();
      await page.getByText('历史明细', { exact: true }).click();
      await expect(page.getByRole('region', { name: '本账单还款概况' })).toHaveCount(0);
    }
    await page.getByRole('button', { name: '查看全部明细', exact: true }).click();
    await expect(page.getByRole('button', { name: '返回来源', exact: true })).toHaveCount(0);
    if (width < 1024) await expect(page).toHaveURL(/\/transactions$/);
    else expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(source);
    await closeDetail(page, width);
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(source);
    await expect(rowFor(page, tail)).toBeVisible();
  }
});

test('前两列键盘操作与还款菜单互不干扰', async ({ page }) => {
  await page.goto('/bills');
  let row = rowFor(page, '6677');
  await row.locator('td').first().getByRole('button').focus(); await page.keyboard.press('Enter');
  await expect(detailDialog(page)).toContainText('卡尾 6677');
  await closeDetail(page, 1440);
  await rowFor(page, '0988').locator('td').nth(1).getByRole('button').focus(); await page.keyboard.press('Space');
  await expect(detailDialog(page)).toContainText('卡尾 0988');
  await closeDetail(page, 1440);
  row = rowFor(page, '0988');
  await row.getByRole('button', { name: '还款', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await expect(page).toHaveURL(/\/bills$/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await rowFor(page, '6677').getByRole('button', { name: '更多', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '标记异常', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '删除账单', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/bills$/);
});

for (const width of [1440, 390]) test('卡片范围与历史展开返回 ' + width, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/cards'); await page.locator('.bank-card').first().click();
  const detail = width < 1024 ? page.locator('.mobile-card-detail') : page.getByRole('dialog').filter({ hasText: '交通银行 · 4 张卡' });
  await detail.getByText('卡尾 6677', { exact: true }).click();
  if (width < 1024) await expect(page).toHaveURL(/cardId=3$/);
  else { await expect(page).toHaveURL(/\/cards$/); await expect(detailDialog(page)).toContainText('卡尾 6677'); }
  await closeDetail(page, width); await expect(detail).toBeVisible();
  await expect(detail.getByText('卡尾 6677', { exact: true })).toBeVisible();
  await page.goto('/bills?view=history&pageSize=1');
  await page.getByTitle('2', { exact: true }).click();
  const group = page.locator('.agenda-history-heading'); await group.click();
  const row = page.locator('.agenda-table .ant-table-row, .agenda-mobile-row').first();
  await row.getByRole('button', { name: '明细', exact: true }).click();
  await expect(page.getByRole('region', { name: '本账单还款概况' })).toContainText('已还清');
  await closeDetail(page, width);
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toContainText('7月');
  const pagination = page.locator('.bill-center .agenda-list').first().locator(':scope > .agenda-workspace > .ant-pagination, :scope > .agenda-results > .ant-pagination');
  await expect(pagination.locator('.ant-pagination-item-active')).toHaveText('2');
});

for (const width of [1440, 390]) test('本账单概况不依赖交易数量且展示部分还款 ' + width, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  await request.put('/api/bills/102/paid', { data: { action: 'partial', paidAmount: 10 } });
  await page.goto('/transactions?billId=102');
  const summary = page.getByRole('region', { name: '本账单还款概况' });
  await expect(summary).toContainText('¥34.60');
  await expect(summary).toContainText('已还最低');
  await expect(summary.locator('dl > div').filter({ hasText: '已还金额' })).toContainText('¥10.00');
  await expect(summary.locator('dl > div').filter({ hasText: '剩余待还' })).toContainText('¥24.60');
  await expect(summary).not.toContainText('今天应还');
  await expect(page.getByText('该账单暂无明细', { exact: true })).toBeVisible();
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: output + '/bill-summary-' + width + '.png', fullPage: true, animations: 'disabled' });
});

for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) test('到期强调与明细入口排版 ' + skin + ' ' + mode, async ({ page, request }) => {
  test.setTimeout(60_000);
  await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
  await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const shift = (offset: number) => new Date(Date.parse(day + 'T00:00:00+08:00') + offset * 86_400_000).toISOString();
  await page.route('**/api/agenda?*', async route => {
    const response = await route.fetch(); const data: AgendaResult = await response.json();
    for (const item of data.items) if (item.bill) {
      const offset = item.bill.missing ? 2 : ({ 101: 0, 102: 1, 103: 3, 104: 8 } as Record<number, number>)[item.bill.id!] ?? 0;
      item.bill.dueDate = shift(offset); item.date = item.bill.dueDate;
      item.bill.daysOverdue = null; item.daysOverdue = null;
    }
    data.items.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
    await route.fulfill({ json: data });
  });
  await fs.mkdir(output, { recursive: true });
  for (const width of [360, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/bills');
    await expect(page.locator('html')).toHaveAttribute('data-skin', skin + '@1.0.0');
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
    await expect(rowFor(page, '0988').getByText('今天应还', { exact: true })).toBeVisible();
    await expect(rowFor(page, '2233').getByText('明天应还', { exact: true })).toBeVisible();
    await expect(rowFor(page, '6677').getByText('2 天后还款', { exact: true })).toBeVisible();
    await expect(rowFor(page, '8855').getByText('8 天后还款', { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.locator('.agenda-record-actions').evaluateAll(elements => elements.map(element => {
      const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect().toJSON());
      return { bounds: element.closest('td, .agenda-row-actions')!.getBoundingClientRect().toJSON(), buttons };
    }));
    for (const actions of layout) for (const button of actions.buttons) {
      expect(button.right).toBeLessThanOrEqual(actions.bounds.right + .5);
      expect(Math.abs(button.y - actions.buttons[0].y)).toBeLessThan(.5);
      if (width < 1024) expect(Math.round(button.height * 1000) / 1000).toBeGreaterThanOrEqual(44);
    }
    const noticesVisible = await page.locator('.agenda-due-notice').evaluateAll(elements => elements.every(element => {
      const rect = element.getBoundingClientRect();
      const bottom = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect().top ?? innerHeight;
      if (rect.top < 0 || rect.bottom > bottom) return true;
      return element.contains(document.elementFromPoint(rect.right - 2, rect.top + rect.height / 2));
    }));
    expect(noticesVisible, '到期提示不能被固定列或其他控件遮住').toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: output + '/bills-' + skin + '-' + mode + '-' + width + '.png', fullPage: true, animations: 'disabled' });
    await rowFor(page, '0988').getByRole('button', { name: '明细', exact: true }).click();
    await expect(page.getByRole('region', { name: '本账单还款概况' })).toBeVisible();
    await page.screenshot({ path: output + '/transactions-' + skin + '-' + mode + '-' + width + '.png', fullPage: true, animations: 'disabled' });
  }
});
