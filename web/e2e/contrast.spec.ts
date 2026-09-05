import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) {
  test('主要文字对比度 ' + skin + ' ' + mode, async ({ page, request }) => {
    test.setTimeout(90_000);
    await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
    await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
    const failures: unknown[] = [];
    for (const width of [1440, 390]) for (const route of ['/', '/bills', '/settings', '/parsers']) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto(route);
      await expect(page.locator('.page').first()).toBeVisible(); await expect(page.locator('html')).toHaveAttribute('data-skin', skin + '@1.0.0');
      await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
      const result = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const rgba = (value: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v); };
        const over = (fg: number[], bg: number[]) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3])).concat(1);
        const luminance = (color: number[]) => color.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const elements = document.querySelectorAll<HTMLElement>('h1,h2,h3,.ant-tag,.ant-typography-warning,.ant-typography-danger,.ant-statistic-content-value,.ant-card-head-title,.agenda-identity strong,.agenda-identity>span,.agenda-amount,.agenda-dates,.agenda-summary-title,.agenda-summary-value,.agenda-summary-metrics li,.agenda-summary-currency-name,.agenda-summary-currency dt,.agenda-summary-currency-code,.agenda-summary-notice-heading,.agenda-summary-notes li,.ant-form-item-label>label,.ant-typography-secondary,.ant-btn>span:not(.anticon),.ant-menu-title-content,.ant-segmented-item-label,.mobile-todo-card-due strong,.mobile-dashboard-key-stat strong,.ant-radio-button-wrapper-checked>span:last-child,.ant-switch-inner-checked');
        return [...elements].flatMap(element => {
          if (!element.textContent?.trim() || !element.getBoundingClientRect().width || element.closest('[disabled],[aria-hidden="true"],[inert],.ant-btn-disabled,.bank-card,.ant-select-dropdown')) return [];
          const chain: HTMLElement[] = []; let node: HTMLElement | null = element;
          while (node) { chain.unshift(node); node = node.parentElement; }
          if (chain.some(item => Number(getComputedStyle(item).opacity) < 1 || getComputedStyle(item).visibility === 'hidden')) return [];
          let background = [255, 255, 255, 1]; for (const item of chain) background = over(rgba(getComputedStyle(item).backgroundColor), background);
          const foreground = over(rgba(getComputedStyle(element).color), background);
          const a = luminance(foreground), b = luminance(background), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          return ratio >= 4.5 ? [] : [{ text: element.textContent.trim().slice(0, 60), class: element.className, ratio: Math.round(ratio * 100) / 100, color: getComputedStyle(element).color, background }];
        });
      });
      failures.push(...result.map(item => ({ width, route, ...item })));
    }
    await fs.writeFile('../.ui-fixture/contrast-' + skin + '-' + mode + '.json', JSON.stringify(failures, null, 2));
    expect(failures).toEqual([]);
  });
}
