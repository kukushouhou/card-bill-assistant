import { test, expect, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
test.use({ actionTimeout: 8_000 });

async function checkFields(container: Locator) {
  const fields = await container.locator('.info-field').evaluateAll(elements => elements.map(element => {
    const label = element.querySelector('dt')!; const value = element.querySelector('dd')!;
    const bounds = element.getBoundingClientRect(); const a = label.getBoundingClientRect(); const b = value.getBoundingClientRect();
    const baseline = (node: Element) => {
      const marker = document.createElement('span'); Object.assign(marker.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
      node.append(marker); const y = marker.getBoundingClientRect().y; marker.remove(); return y;
    };
    return { right: bounds.right, valueRight: b.right, sameRow: b.x >= a.right, gap: b.x - a.right, verticalGap: b.y - a.bottom, baseline: Math.abs(baseline(label) - baseline(value)) };
  }));
  for (const field of fields) {
    expect(field.valueRight).toBeLessThanOrEqual(field.right + 1);
    if (field.sameRow) { expect(field.gap).toBeGreaterThanOrEqual(7); expect(field.baseline).toBeLessThan(1); }
    else expect(field.verticalGap).toBeGreaterThanOrEqual(7);
  }
}

for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) {
  test('全站字段分组和对齐 ' + skin + ' ' + mode, async ({ page, request }) => {
    test.setTimeout(100_000);
    await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
    for (const width of [1440, 390, 360]) {
      await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
      await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
      await page.setViewportSize({ width, height: 1000 });
      const dir = '../.ui-fixture/field-audit/' + skin + '-' + mode + '-' + width; await fs.mkdir(dir, { recursive: true });
      const capture = async (name: string, locator: Locator) => {
        await page.evaluate(() => document.fonts.ready);
        await locator.screenshot({ path: dir + '/' + name + '.png', animations: 'disabled' });
        await checkFields(locator);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      };

      // 多币种始终各占完整一项，不能靠拼接或截断压缩信息。
      await page.route('**/api/dashboard/summary', async route => {
        const response = await route.fetch(); const data = await response.json();
        data.currentPeriod.totalsByCurrency.push({ currency: 'USD', unpaidCount: 1, unpaidTotal: 12345678.9, annualFeeTotal: 0 });
        await route.fulfill({ json: data });
      });
      await page.goto('/'); await expect(page.locator('.dashboard-currency-value')).toHaveCount(2);
      const money = await page.locator('.dashboard-currency-value').evaluateAll(elements => elements.map(element => ({ width: element.clientWidth, content: element.scrollWidth })));
      for (const value of money) expect(value.content).toBeLessThanOrEqual(value.width + 1);
      await capture('home', page.locator('.page')); await page.unroute('**/api/dashboard/summary');

      await page.goto('/transactions?billId=101'); await expect(page.locator('.transaction-context')).toContainText('0988');
      await capture('transaction-context', page.locator('.transaction-context'));
      if (width < 1024) await capture('transaction', page.locator('.transaction-mobile-card').first());

      await page.goto('/parsers'); await expect(page.getByLabel('最近封数')).toBeVisible();
      await capture('parser-form', page.locator('.parser-run-form'));
      const labels = await page.locator('.parser-run-form > .ant-form-item:has(.ant-form-item-label)').evaluateAll(elements => elements.map(element => ({ left: element.getBoundingClientRect().x, top: element.getBoundingClientRect().y, inputTop: element.querySelector('.ant-form-item-control')!.getBoundingClientRect().y })));
      if (width >= 1024) expect(Math.max(...labels.map(item => item.inputTop)) - Math.min(...labels.map(item => item.inputTop))).toBeLessThan(1);
      else expect(Math.abs(labels[2].inputTop - labels[3].inputTop)).toBeLessThan(1);
      await page.getByRole('button', { name: /开始试解析/ }).click();
      await expect(page.locator('.parser-bill-summary').first()).toBeVisible();
      await capture('parser-result', page.locator('.parser-bill-summary').first());

      await page.goto('/settings'); await expect(page.locator('.settings-channel-section')).toBeAttached();
      await capture('notifications', page.locator('.settings-grid-notifications'));
      const sections = await page.locator('.settings-notification-form > section').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      if (width >= 1024) expect(Math.abs(sections[0].y - sections[1].y)).toBeLessThan(1);
      else expect(sections[1].y - sections[0].bottom).toBeGreaterThanOrEqual(15);
      await capture('pin-settings', page.locator('.settings-grid-pin'));

      await page.goto('/cards'); await page.locator('.bank-card').first().locator('.bank-card-settings').click();
      if (width < 1024) await page.locator('.cards-mobile-action-list').getByRole('button', { name: /编辑/ }).click();
      else await page.getByRole('menuitem', { name: '编辑', exact: false }).click();
      await capture('card-editor', page.locator('.cards-edit-sections'));

      await page.goto('/bills');
      if (width < 1024) await page.locator('.agenda-mobile-row').filter({ hasText: '卡尾 0988' }).filter({ hasNotText: '/' }).getByRole('button', { name: '还款', exact: true }).click();
      else await page.getByRole('row').filter({ hasText: '卡尾 0988' }).filter({ hasNotText: '/' }).getByRole('button', { name: '还款', exact: true }).click();
      await capture('payment', width < 1024 ? page.locator('.mobile-payment-flow') : page.locator('.payment-modal'));

      await page.goto('/email'); await page.getByRole('button', { name: /拉取历史/ }).click();
      await page.getByRole('button', { name: width < 1024 ? '开始历史拉取' : '确定', exact: true }).click();
      await expect(page.locator('.email-history-progress')).toContainText('33.3%');
      await capture('history-progress', page.locator('.email-history-progress'));
    }
  });
}
