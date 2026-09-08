import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';

async function seed(request: APIRequestContext) {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  for (const [name, key] of [['我的 iPhone', 'first'], ['备用手机', 'second']]) {
    await request.post('/api/settings/notification-channels', { data: { type: 'bark', name, enabled: true, config: { url: 'https://example.test/' + key, group: '家庭提醒', sound: 'minuet' } } });
  }
}
function list(page: Page) { return page.locator('.notification-channel-list'); }
function item(page: Page, name: string, mobile: boolean) {
  return mobile ? list(page).getByRole('article', { name, exact: true }) : list(page).getByRole('row').filter({ hasText: name });
}
function editor(page: Page, mobile: boolean) {
  return mobile ? page.getByRole('region', { name: '编辑通知渠道', exact: true }) : page.getByRole('dialog', { name: '编辑通知渠道', exact: true });
}

for (const width of [1440, 390]) test('同类型实例独立操作、草稿测试与取消 ' + width, async ({ page, request }) => {
  await seed(request); const mobile = width < 1024;
  await page.setViewportSize({ width, height: 1000 }); await page.goto('/settings');
  await item(page, '我的 iPhone', mobile).getByRole('button', { name: '编辑', exact: true }).click();
  const panel = editor(page, mobile);
  await panel.getByLabel('渠道名称', { exact: true }).fill('未保存名称');
  await panel.getByLabel('推送地址', { exact: true }).fill('https://example.test/unsaved');
  await panel.getByText('高级设置', { exact: true }).click();
  await panel.getByLabel('通知铃声', { exact: true }).click();
  await panel.getByLabel('通知铃声', { exact: true }).fill('鸟鸣');
  await page.getByText('鸟鸣 · birdsong', { exact: true }).click();
  await panel.getByRole('button', { name: '测试', exact: true }).click();
  const sends = await (await request.get('/__notification-sends')).json();
  expect(sends.at(-1)).toMatchObject({ name: '未保存名称', config: { url: 'https://example.test/unsaved', sound: 'birdsong' } });
  let settings = await (await request.get('/api/settings')).json();
  expect(settings.notifications.channels[0].name).toBe('我的 iPhone');
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await expect(panel.getByLabel('渠道名称', { exact: true })).toHaveValue('未保存名称');
  await panel.getByText('高级设置', { exact: true }).click();
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel).toHaveCount(0);
  settings = await (await request.get('/api/settings')).json();
  expect(settings.notifications.channels[0]).toMatchObject({ id: 1, name: '未保存名称', config: { sound: 'birdsong' } });
  expect(settings.notifications.channels[1]).toMatchObject({ id: 2, name: '备用手机', config: { url: 'https://example.test/second', sound: 'minuet' } });
  await item(page, '备用手机', mobile).getByRole('switch').click();
  await expect(item(page, '备用手机', mobile).getByRole('switch')).not.toBeChecked();
  await item(page, '备用手机', mobile).getByRole('button', { name: '测试', exact: true }).click();
  settings = await (await request.get('/api/settings')).json();
  expect(settings.notifications.channels[1].enabled).toBe(false);
  await item(page, '备用手机', mobile).getByRole('button', { name: '删除', exact: true }).click();
  if (mobile) await item(page, '备用手机', mobile).locator('.mobile-inline-confirm').getByRole('button', { name: '删除', exact: true }).click();
  else await page.locator('.ant-popconfirm').getByRole('button', { name: '删除', exact: true }).click();
  await expect(item(page, '备用手机', mobile)).toHaveCount(0);
  await expect(item(page, '未保存名称', mobile)).toHaveCount(1);
});

test('新建无需保存即可测试，关闭草稿不创建实例', async ({ page, request }) => {
  await seed(request); await page.goto('/settings');
  await list(page).getByRole('button', { name: '添加渠道', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '添加通知渠道', exact: true });
  await panel.getByLabel('渠道类型', { exact: true }).click();
  await page.locator('.ant-select-item-option').getByText('Bark', { exact: true }).click();
  await expect(panel.getByLabel('渠道名称', { exact: true })).toHaveValue('Bark');
  await panel.getByLabel('推送地址', { exact: true }).fill('https://example.test/new');
  await panel.getByRole('button', { name: '测试', exact: true }).click();
  expect((await (await request.get('/api/settings')).json()).notifications.channels).toHaveLength(2);
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await panel.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect((await (await request.get('/api/settings')).json()).notifications.channels).toHaveLength(2);
});

test('跨桌面手机断点保留草稿，保存失败后可重试', async ({ page, request }) => {
  await seed(request); await page.goto('/settings');
  await item(page, '我的 iPhone', false).getByRole('button', { name: '编辑', exact: true }).click();
  await editor(page, false).getByLabel('渠道名称', { exact: true }).fill('断点草稿');
  await page.setViewportSize({ width: 390, height: 900 });
  const panel = editor(page, true);
  await expect(panel.getByLabel('渠道名称', { exact: true })).toHaveValue('断点草稿');
  await request.post('/__fixture', { data: { failNext: '/api/settings/notification-channels/1' } });
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('请求暂时失败，请重试', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('渠道名称', { exact: true })).toHaveValue('断点草稿');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(item(page, '断点草稿', true)).toBeVisible();
});

