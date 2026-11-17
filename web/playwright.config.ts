import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', workers: 1, fullyParallel: false,
  // 全量长跑下存在与改动无关的负载偶发（如皮肤导入删除的节奏竞态），重试一次并在报告中显式标注
  retries: 1,
  outputDir: process.env.UI_FIXTURE_OUTPUT || '../.ui-fixture/test-results',
  use: { baseURL: process.env.UI_FIXTURE_URL || 'http://127.0.0.1:4173', channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: 'list',
});
