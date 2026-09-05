import { test, expect, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';

async function expectSummaryLayout(summary: Locator, mobile: boolean, count = 2) {
  const values = summary.locator('.agenda-summary-value');
  await expect(values).toHaveCount(count);
  const primary = summary.locator('.agenda-summary-primary');
  if ((await primary.locator('.agenda-summary-readable').textContent())?.startsWith('¥')) {
    await expect(primary.locator('.agenda-summary-currency-name')).toHaveCount(0);
    await expect(summary).not.toContainText('人民币');
    await expect(summary).not.toContainText('CNY');
  }
  // 弹窗的入场缩放结束后再检验实际间距，不将动画过程中的缩放尺寸当作最终布局。
  await summary.evaluate(async element => {
    const animations: Animation[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) animations.push(...node.getAnimations());
    await Promise.all(animations.filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
  });
  // 同一帧读取全部坐标，避免弹窗入场缩放期间混用不同帧的尺寸。
  const layout = await summary.evaluate(element => {
    // 零尺寸行内标记读取浏览器实际文字基线，读取后立即移除。
    const baseline = (node: Element) => {
      const marker = document.createElement('span');
      Object.assign(marker.style, { display: 'inline-block', width: '0', height: '0', padding: '0', margin: '0', border: '0', verticalAlign: 'baseline' });
      node.append(marker); const y = marker.getBoundingClientRect().y; marker.remove(); return y;
    };
    const numbers = [...element.querySelectorAll('.agenda-summary-number')].map(number => {
      const range = document.createRange(); range.selectNodeContents(number);
      return { ...number.getBoundingClientRect().toJSON(), lines: range.getClientRects().length };
    });
    return {
      numbers, bounds: element.getBoundingClientRect().toJSON(),
      overview: element.querySelector('.agenda-summary-overview')!.getBoundingClientRect().toJSON(),
      records: element.querySelector('.agenda-summary-records')?.getBoundingClientRect().toJSON(),
      sizes: [...element.querySelectorAll('.agenda-summary-value')].map(value => parseFloat(getComputedStyle(value).fontSize)),
      primary: element.querySelector('.agenda-summary-primary')?.getBoundingClientRect().toJSON(),
      other: element.querySelector('.agenda-summary-other')?.getBoundingClientRect().toJSON(),
      notices: element.querySelector('.agenda-summary-notices')?.getBoundingClientRect().toJSON(),
      noticeHeading: element.querySelector('.agenda-summary-notice-heading')?.getBoundingClientRect().toJSON(),
      noticeTitleBaseline: element.querySelector('.agenda-summary-notice-heading > span:last-child') ? baseline(element.querySelector('.agenda-summary-notice-heading > span:last-child')!) : null,
      notes: [...element.querySelectorAll('.agenda-summary-notes li')].map(note => ({
        bounds: note.getBoundingClientRect().toJSON(),
        label: note.querySelector('.agenda-summary-notice-label')!.getBoundingClientRect().toJSON(),
        count: note.querySelector('.agenda-summary-notice-count')!.getBoundingClientRect().toJSON(),
        baselines: ['.agenda-summary-notice-label', '.agenda-summary-notice-count strong', '.agenda-summary-notice-count > span'].map(selector => baseline(note.querySelector(selector)!)),
      })),
    };
  });
  for (const box of layout.numbers) { expect(box.lines).toBe(1); expect(box.right).toBeLessThanOrEqual(layout.bounds.right); }
  if (count > 1) {
    expect(layout.sizes[0]).toBeGreaterThanOrEqual(layout.sizes[1] * 1.3);
    await expect(summary.locator('.agenda-summary-currency-code')).toHaveCount(count - 1);
    if (mobile) expect(layout.other.y).toBeGreaterThanOrEqual(layout.primary.bottom);
    else expect(layout.other.x >= layout.primary.right || layout.other.y >= layout.primary.bottom).toBe(true);
  }
  const notices = summary.locator('.agenda-summary-notices');
  if (layout.notices) {
    await expect(notices).toContainText('待补充');
    if (mobile) {
      expect(layout.notices.y).toBeGreaterThanOrEqual(Math.max(...layout.numbers.map(item => item.bottom)));
      expect(layout.notes[0].bounds.y - layout.noticeHeading.bottom).toBeGreaterThanOrEqual(11);
    } else {
      expect(layout.records!.x - layout.overview.right).toBeGreaterThanOrEqual(15);
      expect(layout.notices.x - layout.records!.right).toBeGreaterThanOrEqual(15);
      expect(layout.notices.width).toBeLessThanOrEqual(layout.bounds.width * .35);
      expect(layout.notes[0].bounds.y).toBeGreaterThanOrEqual(layout.noticeHeading.bottom);
    }
    for (const note of layout.notes) {
      if (mobile) {
        expect(note.label.x - note.bounds.x).toBeGreaterThan(10);
        expect(note.bounds.right - note.count.right).toBeGreaterThan(10);
      } else {
        expect(Math.abs(note.label.x - layout.noticeHeading.x)).toBeLessThan(.5);
        expect(note.count.right).toBeLessThanOrEqual(layout.notices.right - 16);
      }
      expect(note.count.x - note.label.right).toBeGreaterThanOrEqual(7);
      expect(Math.max(...note.baselines) - Math.min(...note.baselines)).toBeLessThan(.5);
    }
    if (layout.notes.length === 2) {
      const [a, b] = layout.notes.map(note => note.bounds);
      expect(b.x - a.right >= 11 || b.y - a.bottom >= (mobile ? 11 : 5)).toBe(true);
      expect(Math.abs(a.height - b.height)).toBeLessThan(.5);
      if (Math.abs(a.y - b.y) < 1) expect(Math.abs(layout.notes[0].baselines[0] - layout.notes[1].baselines[0])).toBeLessThan(.5);
      else expect(Math.abs(a.x - b.x)).toBeLessThan(.5);
    }
  }
}

for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) {
  test('账期对齐与汇总分层 ' + skin + ' ' + mode, async ({ page, request }) => {
    test.setTimeout(60_000);
    await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
    await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
    const directory = '../.ui-fixture/summary-design'; await fs.mkdir(directory, { recursive: true });
    for (const width of [320, 360, 390, 768, 1023, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto('/bills');
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin + '@1.0.0');
      await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
      const summary = page.locator('.agenda-totals'); await expect(summary).toContainText('7 笔账单');
      await page.evaluate(() => document.fonts.ready);
      await expectSummaryLayout(summary, width < 1024);
      await expect(summary.locator('.agenda-summary-primary .agenda-summary-readable')).toHaveText('¥4,123.40');
      await expect(summary.locator('.agenda-summary-other .agenda-summary-readable')).toHaveText('USD $12.60');
      await expect(summary.locator('.agenda-summary-notes li').filter({ hasText: '未取得账单' }).locator('.agenda-summary-notice-count')).toHaveText('1 笔');
      await expect(summary.locator('.agenda-summary-notes li').filter({ hasText: '金额待填写' }).locator('.agenda-summary-notice-count')).toHaveText('1 笔');
      if (width < 1024) {
        const buttons = await page.locator('.agenda-navigation button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
        expect(Math.max(...buttons.map(box => box.y)) - Math.min(...buttons.map(box => box.y))).toBeLessThan(1);
        for (const button of buttons) expect(Math.round(button.height * 100) / 100).toBeGreaterThanOrEqual(44);
      }
      if (width >= 1024) {
        const starts = await page.locator('.agenda-period').evaluateAll(elements => elements.map(element => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); const node = walker.nextNode();
          const range = document.createRange(); range.selectNodeContents(node!); return range.getBoundingClientRect().x;
        }));
        expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(1);
        const heights = await page.locator('.agenda-period').evaluateAll(elements => elements.map(element => getComputedStyle(element.firstElementChild!).fontSize));
        expect(new Set(heights).size).toBe(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: directory + '/' + skin + '-' + mode + '-' + width + '.png', fullPage: true, animations: 'disabled' });
    }
    // 统计和卡片范围复用相同的汇总结构，不能只修正主页面。
    await page.getByRole('button', { name: /账单统计/ }).click();
    await expectSummaryLayout(page.getByRole('dialog').locator('.agenda-totals'), false);
    await page.getByRole('dialog').locator('.ant-modal-close').click();
    await page.goto('/cards'); await page.locator('.bank-card').first().click();
    await expectSummaryLayout(page.getByRole('dialog').locator('.agenda-totals'), false);
  });
}