test('设置页可连续添加两个 Bark 实例', async ({ page, request }) => {
  await request.post('/__fixture', { data: { reset: true, authed: true, installed: true, upgrade: null, failNext: null } });
  await page.goto('/settings');
  for (const [index, name] of ['我的手机', '备用手机'].entries()) {
    await list(page).getByRole('button', { name: '添加渠道', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '添加通知渠道', exact: true });
    await panel.getByLabel('渠道类型', { exact: true }).click();
    await page.locator('.ant-select-item-option').getByText('Bark', { exact: true }).click();
    await panel.getByLabel('渠道名称', { exact: true }).fill(name);
    await panel.getByLabel('推送地址', { exact: true }).fill('https://example.test/' + index);
    await panel.getByRole('button', { name: '保存', exact: true }).click();
    await expect(item(page, name, false)).toBeVisible();
  }
  const channels = (await (await request.get('/api/settings')).json()).notifications.channels;
  expect(channels.map((channel: { type: string; name: string }) => [channel.type, channel.name])).toEqual([['bark', '我的手机'], ['bark', '备用手机']]);
});

for (const skin of ['modern', 'warm-ledger']) for (const mode of ['light', 'dark']) test('通知界面与全站皮肤及断点一致 ' + skin + ' ' + mode, async ({ page, request }) => {
  test.setTimeout(90000);
  await page.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
  await seed(request); await request.put('/api/skins/active', { data: { id: skin, version: '1.0.0' } });
  const directory = '../.ui-fixture/notification-channels'; await fs.mkdir(directory, { recursive: true });
  for (const width of [360, 390, 768, 1023, 1024, 1440]) {
    const mobile = width < 1024;
    await page.setViewportSize({ width, height: 1000 }); await page.goto('/settings');
    await expect(item(page, '我的 iPhone', mobile)).toBeVisible();
    await expect(list(page).getByText('已配置：')).toHaveCount(0);
    await expect(list(page).getByText('向 iPhone 或 iPad 上的 Bark 应用发送系统通知。')).toHaveCount(0);
    await list(page).screenshot({ path: directory + '/' + skin + '-' + mode + '-' + width + '-list.png', animations: 'disabled' });
    await item(page, '我的 iPhone', mobile).getByRole('button', { name: '编辑', exact: true }).click();
    const panel = editor(page, mobile);
    await panel.screenshot({ path: directory + '/' + skin + '-' + mode + '-' + width + '-editor.png', animations: 'disabled' });
    await panel.getByText('高级设置', { exact: true }).click();
    await expect(panel.getByLabel('通知铃声', { exact: true })).toHaveValue(''); // 选择框搜索输入不伪装成铃声名输入。
    await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
    await expect(panel.getByRole('button', { name: '测试', exact: true })).toBeInViewport();
    const fields = await panel.locator('.notification-basic-fields .ant-form-item').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    if (mobile) expect(fields[1].y).toBeGreaterThan(fields[0].y);
    else expect(Math.abs(fields[0].y - fields[1].y)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (mobile) {
      // 等待展开动画结束再滚动，避免滚轮事件落在内容尚未超出视口的帧。
      await panel.locator('.notification-advanced-collapse').evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
      });
      await panel.hover(); await page.mouse.wheel(0, 650);
      await expect.poll(async () => {
        const input = await panel.getByLabel('通知图标', { exact: true }).boundingBox();
        const footer = await panel.locator('.mobile-flow-footer').boundingBox();
        return Boolean(input && footer && input.y + input.height <= footer.y);
      }).toBe(true);
    }
    await panel.screenshot({ path: directory + '/' + skin + '-' + mode + '-' + width + '-advanced.png', animations: 'disabled' });
  }
});

for (const width of [1440, 390]) test('安装向导保留两份 Bark 配置及高级值直到提交 ' + width, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 1000 });
  await request.post('/__fixture', { data: { reset: true, installed: false, authed: false, upgrade: null } });
  await page.goto('/');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByLabel('登录密码', { exact: true }).fill('Fixture-password-123');
  await page.getByLabel('确认密码', { exact: true }).fill('Fixture-password-123');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  for (const [index, name] of ['我的 iPhone', '备用手机'].entries()) {
    await page.getByRole('button', { name: '添加渠道', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Bark', exact: true }).click();
    const entry = page.locator('.setup-notification-entry').nth(index);
    await entry.getByLabel('渠道名称', { exact: true }).fill(name);
    await entry.getByLabel('推送地址', { exact: true }).fill('https://example.test/device-' + index);
    await entry.getByText('高级设置', { exact: true }).click();
    await entry.getByLabel('推送分组', { exact: true }).fill('分组' + index);
  }
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.getByLabel('渠道名称', { exact: true }).nth(1)).toHaveValue('备用手机');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  const install = page.waitForRequest('**/api/setup/install');
  await page.getByRole('button', { name: '完成安装', exact: true }).click();
  expect((await install).postDataJSON().notifications).toEqual([
    { type: 'bark', name: '我的 iPhone', enabled: true, config: { url: 'https://example.test/device-0', group: '分组0' } },
    { type: 'bark', name: '备用手机', enabled: true, config: { url: 'https://example.test/device-1', group: '分组1' } },
  ]);
});
