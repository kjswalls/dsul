/**
 * One place for the E2E environment contract.
 *
 * Previously the app's timezone was hardcoded in five unlinked places (three in
 * helpers/dates.ts, twice in playwright.config.ts) and the required env vars
 * were validated inside loginTestUser — so a missing one surfaced per-test,
 * mid-run, instead of once at startup.
 */

/**
 * The timezone both the browser and the date helpers run in. Imported by
 * playwright.config.ts so the projects and the helpers cannot drift apart.
 */
export const TEST_TZ = 'America/Los_Angeles';

/**
 * Where the suite points, and the ONE place that decides it.
 *
 * Hardcoding :3000 in three files made the suite unrunnable from a worktree —
 * and unrunnable in a way that produced results rather than an error. This repo
 * is worked in several worktrees at once (see CLAUDE.md), each with its own
 * branch and its own `next dev`. Whichever one happens to be up owns :3000. The
 * config used to ADOPT it (`reuseExistingServer: !CI`), so the run went green or
 * red against a branch that was not the one under test — or against a dev server
 * pointed at prod; it now refuses a busy port instead. Overriding this is how a
 * second checkout gets an honest run:
 *
 *     E2E_BASE_URL=http://localhost:3100 pnpm e2e
 *
 * playwright.config.ts derives both `use.baseURL` and `webServer.url` from this,
 * and passes the port to `next dev`, so the server started and the server tested
 * cannot drift apart.
 */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * Hosts the suite may talk to. Loopback only, and deliberately no override.
 *
 * Until 2026-09-24 CI ran this suite against PRODUCTION Supabase (the job got its
 * keys from repo secrets). Four PRs' E2E runs overlapped that night, each ran for
 * hours on retries with no job timeout, and the flood of password grants and
 * `getUser()` calls took the live project down: do.dsul.app could not log in.
 * The same runs are the likeliest source of the "5,917 requests from
 * localhost:3000" once blamed on local dev: the Playwright browser's origin is
 * localhost:3000 wherever it runs.
 *
 * There is no remote test project, so a remote URL can only be prod, and prod is
 * exactly what this refuses. If a dedicated remote test project ever exists, add
 * its host here on purpose rather than growing an escape hatch.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostOf(name: string, raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    throw new Error(`E2E: ${name} is not a URL: ${raw}`);
  }
}

/**
 * Refuse to run unless both the Supabase project and the app under test are on
 * loopback. Called from playwright.config.ts right after .env.test loads, so it
 * runs before the webServer builds or starts anything, and again in every worker
 * (each re-evaluates the config) — which also covers helpers/api.ts, which reads
 * process.env directly. A MISSING Supabase URL fails too: the webServer starts
 * before globalSetup's testEnv() check, and a `next dev` with no URL of its own
 * falls back to .env.local, which `vercel env pull` points at prod.
 *
 * Takes the env as a parameter so the unit test can drive it without mutating
 * process.env.
 */
export function assertLocalTarget(env: Record<string, string | undefined>): void {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error(
      'E2E: NEXT_PUBLIC_SUPABASE_URL is not set. Run ./scripts/local-setup.sh e2e ' +
        'to start a local Supabase and write .env.test.'
    );
  }
  const targets: [string, string][] = [['NEXT_PUBLIC_SUPABASE_URL', supabaseUrl]];
  if (env.E2E_BASE_URL) targets.push(['E2E_BASE_URL', env.E2E_BASE_URL]);
  const refused = targets
    .map(([name, raw]) => [name, hostOf(name, raw)] as const)
    .filter(([, host]) => !LOCAL_HOSTS.has(host));

  if (refused.length) {
    throw new Error(
      `E2E refuses to run against a non-local host: ${refused
        .map(([name, host]) => `${name} → ${host}`)
        .join(', ')}.\n` +
        'The suite creates and deletes data and hammers auth; pointed at a hosted ' +
        'project it is a load test on production. Run ./scripts/local-setup.sh e2e ' +
        'and use the .env.test it writes.'
    );
  }
}

/** The port half of BASE_URL, for the dev-server command. */
export const E2E_PORT = new URL(BASE_URL).port || '3000';

/** Where globalSetup parks the authenticated session + resolved API key. */
export const STORAGE_STATE = 'tests/e2e/.auth/state.json';
export const SETUP_ARTIFACT = 'tests/e2e/.auth/setup.json';

/**
 * Titles created by the suite all carry this prefix, so the global sweep can
 * recognise its own litter without touching anything else.
 */
export const TEST_TITLE_PREFIX = 'e2e_';

export interface TestEnv {
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
  email: string;
  password: string;
}

/**
 * Read and validate the whole env contract at once. Throws a single actionable
 * error naming every missing var rather than failing on the first one.
 */
export function testEnv(): TestEnv {
  const vars = {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SECRET_KEY,
    email: process.env.TEST_USER_EMAIL,
    password: process.env.TEST_USER_PASSWORD,
  };

  const missing = Object.entries(vars)
    .filter(([, v]) => !v)
    .map(([k]) => NAMES[k as keyof typeof vars]);

  if (missing.length) {
    throw new Error(
      `Missing E2E env vars: ${missing.join(', ')}.\n` +
        'Copy .env.test.example to .env.test and fill it in — playwright.config.ts ' +
        'loads .env.test automatically. `./scripts/local-setup.sh e2e` writes it for a local stack.'
    );
  }

  return vars as TestEnv;
}

const NAMES = {
  supabaseUrl: 'NEXT_PUBLIC_SUPABASE_URL',
  anonKey: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  serviceKey: 'SUPABASE_SECRET_KEY',
  email: 'TEST_USER_EMAIL',
  password: 'TEST_USER_PASSWORD',
} as const;
