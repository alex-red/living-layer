import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4311',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun run start',
    url: 'http://127.0.0.1:4311/api/status',
    reuseExistingServer: false,
    env: {
      PORT: '4311',
      DATA_DIR: '.data/browser-tests',
      META_LIVE_ENABLED: 'false',
      HA_LIVE_ENABLED: 'false',
    },
  },
});
