import path from 'node:path';
import { test, expect } from '@playwright/test';

for (const skinId of ['modern', 'warm-ledger']) for (const mobile of [false, true]) {
  test(`关于与版本 ${skinId} ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }, testInfo) => {
    await request.post('/__fixture', { data: { installed: true, authed: true, reset: true, upgrade: null } });
    const skins = await (await request.get('/api/skins/builtins')).json();
    const skin = skins.find((item: { manifest: { id: string } }) => item.manifest.id === skinId);
    await page.route('**/api/skins/active', (route) => route.fulfill({ json: skin }));
    await page.addInitScript(() => localStorage.setItem('appearance.mode', 'light'));
    await page.setViewportSize({ width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 });
    await page.goto('/settings');
    const about = page.getByRole('region', { name: '关于本系统' });
    await about.scrollIntoViewIfNeeded();
    await expect(about.getByText('版本 v0.5.0', { exact: true })).toBeVisible();
    await expect(about.locator('input')).toHaveCount(0);
    await expect(page.locator('.settings-grid > :last-child')).toHaveClass('settings-about');
    await expect(page.getByRole('link', { name: '检查更新', exact: true })).toHaveAttribute('href', 'https://github.com/kukushouhou/card-bill-assistant/releases');
    if (!mobile) await expect(page.locator('.desktop-app-brand .app-version-suffix')).toHaveText('v0.5.0');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(overflow).toBe(false);
    await page.screenshot({ path: path.join(testInfo.outputDir, 'version-about.png') });
    if (mobile) {
      await page.getByText('更多', { exact: true }).click();
      await expect(page.locator('.mobile-more-brand .app-version-suffix')).toHaveText('v0.5.0');
    }
  });
}