for (const skin of ['modern', 'warm-ledger']) {
  test('桌面首屏与列宽保持紧凑 ' + skin, async ({ page, request }) => {
    test.setTimeout(60_000);
    await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null } });
    await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    await page.route('**/api/agenda?*', async route => {
      const response = await route.fetch(); const data = await response.json();
      data.summary.totalsByCurrency = [{ currency: 'CNY', amount: 48413.45 }];
      data.summary.billCount = 37;
      data.summary.missingBillCount = 30; data.summary.unknownAmountCount = 30;
      await route.fulfill({ json: data });
    });
    for (const width of [1024, 1280, 1366, 1920]) {
      await page.setViewportSize({ width, height: 768 }); await page.goto('/bills');
      const summary = page.locator('.agenda-totals'); await expect(summary).toContainText('48,413.45');
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin + '@1.0.0');
      await page.evaluate(() => document.fonts.ready);
      await expectSummaryLayout(summary, false, 1);
      const layout = await page.evaluate(() => {
        const content = document.querySelector('.app-shell-content')!;
        const rows = [...document.querySelectorAll('.agenda-table .ant-table-tbody > tr:not(.ant-table-measure-row)')];
        return {
          summary: document.querySelector('.agenda-totals')!.getBoundingClientRect().toJSON(),
          contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth,
          completeRows: rows.filter(row => row.getBoundingClientRect().bottom <= innerHeight).length,
          actionBounds: [...rows[0].querySelectorAll('button')].map(button => button.getBoundingClientRect().toJSON()),
          right: document.querySelector('.agenda-table')!.getBoundingClientRect().right,
          dateColumns: rows.map(row => [...row.querySelectorAll('.agenda-date-cell dd')].map(field => field.getBoundingClientRect().x)),
        };
      });
      expect(layout.summary.height).toBeLessThanOrEqual(160);
      expect(layout.completeRows).toBeGreaterThanOrEqual(4);
      expect(layout.contentScrollWidth).toBeLessThanOrEqual(layout.contentWidth + 1);
      for (const action of layout.actionBounds) expect(action.right).toBeLessThanOrEqual(layout.right);
      for (const dates of layout.dateColumns) if (dates.length > 1) expect(Math.abs(dates[0] - dates[1])).toBeLessThan(.5);
    }
    // 历史年份、长卡尾与“调整还款”同样需要留在各自列内。
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/bills?view=history');
    await page.locator('.agenda-history-heading').filter({ hasText: '2025年12月' }).click();
    await expect(page.getByRole('button', { name: '调整还款', exact: true }).first()).toBeVisible();
    const periods = await page.locator('.agenda-period').evaluateAll(elements => elements.map(element => ({ value: element.firstElementChild!.getBoundingClientRect().toJSON(), cell: element.closest('td')!.getBoundingClientRect().toJSON() })));
    for (const period of periods) expect(period.value.right).toBeLessThanOrEqual(period.cell.right);
    const historyActions = await page.locator('.agenda-history-group .agenda-record-actions button').evaluateAll(elements => elements.map(element => ({ button: element.getBoundingClientRect().toJSON(), table: element.closest('.agenda-table')!.getBoundingClientRect().toJSON() })));
    for (const action of historyActions) expect(action.button.right).toBeLessThanOrEqual(action.table.right);
    const historyDates = await page.locator('.agenda-history-group .agenda-date-cell dd').evaluateAll(elements => elements.map(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return { lines: range.getClientRects().length, right: range.getBoundingClientRect().right, cellRight: element.closest('td')!.getBoundingClientRect().right };
    }));
    for (const date of historyDates) { expect(date.lines).toBe(1); expect(date.right).toBeLessThanOrEqual(date.cellRight); }
  });
}

