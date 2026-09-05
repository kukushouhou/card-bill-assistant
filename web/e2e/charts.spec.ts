import { test, expect } from '@playwright/test';

for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) {
  test('两端走势图与提示框 ' + skin + ' ' + mode, async ({ page, request }) => {
    await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
    await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto('/');
      const canvas = page.locator('.trend-wrap canvas'); await canvas.scrollIntoViewIfNeeded(); await expect(canvas).toBeVisible();
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width * .7, box.y + box.height * .4);
      const tooltip = page.locator('.g2-tooltip'); await expect(tooltip).toBeVisible();
      await expect(tooltip.locator('.g2-tooltip-title')).toHaveText(/^\d+月$/);
      await expect(tooltip).toContainText('金额'); await expect(tooltip).toContainText('笔数');
      const colors = await tooltip.evaluate(element => ({ tooltip: getComputedStyle(element).backgroundColor, surface: getComputedStyle(document.documentElement).getPropertyValue('--elevated').trim() }));
      expect(colors.tooltip).not.toBe('rgba(255, 255, 255, 0.96)');
      await page.screenshot({ path: '../.ui-fixture/screenshots/' + skin + '-' + mode + '-' + width + '/chart.png', fullPage: true });
    }
  });
}
