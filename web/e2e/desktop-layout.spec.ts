import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test.use({ actionTimeout: 8_000 });

for (const skin of ['modern', 'warm-ledger']) {
  test('桌面首页和明细使用横向空间且不挤出主内容 ' + skin, async ({ page, request }) => {
    test.setTimeout(90_000);
    await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
    await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    await page.addInitScript(() => localStorage.setItem('appearance.mode', 'light'));
    const directory = '../.ui-fixture/desktop-review/' + skin; await fs.mkdir(directory, { recursive: true });
    for (const width of [1024, 1366, 1920]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto('/');
      await expect(page.locator('.dash-stat-card')).toHaveCount(4);
      await expect(page.locator('.dashboard-list-item').first()).toBeVisible();
      await expect(page.locator('.trend-wrap canvas')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const home = await page.evaluate(() => {
        const stats = [...document.querySelectorAll('.dash-stat-card')].map(element => element.getBoundingClientRect().toJSON());
        const panels = [...document.querySelectorAll('.dashboard-desktop-lower-card')].map(element => element.getBoundingClientRect().toJSON());
        return { stats, panels, chart: document.querySelector('.trend-wrap canvas')!.getBoundingClientRect().toJSON() };
      });
      // 横向放置统计和列表；稀疏内容不再撑成大块空白，走势不能挤走待办。
      expect(home.stats[1].x).toBeGreaterThan(home.stats[0].x);
      if (width >= 1280) {
        expect(new Set(home.stats.map(box => box.y)).size).toBe(1);
        expect(home.panels[1].x).toBeGreaterThan(home.panels[0].x);
        expect(home.panels[0].y).toBeLessThan(620);
      }
      for (const box of home.stats) expect(box.height).toBeLessThan(200);
      for (const box of home.panels) expect(box.height).toBeLessThan(500);
      expect(home.chart.height).toBeLessThanOrEqual(140);
      await page.screenshot({ path: directory + '/home-' + width + '.png', fullPage: true, animations: 'disabled' });

      await page.goto('/transactions'); await expect(page.getByRole('table')).toBeVisible();
      const filters = await page.locator('.transaction-filters > *').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      expect(Math.abs(filters[0].y - filters[1].y)).toBeLessThan(1);
      if (width < 1280) {
        expect(filters[2].y).toBeGreaterThanOrEqual(filters[0].bottom);
        expect(Math.abs(filters[2].y - filters[3].y)).toBeLessThan(1);
      } else expect(Math.max(...filters.map(box => box.y)) - Math.min(...filters.map(box => box.y))).toBeLessThan(1);
      // 表格可以在自己的容器内滚动，筛选和页面不能一起被挤出屏幕。
      const shell = await page.locator('.app-shell-content').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      expect(shell.scroll).toBeLessThanOrEqual(shell.width + 1);
      for (const box of filters) expect(box.right).toBeLessThanOrEqual(width);
      const money = await page.locator('.transaction-table .transaction-amount').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      expect(money.length).toBeGreaterThan(0);
      for (const amount of money) { expect(amount.right).toBeLessThanOrEqual(width - 16); expect(amount.x).toBeGreaterThan(208); }
      const periods = await page.locator('.transaction-period').evaluateAll(elements => elements.map(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        return { textRight: range.getBoundingClientRect().right, cellRight: element.closest('td')!.getBoundingClientRect().right, lines: range.getClientRects().length };
      }));
      expect(periods.length).toBeGreaterThan(0);
      for (const period of periods) { expect(period.lines).toBe(1); expect(period.textRight).toBeLessThanOrEqual(period.cellRight - 8); }
      await page.screenshot({ path: directory + '/transactions-' + width + '.png', fullPage: true, animations: 'disabled' });
    }
  });
}

