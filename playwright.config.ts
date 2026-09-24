import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3159',
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3159/api/health',
    reuseExistingServer: false,
    env: { PORT: '3159', FOUNDRY_DB: ':memory:', FOUNDRY_CODEX_DRY_RUN: 'true' },
  },
});