test('窄手机的大额与多币种汇总保持完整金额和说明层次', async ({ page, request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null } });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.route('**/api/agenda?*', async route => {
    const response = await route.fetch(); const data = await response.json();
    data.summary.totalsByCurrency = [{ currency: 'CNY', amount: 123456789.01 }, { currency: 'USD', amount: 98765432.1 }, { currency: 'EUR', amount: 0 }, { currency: 'JPY', amount: -123456 }];
    data.summary.billCount = 129; data.summary.missingBillCount = 101; data.summary.unknownAmountCount = 125;
    await route.fulfill({ json: data });
  });
  await page.goto('/bills'); const summary = page.locator('.agenda-totals'); await expect(summary).toContainText('123,456,789.01');
  await expectSummaryLayout(summary, true, 4);
  await expect(summary.locator('.agenda-summary-readable').nth(2)).toHaveText('EUR €0.00');
  await expect(summary.locator('.agenda-summary-readable').nth(3)).toHaveText('JPY -123,456');
});

test('没有人民币或没有已知金额时保持真实币种和空态', async ({ page, request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null } });
  let amounts = [{ currency: 'USD', amount: 12.6 }];
  await page.route('**/api/agenda?*', async route => {
    const response = await route.fetch(); const data = await response.json();
    data.summary.totalsByCurrency = amounts;
    await route.fulfill({ json: data });
  });
  const summary = page.locator('.agenda-totals');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/bills');
    await expect(summary.locator('.agenda-summary-primary')).toContainText('USD美元');
    await expect(summary.locator('.agenda-summary-readable')).toHaveText('USD $12.60');
    await expectSummaryLayout(summary, width < 1024, 1);
    const position = await summary.locator('.agenda-summary-primary').evaluate(element => {
      const label = element.querySelector('.agenda-summary-currency-name')!.getBoundingClientRect();
      const amount = element.querySelector('.agenda-summary-value')!.getBoundingClientRect();
      return { before: label.right <= amount.x || label.bottom <= amount.y };
    });
    expect(position.before).toBe(true);
  }
  amounts = []; await page.reload();
  await expect(summary).toContainText('暂无可汇总金额');
  await expect(summary.locator('.agenda-summary-value')).toHaveCount(0);
  await expect(summary.locator('.agenda-summary-notes li').filter({ hasText: '未取得账单' }).locator('.agenda-summary-notice-count')).toHaveText('1 笔');
});
