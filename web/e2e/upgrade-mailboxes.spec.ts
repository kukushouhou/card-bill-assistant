import { expect, test } from '@playwright/test';
import type { UpgradePlan, UpgradeTask } from '../src/api/types';

for (const skinId of ['modern', 'warm-ledger']) for (const mobile of [false, true]) {
  test(`迁移内多邮箱设置 ${skinId} ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }, testInfo) => {
    await request.post('/__fixture', { data: { installed: true, authed: true, reset: true, upgrade: null } });
    const skins = await (await request.get('/api/skins/builtins')).json();
    await page.route('**/api/skins/active', route => route.fulfill({ json: skins.find((skin: { manifest: { id: string } }) => skin.manifest.id === skinId) }));
    await page.addInitScript(() => localStorage.setItem('appearance.mode', 'light'));
    await page.setViewportSize({ width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const task: UpgradeTask = { key: 'statement-parser-repair-050-v1', title: '修复账单金额错误与明细遗漏', mode: 'optional', targetVersion: '0.5.0',
      order: 10, description: '修正错误金额并补齐交易明细，保留手动还款。', executeLabel: '确认修复', ignoreLabel: '忽略更新',
      status: 'failed', total: 8, processed: 8, succeeded: 4, unchanged: 0, failed: 4, error: '邮箱无法读取，请重新设置邮箱后继续' };
    let current: UpgradePlan | null = { id: 8, fromVersion: '0.4.2', toVersion: '0.5.1', status: 'failed', hasRequired: false,
      runtimeMode: 'failed', error: task.error, tasks: [task], migrations: [{ ...task, summary: '农业银行 · 8 封邮件' }],
      mailboxFailures: [1, 2].map(id => ({ id, email: `mail${id}@example.test`, imapHost: 'imap.qq.com', imapPort: 993, tls: true, authUser: `mail${id}@example.test` })) };
    let saves = 0;
    let decisions = 0;
    await page.route('**/api/upgrades', route => route.fulfill({ json: current }));
    await page.route('**/api/email/accounts/configurations', route => {
      saves++;
      const body = route.request().postDataJSON();
      expect(body.accounts.map((account: { id: number }) => account.id)).toEqual([1, 2]);
      return route.fulfill(saves === 1 ? { status: 400, json: { error: 'mail2@example.test 无法连接，请检查授权码' } } : { json: { ok: true } });
    });
    await page.route('**/api/upgrades/decisions', route => { decisions++; current = null; return route.fulfill({ json: null }); });
    await page.route('**/api/upgrades/latest-result', route => route.fulfill({ json: null }));
    await page.goto('/bills');
    await expect(page.locator('html')).toHaveAttribute('data-skin', `${skinId}@1.0.0`);
    const settings = page.getByRole('dialog', { name: '邮箱设置', exact: true });
    await expect(settings).toBeVisible();
    for (const id of [1, 2]) {
      const account = settings.getByRole('region', { name: `mail${id}@example.test` });
      await account.getByLabel('授权码（留空则不修改）', { exact: true }).fill(`synthetic-code-${id}`);
    }
    await settings.getByRole('button', { name: '完成设置' }).click();
    await expect(settings).toContainText('mail2@example.test 无法连接');
    expect(decisions).toBe(0);
    await expect(settings.getByRole('region', { name: 'mail1@example.test' }).getByLabel('授权码（留空则不修改）', { exact: true })).toHaveValue('synthetic-code-1');
    await settings.locator('.ant-modal-title').click();
    await settings.locator('.ant-modal-body').evaluate(element => { element.scrollTop = 0; });
    const action = await settings.getByRole('button', { name: '完成设置' }).boundingBox();
    expect(action!.y + action!.height).toBeLessThanOrEqual(mobile ? 844 : 1000);
    expect(await settings.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('mailbox-settings.png'), animations: 'disabled' });
    await settings.getByRole('button', { name: '完成设置' }).click();
    const migration = page.getByRole('dialog').filter({ has: page.getByText('修复账单金额错误与明细遗漏', { exact: true }) });
    await expect(migration).toBeVisible();
    expect(decisions).toBe(0);
    await expect(migration).not.toContainText('已暂停');
    await migration.locator('.ant-modal-title').click();
    const configureButton = await migration.getByRole('button', { name: '设置邮箱', exact: true }).boundingBox();
    const retryButton = await migration.getByRole('button', { name: /^重\s*试$/ }).boundingBox();
    expect(Math.abs(configureButton!.y - retryButton!.y)).toBeLessThan(2);
    if (mobile) {
      expect(Math.abs(configureButton!.width - retryButton!.width)).toBeLessThan(2);
      expect(configureButton!.x).toBeLessThan(retryButton!.x);
      expect(retryButton!.x + retryButton!.width).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: testInfo.outputPath('back-to-migration.png'), animations: 'disabled' });
    await migration.getByRole('button', { name: /^重\s*试$/ }).click();
    await expect(migration).not.toBeVisible();
    expect(decisions).toBe(1);
    await expect(page.getByText('查看并重试', { exact: true })).toHaveCount(0);
  });
}
