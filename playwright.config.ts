import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

// Load .env.test BEFORE importing anything that reads the env contract, so
// `pnpm e2e` works with no wrapper command. `override: false` means real
// environment variables always win over the file.
dotenv.config({ path: '.env.test', override: false, quiet: true });

// eslint-disable-next-line import/first -- must follow dotenv.config()
import {
  TEST_TZ,
  STORAGE_STATE,
  BASE_URL,
  E2E_PORT,
  assertLocalTarget,
} from './tests/e2e/helpers/env';

// Loopback only, before the webServer builds or starts anything. A call, not a
// side effect of importing env.ts: imports are hoisted above dotenv.config(), so
// an import-time check would run before .env.test loads. See env.ts for the
// 2026-09-24 incident this exists for.
assertLocalTarget(process.env);

export default defineConfig({
  testDir: './tests/e2e',

  // Authenticate once for the whole run and seed the shared test user's
  // settings. Without this every test did its own Supabase password grant and a
  // full run tripped the auth rate limit. See tests/e2e/global-setup.ts.
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Locally, `undefined` means Playwright's default of cores/2 — 10 on a 20-core
  // box. All ten then queue against ONE `next dev --webpack` server that compiles
  // routes on first hit, and the contention does not degrade gracefully: tests
  // time out at 60s with their fixture POST still in flight ("Target page,
  // context or browser has been closed"), which reads exactly like a broken
  // selector and is why this suite looked far redder than it was. Full suite,
  // same tree: 10 workers → 20 passed / 58 failed; 4 → 79 passed / 13 failed in
  // 6.7m. CI stays at 1 for a different reason — it runs a prod build and
  // serializes for stability.
  //
  // 4 is the floor, not a dial to keep turning: 2 workers scores the same
  // (79 passed / 12 failed) and takes 8.4m, and it fails a DIFFERENT dozen. That
  // residue is not CPU — every one of them passes in isolation. It is the shared
  // test user. One account backs the whole suite, so under fullyParallel one
  // spec's global write (settings.spec's afterEach reset, view-matrix leaving
  // default_view on 'week') lands mid-test in another. Fixing it means a user
  // per worker, or serialising the specs that write user_settings.
  workers: process.env.CI ? 1 : 4,
  // The github reporter is inert outside Actions, and `html` alone auto-opens a
  // blocking server on failure while printing nothing — so a local run needs `list`.
  reporter: process.env.CI ? [['html'], ['github']] : [['list'], ['html', { open: 'never' }]],

  // The default 30s is measured against a `next dev` server that compiles routes
  // on first hit, so the first test to reach a route pays the compile out of its
  // own budget. Give tests room, but keep individual assertions snappy so a dead
  // selector fails in 10s instead of stalling the whole test.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    // retries is 0 locally, so `on-first-retry` would never capture a local
    // trace — precisely the runs where selector drift needs diagnosing.
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    // The session + seeded view prefs written by globalSetup. Every test starts
    // signed in, in Day × Buckets.
    storageState: STORAGE_STATE,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Match the app's timezone so date helpers and the browser agree on
        // "today". Imported, not re-typed: this string used to appear in five
        // unlinked places.
        timezoneId: TEST_TZ,
      },
      // Mobile-tagged tests run in the mobile project below (touch + phone
      // metrics); the two board-exclusive files run in the projects after it.
      grepInvert: /@mobile|@exclusive-/,
    },
    {
      // iPhone-14 metrics + touch, kept on Chromium so CI needs no WebKit install.
      name: 'mobile',
      use: {
        ...devices['iPhone 14'],
        defaultBrowserType: 'chromium',
        timezoneId: TEST_TZ,
      },
      grep: /@mobile/,
    },

    /**
     * THE BOARD-EXCLUSIVE TAIL.
     *
     * dnd.spec and habits.spec resolve drop targets by comparing rect CENTRES,
     * so they need an EMPTY board — not merely their own fixtures cleaned up.
     * Every other spec now sweeps a prefix it owns (`specScope` in
     * helpers/api.ts); these two cannot, because the problem is not whose rows
     * get deleted but whose rows EXIST while they measure. Another spec's
     * fixture moves their geometry without either file touching the other.
     *
     * So they are separated in TIME instead of by prefix. `dependencies` runs a
     * project only after its dependencies have fully finished, which is the one
     * ordering primitive that crosses file boundaries — `mode: 'serial'` is
     * file-scoped and `workers` is config-global, so neither can express "these
     * two files, never at the same time as anything else".
     *
     * The chain is total: chromium+mobile → dnd → habits. dnd depends on BOTH
     * front projects because mobile-tagged tests create fixtures too (pause,
     * eod-review, recurring), and habits depends on dnd because both
     * sweep the bare prefix and would otherwise delete each other — the exact
     * failure this whole arrangement exists to prevent, one level down.
     *
     * COST, AND THE ESCAPE HATCH. `dependencies` means "after that project
     * SUCCEEDS", not "after it finishes", so a single red test anywhere in
     * chromium skips this whole tail. Measured, not predicted: the first full
     * run under this config reported `23 did not run` — these 15 plus 8 serial
     * siblings — while 13 unrelated chromium tests were failing. A suite that
     * silently stops running its drag coverage whenever anything else is red is
     * worse than one that runs it noisily, so the tail is also reachable on its
     * own:
     *
     *     pnpm e2e:board
     *
     * which selects both projects with `--no-deps --workers=1`. Every word of
     * that is load-bearing. `--no-deps` is what makes the tail reachable while
     * chromium is red — it is the entire point. But it ALSO drops habits'
     * dependency on dnd, so the two would run in parallel and sweep the bare
     * prefix out from under each other; `--workers=1` is what puts them back in
     * sequence. Chaining two invocations with `&&` instead looks equivalent and
     * is not: a failure in dnd short-circuits habits, which is the same
     * "dependency failed, so it never ran" hole this script exists to escape,
     * one level down. (Observed, not reasoned about — the `&&` version was
     * written first and skipped habits on its first run.)
     *
     * The other cost is wall clock: the tail is serial, so a full run is longer
     * than a fully parallel one by roughly these two files' runtime. That is the
     * price of measuring an empty board at all.
     */
    {
      name: 'dnd',
      use: { ...devices['Desktop Chrome'], timezoneId: TEST_TZ },
      grep: /@exclusive-dnd/,
      dependencies: ['chromium', 'mobile'],
    },
    {
      name: 'habits',
      use: { ...devices['Desktop Chrome'], timezoneId: TEST_TZ },
      grep: /@exclusive-habits/,
      dependencies: ['dnd'],
    },
  ],

  webServer: {
    // In CI, test against a PRODUCTION build (next build && next start) instead
    // of the dev server. `next dev` compiles routes on-demand at first hit, so
    // under a test run the first request to each route can take many seconds —
    // the source of the 30s timeouts / "WebServer aborted" flakiness. A prod
    // build is fully precompiled, so responses are fast and stable (and it's
    // what real users hit). Locally, keep the dev server for fast iteration.
    // pnpm, not npm: this is a pnpm workspace and `@dsul/types` is a
    // `workspace:*` dependency that npm cannot resolve.
    // The port comes from BASE_URL so the server started and the server tested
    // cannot drift — see tests/e2e/helpers/env.ts on why that matters in a
    // multi-worktree checkout.
    // Never adopt a server that is already running. assertLocalTarget can only
    // vouch for the server this config starts with .env.test's values; a `pnpm
    // dev` already on the port loaded its own .env.local, which `vercel env
    // pull` points at prod. A busy port now fails fast — pick another with
    // E2E_BASE_URL=http://localhost:3100.
    command: process.env.CI
      ? `pnpm build && pnpm start --port ${E2E_PORT}`
      : `pnpm dev --port ${E2E_PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: (process.env.CI ? 300 : 120) * 1000,
    // Env vars (NEXT_PUBLIC_SUPABASE_URL, TEST_USER_EMAIL, etc.) come from
    // .env.test, loaded by the dotenv.config() call at the top of this file and
    // written by ./scripts/local-setup.sh e2e. The server inherits them from this
    // process, which is how the NEXT_PUBLIC_* values reach a CI `next build`.
  },
});
