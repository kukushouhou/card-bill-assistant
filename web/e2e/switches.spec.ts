import { test, expect } from '@playwright/test';

test.use({ actionTimeout: 8_000 });
for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) {
  test('设置开关的比例、状态与键盘操作 ' + skin + ' ' + mode, async ({ browser, request }) => {
    for (const width of [1440, 390]) {
      await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
      await request.post('/api/settings/notification-channels', { data: { type: 'bark', name: '我的 iPhone', enabled: true, config: { url: 'https://example.test/first', group: '家庭提醒', sound: 'minuet' } } });
      await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
      const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width, height: 1000 } });
      try {
        await context.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
        const page = await context.newPage(); await page.goto('/settings');
        await expect(page.locator('html')).toHaveAttribute('data-skin', skin + '@1.0.0');
        // 通知渠道行的启用开关：桌面表格行与手机卡片行共用同一控件与状态文案
        const control = page.getByRole('switch', { name: '启用 我的 iPhone', exact: true });
        const row = width < 1024
          ? page.locator('.notification-channel-card').filter({ hasText: '我的 iPhone' })
          : page.locator('.notification-channel-list .ant-table-row').filter({ hasText: '我的 iPhone' });
        await expect(control).toHaveAttribute('aria-checked', 'true');
        await expect(row).toContainText('已启用');
        const device = width < 1024 ? 'mobile' : 'desktop';
        await row.screenshot({ path: '../docs/skins/previews/' + skin + '-' + mode + '-switch-' + device + '.png', animations: 'disabled' });
        const geometry = await control.evaluate(element => {
          const row = element.closest('.notification-channel-card, .ant-table-row')!;
          const label = row.querySelector('.notification-channel-status > span')!;
          const self = element.getBoundingClientRect(); const text = label.getBoundingClientRect();
          return { height: self.height, width: self.width, center: Math.abs(self.y + self.height / 2 - text.y - text.height / 2) };
        });
        expect(geometry.height).toBeGreaterThanOrEqual(44); expect(geometry.width).toBeGreaterThanOrEqual(44);
        expect(geometry.center).toBeLessThan(2);
        await control.click(); await expect(control).toHaveAttribute('aria-checked', 'false'); await expect(row).toContainText('已停用');
        await row.screenshot({ path: '../docs/skins/previews/' + skin + '-' + mode + '-switch-off-' + device + '.png', animations: 'disabled' });
        await control.focus(); await control.press('Space');
        await expect(control).toHaveAttribute('aria-checked', 'true'); await expect(row).toContainText('已启用');
      } finally { await context.close(); }
    }
  });
}
