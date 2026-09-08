import { expect, test } from '@playwright/test';
import type { UpgradePlan, UpgradeTask } from '../src/api/types';

for (const skinId of ['modern', 'warm-ledger']) for (const mobile of [false, true]) {
  test(`账单修复提示与结果 ${skinId} ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }, testInfo) => {
    await request.post('/__fixture', { data: { installed: true, authed: true, reset: true, upgrade: null } });
    const skins = await (await request.get('/api/skins/builtins')).json();
    await page.route('**/api/skins/active', (route) => route.fulfill({ json: skins.find((skin: { manifest: { id: string } }) => skin.manifest.id === skinId) }));
    await page.addInitScript(() => localStorage.setItem('appearance.mode', 'light'));
    await page.setViewportSize({ width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const task: UpgradeTask = { key: 'statement-parser-repair-050-v1', title: '历史账单核对与修复', mode: 'required', targetVersion: '0.5.0', order: 10,
      description: '核对已有账单的金额、币种及明细，保留手动还款。自动结清状态仅从本次执行日期往前一个月起恢复，包含未来账单。',
      executeLabel: '确认修复', ignoreLabel: null, status: 'awaiting_decision', total: 2, processed: 0, succeeded: 0, unchanged: 0, failed: 0, error: null };
    let current: UpgradePlan | null = { id: 8, fromVersion: '0.4.2', toVersion: '0.5.0', status: 'awaiting_decision', hasRequired: true,
      runtimeMode: 'required_wait', error: null, tasks: [task], migrations: [{ ...task,
        summary: '需要复核：农业银行 2 笔现有账单（1 封邮件）；建设银行 1 笔现有账单（1 封邮件）。' }] };
    await page.route('**/api/upgrades', (route) => route.fulfill({ json: current }));
    await page.route('**/api/upgrades/decisions', (route) => { current = null; return route.fulfill({ json: null }); });
    await page.route('**/api/upgrades/latest-result', (route) => route.fulfill({ json: { version: '0.5.0', counts: {
      correctedBills: 2, addedBills: 1, addedTransactions: 3, correctedTransactions: 0, removedTransactions: 0,
      restoredRepayments: 1, fallbackMinimumBills: 1, unavailableMails: 1,
    }, incomplete: [{ bankName: '中信银行', billCount: 1 }] } }));
    await page.goto('/bills');
    await expect(page.locator('html')).toHaveAttribute('data-skin', `${skinId}@1.0.0`);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('需要复核：农业银行 2 笔现有账单');
    await expect(dialog).not.toContainText('中信银行');
    await expect(dialog.getByRole('radio')).toHaveCount(0);
    await dialog.locator('.ant-modal-title').click();
    await page.screenshot({ path: testInfo.outputPath('repair-gate.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '确认并继续' }).click();
    await expect(page.getByText('系统升级结果', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('修正账单 2 笔');
    await expect(dialog).toContainText('补建账单 1 笔');
    await expect(dialog).toContainText('1 封邮件的明细未补齐');
    await dialog.locator('.ant-modal-title').click();
    const action = await dialog.getByRole('button', { name: /^完\s*成$/ }).boundingBox();
    expect(action!.y + action!.height).toBeLessThanOrEqual(mobile ? 844 : 1000);
    expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('repair-result.png'), animations: 'disabled' });
  });
}
