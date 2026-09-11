import path from 'node:path';
import { test, expect } from '@playwright/test';

for (const skinId of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) for (const mobile of [false, true]) {
  test(`关于与版本 ${skinId} ${mode} ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }, testInfo) => {
    await request.post('/__fixture', { data: { installed: true, authed: true, reset: true, upgrade: null } });
    const { version } = await (await request.get('/api/app')).json();
    const skins = await (await request.get('/api/skins/builtins')).json();
    const skin = skins.find((item: { manifest: { id: string } }) => item.manifest.id === skinId);
    await page.route('**/api/skins/active', (route) => route.fulfill({ json: skin }));
    await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
    const resultReads: string[] = [];
    page.on('request', request => { if (request.url().includes('/upgrades/latest-result')) resultReads.push(request.url()); });
    await page.setViewportSize({ width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 });
    await page.goto('/settings');
    const about = page.getByRole('region', { name: '关于本系统' });
    await about.scrollIntoViewIfNeeded();
    await expect(about.getByText(`版本 v${version}`, { exact: true })).toBeVisible();
    await expect(about.locator('input')).toHaveCount(0);
    await expect(about.locator('.settings-card')).toBeVisible();
    await expect(about.locator('.settings-about-notes p')).toHaveCount(3);
    await expect(about).toContainText('本系统不会代扣还款，请以银行账单为准。');
    await expect(about).toContainText('卡信息加密保存，PIN 不留存，请妥善保管。');
    await expect(about).toContainText('需要帮助？查看使用文档，或反馈问题。');
    await expect(about).not.toContainText('账单修复结果');
    expect(resultReads).toEqual([]);
    const project = await about.getByRole('link', { name: 'GitHub 项目', exact: true }).boundingBox();
    const update = await about.getByRole('link', { name: '检查更新', exact: true }).boundingBox();
    expect(project!.width).toBe(update!.width);
    if (mobile) {
      expect(project!.y).toBe(update!.y);
      expect(update!.x).toBeGreaterThan(project!.x + project!.width);
    } else {
      expect(project!.x).toBe(update!.x);
      expect(update!.y).toBeGreaterThan(project!.y + project!.height);
    }
    await expect(page.locator('.settings-grid > :last-child')).toHaveClass('settings-about');
    await expect(page.getByRole('link', { name: '检查更新', exact: true })).toHaveAttribute('href', 'https://github.com/kukushouhou/card-bill-assistant/releases');
    if (!mobile) await expect(page.locator('.desktop-app-brand .app-version-suffix')).toHaveText(`v${version}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(overflow).toBe(false);
    await page.screenshot({ path: path.join(testInfo.outputDir, 'version-about.png') });
    if (mobile) {
      await page.getByText('更多', { exact: true }).click();
      await expect(page.locator('.mobile-more-brand .app-version-suffix')).toHaveText(`v${version}`);
    }
  });
}