test('桌面邮箱与卡信息保留并排分区，短 PIN 弹窗按内容定宽', async ({ page, request }) => {
  test.setTimeout(90_000);
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
  const directory = '../.ui-fixture/desktop-review/forms'; await fs.mkdir(directory, { recursive: true });
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/email');
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const email = page.getByRole('dialog'); await expect(email.getByLabel('登录账号', { exact: false })).toBeVisible();
    const parts = await email.locator('.email-editor-grid > section').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    expect(parts).toHaveLength(2);
    expect(Math.abs(parts[0].y - parts[1].y)).toBeLessThan(1);
    expect(parts[1].x).toBeGreaterThanOrEqual(parts[0].right);
    expect(await email.getByRole('button', { name: '保存', exact: true }).evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(900);
    await page.screenshot({ path: directory + '/email-editor-' + width + '.png', animations: 'disabled' });

    await page.goto('/cards'); await page.locator('.bank-card').first().locator('.bank-card-settings').click();
    await page.getByRole('menuitem', { name: '卡信息', exact: false }).click();
    const pin = page.getByRole('dialog'); await expect(pin.getByPlaceholder('6 位数字 PIN')).toBeVisible();
    expect((await pin.boundingBox())!.width).toBeLessThanOrEqual(440);
    await pin.getByPlaceholder('6 位数字 PIN').fill('123456'); await pin.getByRole('button', { name: '验证', exact: true }).click();
    const editor = page.getByRole('dialog').filter({ hasText: '已存信息' });
    await expect(editor.getByLabel('完整卡号', { exact: true })).toHaveValue('4111111111110988');
    const columns = await editor.locator('.ant-modal-body > .ant-row > .ant-col').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    expect(columns).toHaveLength(2);
    expect(Math.abs(columns[0].y - columns[1].y)).toBeLessThan(1);
    expect(columns[1].x).toBeGreaterThan(columns[0].x);
    expect(await editor.getByRole('button', { name: /保存$/ }).evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(900);
    await page.screenshot({ path: directory + '/card-information-' + width + '.png', animations: 'disabled' });
  }
});

test('窄桌面邮箱操作、执行结果与提醒表单完整可见', async ({ page, request }) => {
  test.setTimeout(90_000);
  const directory = '../.ui-fixture/desktop-review/operations'; await fs.mkdir(directory, { recursive: true });
  for (const skin of ['modern', 'warm-ledger']) for (const width of [1024, 1366]) {
    await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
    await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    await page.setViewportSize({ width, height: 900 }); await page.goto('/email');
    const row = page.getByRole('row').filter({ hasText: 'demo@example.test' });
    await expect(row.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
    const right = await page.locator('.app-shell-content').evaluate(element => element.getBoundingClientRect().right);
    const actions = await row.getByRole('button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().right));
    for (const action of actions) expect(action).toBeLessThanOrEqual(right);
    await page.screenshot({ path: directory + '/email-' + skin + '-' + width + '.png', fullPage: true, animations: 'disabled' });
    await page.getByRole('tab', { name: '同步日志', exact: true }).click();
    await expect(page.getByText('信用卡电子账单', { exact: true })).toBeVisible();
    expect(await page.locator('.app-shell-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

    await page.goto('/parsers'); await page.getByRole('button', { name: /开始试解析/ }).click();
    await expect(page.locator('.parser-bill-summary').first()).toBeVisible();
    expect(await page.locator('.app-shell-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const parsed = (await page.locator('.parser-bill-summary').first().boundingBox())!;
    expect(parsed.width).toBeGreaterThanOrEqual(250);
    expect(parsed.height).toBeLessThan(220);
    expect(await page.locator('.parser-result-table thead').evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(80);
    const view = page.locator('.parser-result-table').getByRole('button', { name: /查看/ }).first();
    expect(await view.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(right);
    await page.screenshot({ path: directory + '/parser-result-' + skin + '-' + width + '.png', fullPage: true, animations: 'disabled' });
    if (width < 1280) {
      const table = page.locator('.parser-result-table .ant-table-content');
      await table.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      const result = (await page.locator('.parser-bill-summary').first().boundingBox())!;
      const viewport = (await table.boundingBox())!;
      const action = (await view.boundingBox())!;
      expect(result.x).toBeGreaterThanOrEqual(viewport.x);
      expect(result.x + result.width).toBeLessThanOrEqual(action.x);
      await page.screenshot({ path: directory + '/parser-result-' + skin + '-' + width + '-scrolled.png', fullPage: true, animations: 'disabled' });
    }

    await page.goto('/bills'); await page.getByRole('button', { name: '提醒设置', exact: false }).click();
    await page.getByRole('button', { name: '新增提醒', exact: false }).click();
    const form = page.locator('.custom-reminder-form'); await expect(form).toBeVisible();
    const sections = await form.locator('.custom-reminder-form-layout > section').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    expect(sections).toHaveLength(2);
    expect(Math.abs(sections[0].y - sections[1].y)).toBeLessThan(1);
    expect(sections[1].x).toBeGreaterThanOrEqual(sections[0].right);
    await page.screenshot({ path: directory + '/reminder-' + skin + '-' + width + '.png', animations: 'disabled' });
  }
});
