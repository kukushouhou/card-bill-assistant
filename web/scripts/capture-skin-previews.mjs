// 预览来自实际账单页面；先检查文字基线和列对齐，再生成随皮肤包分发的图片。
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseURL = 'http://127.0.0.1:4173';
const captures = [];
const audit = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function checkAlignment(page, mobile) {
  const result = await page.evaluate(() => {
    const baseline = node => {
      const marker = document.createElement('span');
      Object.assign(marker.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
      node.append(marker); const y = marker.getBoundingClientRect().y; marker.remove(); return y;
    };
    const amounts = [...document.querySelectorAll('.agenda-summary-value')].map(element => {
      const number = element.querySelector('.agenda-summary-number');
      const unit = element.querySelector('.agenda-summary-unit');
      const range = document.createRange(); range.selectNodeContents(number);
      return { font: getComputedStyle(number).fontFamily, numeric: getComputedStyle(number).fontVariantNumeric,
        baselineGap: unit ? Math.abs(baseline(number) - baseline(unit)) : 0,
        lines: range.getClientRects().length, contained: range.getBoundingClientRect().right <= element.getBoundingClientRect().right + .5 };
    });
    const notices = [...document.querySelectorAll('.agenda-summary-notes li')].map(element => {
      const values = ['.agenda-summary-notice-label', '.agenda-summary-notice-count strong', '.agenda-summary-notice-count > span'].map(selector => baseline(element.querySelector(selector)));
      return Math.max(...values) - Math.min(...values);
    });
    const rows = [...document.querySelectorAll('.agenda-table .ant-table-row')].slice(0, 3);
    const columns = ['.agenda-identity strong', '.agenda-period', '.agenda-record-actions button'].map(selector => rows.map(row => row.querySelector(selector)?.getBoundingClientRect().x).filter(value => value != null));
    return { amounts, notices, columns };
  });
  assert(result.amounts.length > 0, '预览缺少金额');
  for (const amount of result.amounts) {
    assert(amount.numeric.includes('lining-nums') && amount.numeric.includes('tabular-nums'), '金额必须使用齐线等宽数字');
    assert(amount.baselineGap < .5, '金额符号与数字基线不齐');
    assert(amount.lines === 1 && amount.contained, '金额被换行或截断');
  }
  for (const gap of result.notices) assert(gap < .5, '状态名称、数量与单位基线不齐');
  if (!mobile) for (const column of result.columns) assert(column.length > 0 && Math.max(...column) - Math.min(...column) < .5, '账单字段或操作列起点不齐');
  return result;
}

try {
  for (const id of ['modern', 'warm-ledger']) for (const device of ['desktop', 'mobile']) for (const mode of ['light', 'dark']) {
    const mobile = device === 'mobile';
    const context = await browser.newContext({ baseURL, viewport: { width: mobile ? 390 : 1280, height: 1200 }, deviceScaleFactor: 2 });
    try {
      const reset = await context.request.post('/__fixture', { data: { reset: true, installed: true, authed: true, upgrade: null, failNext: null } });
      assert.equal(reset.status(), 200, '必须先启动隔离示例服务');
      assert.deepEqual(await reset.json(), { ok: true }, '当前地址不是隔离示例服务');
      const selected = await context.request.put('/api/skins/active', { data: { id, version: '1.0.0' } });
      assert.equal(selected.status(), 200);
      await context.addInitScript(value => localStorage.setItem('appearance.mode', value), mode);
      const page = await context.newPage(); await page.goto('/bills');
      await expect(page.locator('html')).toHaveAttribute('data-skin', id + '@1.0.0');
      await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
      await expect(page.locator('.agenda-summary-number').first()).toHaveText('4,123.40');
      const rows = page.locator(mobile ? '.agenda-mobile-row' : '.agenda-table .ant-table-row');
      await expect(rows.nth(mobile ? 1 : 2)).toBeVisible();
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const layout = await checkAlignment(page, mobile);
      const summary = await page.locator('.agenda-totals').boundingBox();
      const container = await page.locator('.bill-center').boundingBox();
      const last = await rows.nth(mobile ? 1 : 2).boundingBox();
      const x = mobile ? 0 : Math.floor(summary.x - 12);
      const y = mobile ? 0 : Math.floor(container.y + 12);
      const clip = { x, y, width: mobile ? 390 : Math.ceil(summary.width + 24), height: Math.ceil(last.y + last.height + 12 - y) };
      assert(clip.y + clip.height <= 1200, '预览内容超出取景范围');
      const png = await page.screenshot({ clip, animations: 'disabled' });
      const hash = createHash('sha256').update(png).digest('hex').slice(0, 12);
      const variant = device + '-' + mode;
      captures.push({ id, variant, name: 'previews/' + variant + '-' + hash + '.png', png });
      audit.push({ id, variant, clip, hash, ...layout });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

// 全部取景和检查成功后才更新包，失败不会覆盖已有预览。
for (const id of ['modern', 'warm-ledger']) {
  const folder = path.join(root, 'server/skins', id, '1.0.0');
  const manifestFile = path.join(folder, 'skin.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const previous = new Set(Object.values(manifest.previews));
  const current = captures.filter(capture => capture.id === id);
  for (const capture of current) await fs.writeFile(path.join(folder, capture.name), capture.png);
  manifest.previews = Object.fromEntries(current.map(capture => [capture.variant, capture.name]));
  manifest.assets = [...manifest.assets.filter(asset => !previous.has(asset)), ...current.map(capture => capture.name)];
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  for (const name of previous) if (!current.some(capture => capture.name === name)) {
    const file = path.resolve(folder, name);
    assert.equal(path.dirname(file), path.join(folder, 'previews'), '旧预览路径超出预览目录');
    await fs.unlink(file);
  }
}
await fs.mkdir(path.join(root, '.ui-fixture'), { recursive: true });
await fs.writeFile(path.join(root, '.ui-fixture/skin-preview-audit.json'), JSON.stringify(audit, null, 2));
console.log('两套皮肤的 8 张实际界面预览已生成，金额基线、数字样式及字段对齐检查通过。');
