import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, viewport: { width: 420, height: 900 }, locale: 'de-DE' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173/sidepanel.html', reuseExistingServer: true, timeout: 15000 },
});
