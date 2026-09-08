import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { UpgradeMigrationSummary, UpgradePlan, UpgradeTask } from '../src/api/types';

// 全部为验收数据，必选示例不注册到正式迁移表，也不调用真实升级执行器。
function task(key: string, title: string, mode: UpgradeTask['mode'], extra: Partial<UpgradeTask> = {}): UpgradeTask {
  return { key, title, mode, targetVersion: '0.3.1', order: 10, description: '', executeLabel: '现在执行',
    ignoreLabel: mode === 'optional' ? '忽略' : null, status: 'awaiting_decision', total: 8, processed: 0,
    succeeded: 0, unchanged: 0, failed: 0, error: null, ...extra };
}
const required = task('preview-required', '修正还款记录', 'required', {
  order: 1, description: '将核对已有账单和还款记录，修正已还账单仍显示待还的问题。还款金额保持不变，无需重读邮件。',
});
const mail = task('preview-mail', '更新历史账单的卡片关系', 'optional', {
  total: 26, description: '旧版未完整识别这些账单中的主卡、副卡、附属卡和手机信用卡。将从已绑定邮箱重新读取上述邮件，更新卡片关系，减少重复账单和还款提醒。',
  ignoreWarning: '忽略后，未处理的历史账单会保留原有卡片关系；新账单仍会正常识别。系统将不再提供本次迁移服务。',
});
const bill = task('preview-bill', '修正本期账单状态', 'optional', {
  total: 3, targetVersion: '0.4.1', description: '根据已收到的本期账单，将误显示的「未取得账单」改为「无需还款」，并校正相关卡片的出账日和还款日。无需重读邮件，历史账单不变。',
  ignoreWarning: '忽略后，本期仍可能显示「未取得账单」并产生多余提醒；收到下期账单后会正常处理。系统将不再提供本次迁移服务。',
});
const silent: UpgradeMigrationSummary = { key: 'preview-silent', targetVersion: '0.3.2', order: 10, mode: 'silent',
  title: '隐藏重复显示的无卡号卡片', description: '已有对应真实卡时，隐藏无卡号卡片，保留历史账单。',
  total: 2, summary: '平安银行、北京银行 · 共 2 张无卡号卡片' };
const summaries: Record<string, string> = {
  'preview-required': '工商银行、平安银行 · 共 8 条还款记录',
  'preview-mail': '工商银行、平安银行 · 共 26 封已识别的历史账单邮件',
  'preview-bill': '平安银行、招商银行 · 共 3 张卡的本期账单',
};
function makePlan(tasks: UpgradeTask[], options: { status?: UpgradePlan['status']; silent?: boolean } = {}): UpgradePlan {
  const hasRequired = tasks.some(item => item.mode === 'required');
  const status = options.status ?? 'awaiting_decision';
  const migrations: UpgradeMigrationSummary[] = tasks.map(item => ({ ...item, summary: summaries[item.key] }));
  if (options.silent) migrations.push(silent);
  migrations.sort((a, b) => a.targetVersion.localeCompare(b.targetVersion) || a.order - b.order);
  return { id: 8, fromVersion: '0.3.0', toVersion: '0.4.2', status, hasRequired, tasks, migrations,
    runtimeMode: status === 'executing' ? 'executing' : status === 'failed' ? 'failed' : hasRequired ? 'required_wait' : 'optional_wait',
    error: status === 'failed' ? tasks.find(item => item.error)?.error ?? null : null };
}
const scenarios = [
  { id: 'optional', title: '可选更新', plan: makePlan([mail, bill]) },
  { id: 'ignore', title: '忽略后果', plan: makePlan([mail, bill]), ignore: mail.key },
  { id: 'ignore-bill', title: '忽略本期修正', plan: makePlan([mail, bill]), ignore: bill.key },
  { id: 'required', title: '必选更新', plan: makePlan([required]) },
  { id: 'mixed', title: '混合计划不展示静默项目', plan: makePlan([required, mail, bill], { silent: true }) },
  { id: 'required-failed', title: '必选更新失败', plan: makePlan([{ ...required, status: 'failed', processed: 3, succeeded: 3, failed: 5, error: '部分还款记录未能更新，请重试。' }], { status: 'failed' }) },
  { id: 'optional-failed', title: '邮箱连接中断后忽略', plan: makePlan([{ ...mail, status: 'failed', processed: 26, succeeded: 10, failed: 16, error: '邮箱连接中断，剩余 16 封邮件尚未处理，请重试。' }], { status: 'failed' }), ignore: mail.key },
  { id: 'executing', title: '正在更新', plan: makePlan([{ ...required, status: 'running', processed: 3, succeeded: 3 }, { ...mail, status: 'approved' }, { ...bill, status: 'approved' }], { status: 'executing', silent: true }) },
];

