import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) for (const width of [1440, 390]) {
  test('全站外观 ' + skin + ' ' + mode + ' ' + width, async ({ page, request }) => {
    test.setTimeout(90_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
    await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    await page.setViewportSize({ width, height: width < 1024 ? 844 : 1000 });
    await page.addInitScript(mode => localStorage.setItem('appearance.mode', mode), mode);
    const directory = '../.ui-fixture/screenshots/' + skin + '-' + mode + '-' + width;
    await fs.mkdir(directory, { recursive: true });
    for (const route of ['/', '/cards', '/bills', '/transactions', '/email', '/parsers', '/settings']) {
      await page.goto(route);
      await expect(page.locator('.page').first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin + '@1.0.0');
      await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
      await expect(page.getByText('页面暂时无法加载', { exact: true })).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: directory + '/' + (route.slice(1) || 'home') + '.png', fullPage: true, animations: 'disabled' });
      if (route === '/settings' && width < 1024) {
        await page.locator('.settings-grid-notifications').scrollIntoViewIfNeeded();
        await page.screenshot({ path: directory + '/settings-notifications.png', fullPage: true, animations: 'disabled' });
      }
    }
    await request.post('/__fixture', { data: { authed: false } });
    await page.goto('/login'); await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
    await page.screenshot({ path: directory + '/login.png', fullPage: true });
    await request.post('/__fixture', { data: { installed: false } });
    await page.goto('/'); await page.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(page.getByLabel('登录密码', { exact: false })).toBeVisible();
    await page.screenshot({ path: directory + '/setup-account.png', fullPage: true });
    expect(errors).toEqual([]);
  });
}

for (const width of [360, 768, 1023, 1024]) {
  test('边界宽度 ' + width, async ({ page, request }) => {
    await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null } });
    await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['/bills', '/cards', '/settings']) {
      await page.goto(route); await expect(page.locator('.page').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (width < 1024 && route === '/bills') {
        const label = page.getByText('今日应提醒', { exact: true });
        expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const pay = page.locator('.agenda-mobile-row').first().getByRole('button', { name: '还款', exact: true });
        expect((await pay.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: '../.ui-fixture/screenshots/boundary-' + width + '-' + route.slice(1) + '.png', fullPage: true });
    }
  });
}
