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
const icbc = task('icbc-foreign-amount-repair-080-v1', '修正工行外币账单', 'optional', { targetVersion: '0.8.0', total: 25,
  description: '旧版本可能漏读工行账单的外币应还金额和最低还款额，并把零金额账单标为已还。\n金额修正：重新读取现有外币账单对应的全部历史来源邮件，修正受影响账单，纠正统计；不补建已不存在的账单。\n恢复待还与提醒：仅处理从首次执行日往前一个月起、按还款日筛选且符合自动误结清特征的账单。更早历史账单只修金额，保留还款状态。',
  ignoreWarning: '忽略后，尚未修正的历史外币金额会继续影响统计，近期错误的已还状态也会保留；后续新邮件按修复后的规则处理。系统将不再提供本次迁移服务。' });
const summaries: Record<string, string> = {
  'preview-required': '工商银行、平安银行 · 共 8 条还款记录',
  'preview-mail': '工商银行、平安银行 · 共 26 封已识别的历史账单邮件',
  'preview-bill': '平安银行、招商银行 · 共 3 张卡的本期账单',
  [icbc.key]: '全部历史需复核：工商银行 25 笔外币账单／25 封邮件。\n近一个月候选恢复待还：1 笔（按 2026-10-26 执行，还款日从 2026-09-26 起）。\n以上是候选数量，实际修正和恢复以原文复核结果为准。',
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
  { id: 'icbc', title: '工行全历史金额与近月恢复', plan: { ...makePlan([icbc]), fromVersion: '0.7.0', toVersion: '0.8.0' } },
  { id: 'icbc-ignore', title: '工行忽略后果', plan: { ...makePlan([icbc]), fromVersion: '0.7.0', toVersion: '0.8.0' }, ignore: icbc.key },
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
    if (scenario.plan.hasRequired && scenario.plan.status !== 'failed') await expect(dialog.getByText('编辑、邮件同步和日常提醒已暂停，完成更新后恢复。')).toBeVisible();
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

for (const device of ['desktop', 'mobile'] as const) for (const state of ['normal', 'unavailable', 'uncertain', 'preserved'] as const) {
  test(`工行真实结果组件 ${state} / ${device}`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: device === 'mobile' ? 390 : 1440, height: device === 'mobile' ? 844 : 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await request.post('/__fixture', { data: { reset: true } });
    let current: UpgradePlan | null = { ...makePlan([icbc]), fromVersion: '0.7.0', toVersion: '0.8.0' };
    await page.route('**/api/upgrades', route => route.fulfill({ json: current }));
    await page.route('**/api/upgrades/decisions', route => { current = null; return route.fulfill({ json: null }); });
    await page.route('**/api/upgrades/latest-result', route => route.fulfill({ json: { kind: 'icbc-foreign', version: '0.8.0',
      finishedAt: '2026-10-26', lowerBound: '2026-09-26', banks: [{ bankName: '工商银行', billCount: 25, mailCount: 25 }],
      counts: { correctedBills: 12, addedBills: 0, addedTransactions: 0, correctedTransactions: 0, removedTransactions: 0,
        restoredRepayments: 1, fallbackMinimumBills: 0, unavailableMails: state === 'preserved' ? 12 : state === 'unavailable' ? 2 : 0,
        uncertainRepayments: state === 'uncertain' ? 3 : 0 }, incomplete: state === 'preserved'
          ? Array.from({ length: 12 }, () => ({ bankName: '工商银行', billCount: 1, reason: '原文不能唯一对应现有外币账单，保留原状' }))
          : state === 'unavailable' ? [{ bankName: '工商银行', billCount: 2, reason: '原文缺失' }] : [] } }));
    await page.goto('/bills');
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.upgrade-item-scope')).toContainText('全部历史需复核：工商银行 25 笔');
    await expect(dialog.locator('.upgrade-item-scope')).toContainText('近一个月候选恢复待还：1 笔');
    await expect(dialog.locator('.upgrade-item-scope')).toContainText('2026-09-26');
    await expect(dialog.getByRole('radio', { name: '执行' })).toBeChecked();
    await dialog.getByRole('button', { name: '确认并继续' }).click();
    const result = page.getByRole('dialog', { name: '系统升级结果' });
    await expect(result.getByText('修正账单 12 笔')).toBeVisible();
    await expect(result.getByText('恢复待还 1 笔')).toBeVisible();
    if (state === 'unavailable') await expect(result.getByText('2 封邮件的账单未修正')).toBeVisible();
    if (state === 'uncertain') await expect(result.getByText('3 笔账单金额已修正，还款状态未变')).toBeVisible();
    if (state === 'preserved') {
      await expect(result.getByText('12 封邮件的账单未修正')).toBeVisible();
      await expect(result.getByRole('alert')).toContainText('未修正数量不代表仍有错误账单');
      await expect(result.getByRole('alert')).not.toContainText('无法完整读取');
      await expect(result.getByRole('alert')).not.toContainText('零余额');
    }
    if (state === 'normal') await expect(result.getByRole('alert')).toHaveCount(0);
    expect(await result.evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false);
    const filename = `icbc-result-${state}-${device}.png`;
    await page.screenshot({ path: process.env.UPGRADE_REVIEW_DIR ? path.join(process.env.UPGRADE_REVIEW_DIR, filename) : testInfo.outputPath(filename), animations: 'disabled' });
    const done = result.getByRole('button', { name: '完成' });
    const box = (await done.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(device === 'mobile' ? 844 : 1000);
    await done.click(); await expect(result).not.toBeVisible();
  });
}
