import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', workers: 1, fullyParallel: false,
  outputDir: process.env.UI_FIXTURE_OUTPUT || '../.ui-fixture/test-results',
  use: { baseURL: process.env.UI_FIXTURE_URL || 'http://127.0.0.1:4173', channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: 'list',
});
