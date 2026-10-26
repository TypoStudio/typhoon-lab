import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL: 'http://127.0.0.1:5186', viewport: { width: 1440, height: 900 }, screenshot: 'off', trace: { mode: 'retain-on-failure', screenshots: false } },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:5186', reuseExistingServer: !process.env.CI },
});
