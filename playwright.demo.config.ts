import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

// Same env contract as the e2e suite: .env.test, written by
// ./scripts/local-setup.sh e2e. The demos film the LOCAL stack only, with
// invented data, so a recording can never show a real planner.
dotenv.config({ path: '.env.test', override: false, quiet: true });

import { TEST_TZ, STORAGE_STATE, BASE_URL, E2E_PORT, assertLocalTarget } from './tests/e2e/helpers/env';

assertLocalTarget(process.env);

/**
 * The demo reel: scripted walk-throughs of the app, recorded as video for the
 * "What I'm Working On" series. `pnpm demo:record` writes one clip per beat to
 * demo-reel/ (gitignored). Not a test suite: nothing here asserts behaviour
 * beyond what it needs to wait for, and CI never runs it.
 *
 *   ./scripts/local-setup.sh e2e        # once: the local stack and .env.test
 *   pnpm demo:record                    # every beat
 *   pnpm demo:record -g "power mode"    # one beat
 *
 * DEMO_THEME=light films the light theme, DEMO_SLOWMO=<ms> slows every action,
 * and DEMO_CHROMIUM=<path> points at a Chromium other than Playwright's own.
 *
 * The clip is the viewport, pixel for pixel: Playwright pads a smaller page
 * into a bigger frame rather than scaling it, so the two stay equal. Zoom in
 * the edit for a closer shot.
 */
const FRAME = { width: 1920, height: 1080 };

export default defineConfig({
  testDir: './tests/demo',
  testMatch: '**/*.demo.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  // One at a time: each beat has the screen to itself, and the seeded data of one
  // beat never shows up in another's shot.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: 'test-results/demo',

  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    timezoneId: TEST_TZ,
    viewport: FRAME,
    video: { mode: 'on', size: FRAME },
    colorScheme: process.env.DEMO_THEME === 'light' ? 'light' : 'dark',
    launchOptions: {
      slowMo: Number(process.env.DEMO_SLOWMO ?? 0),
      // For a machine whose Chromium isn't the one this Playwright pinned.
      executablePath: process.env.DEMO_CHROMIUM || undefined,
    },
  },

  webServer: {
    // Never adopt a running server: a `pnpm dev` already on the port may be
    // pointed at prod (see playwright.config.ts).
    command: `pnpm dev --port ${E2E_PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
