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
    const task: UpgradeTask = { key: 'statement-parser-repair-050-v1', title: '修复账单金额错误与明细遗漏', mode: 'optional', targetVersion: '0.5.0', order: 10,
      description: '旧版解析器会误读部分账单的应还金额和最低还款额，包括把应还金额读成负数；还会漏掉部分账单和交易明细。这可能让应还账单显示为“已还清”，造成待还金额和还款提醒不准确。\n\n本次升级会修正错误金额，补齐遗漏的账单和明细。误标为已还清的账单，从修复当天往前一个月起按还款日恢复待还；手动还款记录保留。',
      executeLabel: '确认修复', ignoreLabel: '忽略更新', status: 'awaiting_decision', total: 2, processed: 0, succeeded: 0, unchanged: 0, failed: 0, error: null };
    let current: UpgradePlan | null = { id: 8, fromVersion: '0.4.2', toVersion: '0.5.1', status: 'awaiting_decision', hasRequired: false,
      runtimeMode: 'optional_wait', error: null, tasks: [task], migrations: [{ ...task,
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
    await expect(dialog).toContainText('包括把应还金额读成负数');
    await expect(dialog).not.toContainText('包含未来');
    const description = await dialog.locator('.upgrade-item-description').boundingBox();
    const scope = await dialog.locator('.upgrade-item-scope').boundingBox();
    expect(description!.y + description!.height).toBeLessThanOrEqual(scope!.y);
    await expect(dialog).not.toContainText('中信银行');
    await expect(dialog.getByRole('radio')).toHaveCount(2);
    await expect(dialog).not.toContainText('已暂停');
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
