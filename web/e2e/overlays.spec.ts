import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) for (const width of [1440, 390]) {
  test('业务流程与升级外观 ' + skin + ' ' + mode + ' ' + width, async ({ page, request }) => {
    await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
    await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
    await page.setViewportSize({ width, height: 900 }); await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
    const directory = '../.ui-fixture/screenshots/' + skin + '-' + mode + '-' + width; await fs.mkdir(directory, { recursive: true });
    await page.goto('/bills'); await page.getByRole('button', { name: '还款', exact: true }).first().click();
    const payment = width < 1024 ? page.locator('.mobile-payment-flow') : page.getByRole('dialog');
    await expect(payment).toBeVisible(); await page.screenshot({ path: directory + '/payment.png', fullPage: true, animations: 'disabled' });
    if (width < 1024) await page.locator('.mobile-nav-back-button').click(); else await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '提醒设置', exact: false }).click();
    await page.getByRole('button', { name: '新增提醒', exact: false }).click();
    await expect(page.locator('.custom-reminder-form')).toBeVisible(); await page.screenshot({ path: directory + '/reminder-editor.png', fullPage: true, animations: 'disabled' });
    await page.goto('/cards'); await page.locator('.bank-card').first().locator('.bank-card-eye').click();
    await expect(page.getByPlaceholder('6 位数字 PIN')).toBeVisible(); await page.screenshot({ path: directory + '/pin.png', fullPage: true, animations: 'disabled' });
    const migration = { key: 'demo-update', title: '更新账单显示', description: '整理历史账单的显示信息，原有还款记录会保留。', mode: 'required', targetVersion: '0.3.2', executeLabel: '确认更新' };
    await request.post('/__fixture', { data: { upgrade: { fromVersion: '0.3.1', toVersion: '0.3.2', status: 'awaiting_decision', hasRequired: true, migrations: [migration], tasks: [{ ...migration, status: 'awaiting_decision', total: 10, processed: 0 }] } } });
    await page.goto('/bills'); const upgrade = page.getByRole('dialog').filter({ hasText: '系统升级' }); await expect(upgrade).toBeVisible();
    await expect(upgrade.getByRole('button', { name: '确认更新', exact: true })).toBeVisible();
    if (width < 1024) await expect.poll(async () => Math.round((await page.locator('.mobile-upgrade-flow').boundingBox())!.width)).toBe(width);
    await page.screenshot({ path: directory + '/upgrade.png', fullPage: true, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('安装选择完整内置皮肤，完成后生效并保留本地明暗', async ({ page, request }) => {
  await request.post('/__fixture', { data: { reset: true, installed: false, authed: false, upgrade: null, failNext: null } });
  await request.put('/api/skins/active', { data: { id: 'modern', version: '1.0.0' } });
  await page.addInitScript(() => localStorage.setItem('appearance.mode', 'dark'));
  await page.goto('/'); await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByLabel('登录密码', { exact: false }).fill('Ui-fixture-only-123'); await page.getByLabel('确认密码', { exact: false }).fill('Ui-fixture-only-123');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByText('温润账本', { exact: true }).click();
  const submitted = page.waitForRequest('**/api/setup/install'); await page.getByRole('button', { name: /完成安装/ }).click();
  expect((await submitted).postDataJSON().skinId).toBe('warm-ledger');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0'); await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
});