for (const device of ['desktop', 'mobile'] as const) for (const scenario of scenarios) {
  test(`升级提示 ${scenario.title} / ${device}`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: device === 'mobile' ? 390 : 1440, height: device === 'mobile' ? 844 : 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const skins = await (await request.get('/api/skins/builtins')).json();
    const skin = skins.find((item: { manifest: { id: string } }) => item.manifest.id === 'warm-ledger');
    await page.route('**/api/skins/active', route => route.fulfill({ json: skin }));
    await page.addInitScript(() => localStorage.setItem('appearance.mode', 'light'));
    let current: UpgradePlan | null = structuredClone(scenario.plan);
    const posts: Array<{ planId: number; decisions: Array<{ key: string; action: string }> }> = [];
    await page.route('**/api/upgrades', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(current) }));
    await page.route('**/api/upgrades/decisions', route => {
      posts.push(route.request().postDataJSON()); current = null;
      return route.fulfill({ contentType: 'application/json', body: 'null' });
    });
    await page.goto('/bills');
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'warm-ledger@1.0.0');
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.upgrade-item')).toHaveCount(scenario.plan.migrations.filter(item => item.mode !== 'silent').length);
    await expect(dialog.getByText(silent.title, { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('自动更新', { exact: true })).toHaveCount(0);
    if (scenario.plan.hasRequired) await expect(dialog.getByText('编辑、邮件同步和提醒推送已暂停，完成更新后恢复。')).toBeVisible();
    const requiredRow = dialog.getByRole('listitem').filter({ has: page.getByText(required.title, { exact: true }) });
    if (scenario.plan.hasRequired && scenario.plan.status !== 'executing') {
      await expect(requiredRow.getByText('必须更新', { exact: true })).toBeVisible();
      await expect(requiredRow.getByRole('radio')).toHaveCount(0);
    }
    const optionalPending = scenario.plan.tasks.filter(item => item.mode === 'optional' && ['awaiting_decision', 'failed'].includes(item.status));
    await expect(dialog.getByRole('radio')).toHaveCount(scenario.plan.status === 'executing' ? 0 : optionalPending.length * 2);
    for (const item of optionalPending) {
      const choice = dialog.getByLabel(item.title);
      await expect(choice.getByRole('radio', { name: '执行' })).toBeChecked();
      expect((await choice.getByText('忽略', { exact: true }).boundingBox())!.x).toBeLessThan((await choice.getByText('执行', { exact: true }).boundingBox())!.x);
    }
    if (scenario.ignore) {
      const item = scenario.plan.tasks.find(candidate => candidate.key === scenario.ignore)!;
      await dialog.getByLabel(item.title).getByText('忽略', { exact: true }).click();
      await expect(dialog.locator('.upgrade-ignore-warning')).toContainText(item.ignoreWarning!);
      await expect(dialog.locator('.upgrade-ignore-warning')).not.toContainText('本次更新');
      expect(await dialog.locator('.upgrade-ignore-warning').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    }
    expect(posts).toHaveLength(0);
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    await dialog.locator('.ant-modal-title').click();
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const action = dialog.getByRole('button');
    await expect(action).toHaveCount(scenario.plan.status === 'executing' ? 0 : 1);
    if (scenario.plan.status !== 'executing') {
      const rect = (await action.boundingBox())!;
      expect(rect.y + rect.height).toBeLessThanOrEqual(device === 'mobile' ? 844 : 1000);
    }
    expect(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false);
    if (device === 'desktop') {
      const first = dialog.getByRole('listitem').first();
      const title = (await first.locator('.upgrade-item-title').boundingBox())!;
      const controls = (await first.locator('.upgrade-item-action').boundingBox())!;
      expect(Math.abs(title.y + title.height / 2 - controls.y - controls.height / 2)).toBeLessThan(2);
    }
    await dialog.locator('.ant-modal-body').evaluate(el => { el.scrollTop = 0; });
    const filename = `${scenario.id}-${device}.png`;
    const output = process.env.UPGRADE_REVIEW_DIR ? path.join(process.env.UPGRADE_REVIEW_DIR, filename) : testInfo.outputPath(filename);
    if (device === 'desktop') await dialog.screenshot({ path: output, animations: 'disabled' });
    else await page.screenshot({ path: output, animations: 'disabled' });
    if (scenario.plan.status !== 'executing') {
      if (scenario.id === 'required-failed') await expect(action).toHaveText(/重\s*试/);
      await action.click(); await expect(dialog).not.toBeVisible();
      expect(posts).toEqual([{ planId: 8, decisions: scenario.plan.tasks
        .filter(item => ['awaiting_decision', 'failed'].includes(item.status))
        .map(item => ({ key: item.key, action: item.key === scenario.ignore ? 'ignore' : 'approve' })) }]);
    }
  });
}
