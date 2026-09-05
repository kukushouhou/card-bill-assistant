import { test, expect } from '@playwright/test';

test.use({ actionTimeout: 8_000 });
for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) {
  test('设置开关的比例、状态与键盘操作 ' + skin + ' ' + mode, async ({ browser, request }) => {
    for (const width of [1440, 390]) {
      await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
      await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
      const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width, height: 1000 } });
      try {
        await context.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
        const page = await context.newPage(); await page.goto('/settings');
        await expect(page.locator('html')).toHaveAttribute('data-skin', skin + '@1.0.0');
        const row = page.locator('.settings-delivery-row'); const control = page.getByRole('switch', { name: '发送状态', exact: true });
        await expect(control).toHaveAttribute('aria-checked', 'true');
        await expect(row).toContainText('开启');
        const device = width < 1024 ? 'mobile' : 'desktop';
        await row.screenshot({ path: '../docs/skins/previews/' + skin + '-' + mode + '-switch-' + device + '.png', animations: 'disabled' });
        const geometry = await row.evaluate(element => {
          const copy = element.querySelector('.settings-delivery-copy')!.getBoundingClientRect();
          const control = element.querySelector('button')!.getBoundingClientRect();
          return { height: control.height, width: control.width, gap: control.left - copy.right, center: Math.abs(control.y + control.height / 2 - copy.y - copy.height / 2) };
        });
        expect(geometry.height).toBeGreaterThanOrEqual(44); expect(geometry.width).toBeGreaterThanOrEqual(44);
        expect(geometry.gap).toBeGreaterThanOrEqual(20); expect(geometry.center).toBeLessThan(1);
        await control.click(); await expect(control).toHaveAttribute('aria-checked', 'false'); await expect(row).toContainText('关闭');
        await row.screenshot({ path: '../docs/skins/previews/' + skin + '-' + mode + '-switch-off-' + device + '.png', animations: 'disabled' });
        await control.focus(); await control.press('Space');
        await expect(control).toHaveAttribute('aria-checked', 'true'); await expect(row).toContainText('开启');
      } finally { await context.close(); }
    }
  });
}
