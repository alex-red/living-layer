import { defineConfig, devices } from '@playwright/test';

// CI runners are a few times slower than a dev machine, so CI waits longer. The strict run waits
// less than the default, so a wait that only just passes locally fails before it reaches CI.
const expectTimeout = process.env.CI ? 10_000 : process.env.BROWSER_STRICT ? 2_500 : 5_000;

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  expect: { timeout: expectTimeout },
  use: {
    baseURL: 'http://127.0.0.1:43432',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  webServer: {
    // Every run starts from empty data: what one run saves (a placed fixture, say) breaks the next.
    command: 'rm -rf .data/browser-tests && bun run start',
    url: 'http://127.0.0.1:43432/api/status',
    reuseExistingServer: false,
    env: {
      PORT: '43432',
      REMOTE_CAMERA_PORT: '43439',
      DATA_DIR: '.data/browser-tests',
      META_LIVE_ENABLED: 'false',
      HA_LIVE_ENABLED: 'false',
    },
  },
});
