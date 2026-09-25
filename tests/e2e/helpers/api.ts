import { readFileSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { BASE_URL, SETUP_ARTIFACT, TEST_TITLE_PREFIX } from './env';

/**
 * Fixtures created through the agent API.
 *
 * The /api/agent/* routes authenticate with Bearer <dsul_api_key> (stored in
 * user_settings.openclaw_api_key). That key is resolved ONCE in globalSetup and
 * read from disk here.
 *
 * Why not fetch it per test, as before? The old getAccessToken() POSTed
 * /api/agent/apikey whenever GET returned null, and that route REGENERATES the
 * key. Under fullyParallel two workers could both see null, both mint a key, and
 * the loser's Bearer token would 401 — with cleanupTestData swallowing the
 * failure as a console.warn, leaking rows permanently.
 */

let cachedKey: string | null = null;

/** The test user's API key, resolved by globalSetup. */
export function apiKey(): string {
  if (cachedKey) return cachedKey;
  try {
    const { apiKey: key } = JSON.parse(readFileSync(SETUP_ARTIFACT, 'utf8'));
    if (!key) throw new Error('no apiKey in setup artifact');
    cachedKey = key as string;
    return cachedKey;
  } catch (err) {
    throw new Error(
      `Could not read the test API key from ${SETUP_ARTIFACT}. ` +
        'globalSetup should have written it — did the run start via playwright.config.ts? ' +
        `(${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/** The test user's id, resolved by globalSetup. */
export function testUserId(): string {
  const { userId } = JSON.parse(readFileSync(SETUP_ARTIFACT, 'utf8'));
  return userId as string;
}

/**
 * Retained for specs that still ask for a token explicitly. Now a pure read of
 * the setup artifact — it makes no network call and cannot rotate the key.
 */
export async function getAccessToken(_page?: Page): Promise<string> {
  return apiKey();
}

/**
 * A collision-proof, sweepable title.
 *
 * The TEST_TITLE_PREFIX lets globalSetup recognise and delete litter from runs
 * that were aborted before their cleanup could run. The random suffix (not just a
 * timestamp) matters under parallelism: two workers starting in the same
 * millisecond used to be able to produce the same title, and every assertion here
 * matches on either id or exact title.
 */
export function testTitle(label: string): string {
  return `${TEST_TITLE_PREFIX}${label}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/**
 * A title prefix owned by ONE spec file, covering everything it creates —
 * items, containers and labels alike.
 *
 * `cleanupTestCollections` and `cleanupByTitlePrefix` are both hard DELETEs
 * across the shared test user, so two spec files that sweep `TEST_TITLE_PREFIX`
 * delete each other's rows — and with `fullyParallel` + 4 local workers they run
 * at the same time. `test.describe.configure({mode:'serial'})` is file-scoped
 * and does nothing about it. Both files pass alone and fail
 * non-deterministically in a full run, which is the residue class
 * playwright.config.ts documents.
 *
 * Was `collectionScope`, and containers were the only half it covered — which
 * left `programs.spec` scoping its containers correctly
 * while still calling `cleanupByTitlePrefix(TEST_TITLE_PREFIX)` on the line
 * above and deleting every other spec's ITEMS. Half a fix reads like a whole one
 * at the call site, so the scope now spans both and there is no bare-prefix
 * sweep left to pair it with.
 *
 * Every prefix still starts with TEST_TITLE_PREFIX, so globalSetup's litter
 * sweep keeps catching all of them.
 *
 * The two specs that genuinely need an EMPTY BOARD rather than merely their own
 * rows — dnd and habits, whose drop targets resolve by comparing rect centres —
 * cannot use this: another spec's fixtures move their geometry even when nothing
 * is deleted. They are isolated by execution order instead; see the `dnd` and
 * `habits` projects in playwright.config.ts.
 *
 * @example
 *   const scope = specScope('rail');
 *   await cleanupTestCollections(scope.prefix);
 *   await createContainer(page, 'program', scope.title('Summer'));
 */
export function specScope(spec: string): { prefix: string; title: (label: string) => string } {
  const prefix = `${TEST_TITLE_PREFIX}${spec}_`;
  return { prefix, title: (label: string) => testTitle(`${spec}_${label}`) };
}

/**
 * The containers as STORED, straight from the database.
 *
 * Every container write in the app is fire-and-forget
 * (`dbUpdateProgram(...).catch(console.error)`), so a DOM assertion right after
 * a click proves only that the optimistic `set()` ran. Reload on the strength of
 * that and `page.reload()` can abort the PATCH still in flight — the test then
 * carries on against a program that never changed, and the failure surfaces
 * several steps later as something else entirely.
 *
 * Poll this before any reload that is meant to prove persistence.
 */
export async function fetchTestCollections(
  table: 'routines' | 'programs',
  prefix: string
): Promise<{ id: string; name: string; state?: string; paused_at?: string | null }[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  const res = await fetch(
    `${url}/rest/v1/${table}?user_id=eq.${testUserId()}&select=id,name,${table === 'programs' ? 'state' : 'paused_at'}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) throw new Error(`[fetchTestCollections] ${table}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string; name: string }[]).filter((row) =>
    row.name?.startsWith(prefix)
  );
}

/**
 * One item type as STORED, or null while it does not yet hold `expect`.
 *
 * The sibling of fetchTestCollections, for the same reason and against the same
 * hazard: `updateItemType` sets the store and then fires
 * `dbUpdateItemType(id, updates).catch(console.error)` without awaiting it
 * (planner-store.ts). Typing into the Plural field and pressing Enter therefore
 * proves only that the keystroke reached the store — the PATCH is still in
 * flight, and `page.reload()` aborts it.
 *
 * That is not hypothetical. organize.spec's plural test did exactly this and
 * passed 10/10 in isolation for a whole phase, then failed on the first full
 * parallel run: the row came back holding `${name}s`, the value createLabel
 * writes at creation, because the update never landed. The app was correct at
 * every layer — store, allowlist, UPDATE — and the test was asserting a
 * keystroke while reading like it asserted persistence.
 *
 * Returns null rather than throwing on a mismatch so callers can drive it from
 * `expect.poll`, which supplies the waiting and the eventual failure message.
 */
export async function fetchTestItemTypePlural(id: string): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  const res = await fetch(`${url}/rest/v1/item_types?id=eq.${id}&select=label_plural`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`[fetchTestItemTypePlural] ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as { label_plural?: string }[];
  return rows[0]?.label_plural ?? null;
}

function authHeaders() {
  return { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' };
}

function ctx(page: Page | APIRequestContext): APIRequestContext {
  return 'request' in page ? page.request : page;
}

/** Create a task via the agent API; returns its id. */
export async function createTestTask(
  page: Page | APIRequestContext,
  _accessTokenOrData: string | Record<string, unknown>,
  maybeData?: Record<string, unknown>
): Promise<string> {
  // Tolerates both the old (page, token, data) call shape and a terser
  // (page, data) one, so specs can be migrated incrementally.
  const data = (maybeData ?? (_accessTokenOrData as Record<string, unknown>)) ?? {};

  const response = await ctx(page).post(`${BASE_URL}/api/agent/tasks`, {
    headers: authHeaders(),
    data: { title: testTitle('task'), status: 'pending', isScheduled: false, order: 9999, ...data },
  });

  if (!response.ok()) {
    throw new Error(`createTestTask failed (${response.status()}): ${await response.text()}`);
  }
  const { task } = await response.json();
  return task.id as string;
}

/** Create a habit via the agent API; returns its id. */
export async function createTestHabit(
  page: Page | APIRequestContext,
  _accessTokenOrData: string | Record<string, unknown>,
  maybeData?: Record<string, unknown>
): Promise<string> {
  const data = (maybeData ?? (_accessTokenOrData as Record<string, unknown>)) ?? {};

  const response = await ctx(page).post(`${BASE_URL}/api/agent/habits`, {
    headers: authHeaders(),
    data: {
      title: testTitle('habit'),
      // `group`, not `project` — this is the AGENT body, and its vocabulary is
      // pinned (HabitCreateSchema). The server renames it to the item's
      // `project` at the boundary; see fromLegacyHabit in lib/db.ts.
      group: 'Personal',
      status: 'pending',
      repeatFrequency: 'daily',
      ...data,
    },
  });

  if (!response.ok()) {
    throw new Error(`createTestHabit failed (${response.status()}): ${await response.text()}`);
  }
  const { habit } = await response.json();
  return habit.id as string;
}

/** Patch a task through the agent API. */
export async function patchTestTask(
  page: Page | APIRequestContext,
  id: string,
  data: Record<string, unknown>
): Promise<void> {
  const res = await ctx(page).patch(`${BASE_URL}/api/agent/tasks/${id}`, {
    headers: authHeaders(),
    data,
  });
  if (!res.ok()) throw new Error(`patchTestTask failed (${res.status()}): ${await res.text()}`);
}

/** Read a task back through the agent API — for asserting what actually persisted. */
export async function fetchTestTask(
  page: Page | APIRequestContext,
  id: string
): Promise<Record<string, unknown> | null> {
  const res = await ctx(page).get(`${BASE_URL}/api/agent/context`, { headers: authHeaders() });
  if (!res.ok()) throw new Error(`fetchTestTask failed (${res.status()}): ${await res.text()}`);
  const body = await res.json();
  return (body.tasks ?? []).find((t: { id: string }) => t.id === id) ?? null;
}

/** Read a habit back through the agent API. */
export async function fetchTestHabit(
  page: Page | APIRequestContext,
  id: string
): Promise<Record<string, unknown> | null> {
  const res = await ctx(page).get(`${BASE_URL}/api/agent/context`, { headers: authHeaders() });
  if (!res.ok()) throw new Error(`fetchTestHabit failed (${res.status()}): ${await res.text()}`);
  const body = await res.json();
  return (body.habits ?? []).find((h: { id: string }) => h.id === id) ?? null;
}

/**
 * Read any item back through the agent API, INCLUDING suppressed ones.
 *
 * fetchTestTask/fetchTestHabit read the legacy projections, which drop
 * suppressed open loops — so asserting "the streak survived the pause" through
 * them returns null, indistinguishable from "the habit was deleted". items[] is
 * unfiltered and carries pausedAt/pausedUntil.
 */
export async function fetchTestItem(
  page: Page | APIRequestContext,
  id: string
): Promise<Record<string, unknown> | null> {
  const res = await ctx(page).get(`${BASE_URL}/api/agent/context`, { headers: authHeaders() });
  if (!res.ok()) throw new Error(`fetchTestItem failed (${res.status()}): ${await res.text()}`);
  const body = await res.json();
  return (body.items ?? []).find((i: { id: string }) => i.id === id) ?? null;
}

/**
 * Delete fixtures. Never throws — a cleanup failure must not mask the assertion
 * failure that a test is actually reporting.
 */
export async function cleanupTestData(
  page: Page | APIRequestContext,
  _accessTokenOrTaskIds: string | string[],
  maybeTaskIds?: string[],
  maybeHabitIds: string[] = []
): Promise<void> {
  const taskIds = Array.isArray(_accessTokenOrTaskIds)
    ? _accessTokenOrTaskIds
    : (maybeTaskIds ?? []);
  const habitIds = Array.isArray(_accessTokenOrTaskIds) ? (maybeTaskIds ?? []) : maybeHabitIds;

  const headers = { Authorization: `Bearer ${apiKey()}` };
  const request = ctx(page);

  await Promise.allSettled([
    ...taskIds.filter(Boolean).map(async (id) => {
      const res = await request.delete(`${BASE_URL}/api/agent/tasks/${id}`, { headers });
      if (!res.ok() && res.status() !== 404) {
        console.warn(`[cleanup] task ${id}: ${res.status()}`);
      }
    }),
    ...habitIds.filter(Boolean).map(async (id) => {
      const res = await request.delete(`${BASE_URL}/api/agent/habits/${id}`, { headers });
      if (!res.ok() && res.status() !== 404) {
        console.warn(`[cleanup] habit ${id}: ${res.status()}`);
      }
    }),
  ]);
}

/**
 * Delete every routine and program whose name starts with `prefix`.
 *
 * Direct service-key REST, following the resetUserSettings precedent, because
 * there is no agent route for containers — v1 has no agent write surface for
 * them at all (plan decision 6). A HARD delete, not the app's soft one: a
 * soft-deleted row still occupies its name and still counts in the manager's
 * list until the 30-day purge cron gets to it, so a spec that ran twice would
 * accumulate identically-named rows on the shared test user forever.
 *
 * Join rows follow by CASCADE, so member items are released but never touched —
 * they are cleaned up by title prefix like every other fixture.
 *
 * Never throws: a cleanup failure must not mask the assertion a test is
 * actually reporting.
 */
export async function cleanupTestCollections(prefix: string): Promise<void> {
  await sweepByNamePrefix(['programs', 'routines'], prefix);
}

/**
 * The same sweep for `goals`.
 *
 * Its own function rather than a third table in cleanupTestCollections, for the
 * reason cleanupTestLabels gives: an existing spec's afterEach must not start
 * hard-DELETEing rows it never created. `goal_items` needs no line — the
 * composite FKs cascade.
 */
export async function cleanupTestGoals(prefix: string): Promise<void> {
  await sweepByNamePrefix(['goals'], prefix);
}

/**
 * One goal as STORED, or null while it does not yet exist.
 *
 * Every goal write in the app is fire-and-forget, so a DOM assertion right
 * after a click proves only that the optimistic set() ran — and `page.reload()`
 * on the strength of it can abort the PATCH still in flight. Poll this before
 * any reload meant to prove persistence. (fetchTestCollections' lesson, which
 * that helper's own docblock records paying for once.)
 */
export async function fetchTestGoal(
  prefix: string
): Promise<{
  id: string;
  name: string;
  state: string;
  why: string | null;
  target_on: string | null;
} | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  // `deleted_at=is.null` and `order=created_at.desc`, both load-bearing.
  //
  // WITHOUT the filter this helper can never observe a delete: removeGoal is a
  // SOFT delete (the 30-day trash, so goal_items survive a restore), so a poll
  // for null would spin until the expect timeout on a row that is still there.
  // WITHOUT the order it returns whichever row the heap hands back, which is
  // fine only while a spec creates exactly one goal per prefix — the moment one
  // creates two, "the test goal" becomes arbitrary.
  const res = await fetch(
    `${url}/rest/v1/goals?user_id=eq.${testUserId()}&deleted_at=is.null` +
      `&order=created_at.desc&select=id,name,state,why,target_on`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) throw new Error(`[fetchTestGoal] ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as {
    id: string;
    name: string;
    state: string;
    why: string | null;
    target_on: string | null;
  }[];
  return rows.find((row) => row.name?.startsWith(prefix)) ?? null;
}

/** The roles a goal's members hold, as stored — the join table, not the arrays. */
export async function fetchTestGoalMembers(
  goalId: string
): Promise<{ item_id: string; role: string }[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  const res = await fetch(
    `${url}/rest/v1/goal_items?goal_id=eq.${goalId}&select=item_id,role`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) throw new Error(`[fetchTestGoalMembers] ${res.status} ${await res.text()}`);
  return (await res.json()) as { item_id: string; role: string }[];
}

/**
 * The same sweep for the LABEL tables, which the Organize console can now create
 * and which nothing swept before — projects, habit groups and custom item types.
 *
 * Separate from cleanupTestCollections rather than folded into it so an existing
 * spec's `afterEach` cannot start hard-DELETEing rows it never made.
 *
 * `item_types.name` is a SLUG, so the prefix is lowercased for that table: the
 * console derives `e2e_org_goal_x1` from a typed `e2e_org_Goal_x1`, and a
 * case-sensitive startsWith would leave every custom type behind.
 */
export async function cleanupTestLabels(prefix: string): Promise<void> {
  // `habit_groups` is frozen ballast since migration 039 and nothing creates
  // rows in it any more — swept anyway, so a run against a database that still
  // holds pre-collapse fixtures cleans up after itself.
  await sweepByNamePrefix(['projects', 'habit_groups'], prefix);
  await sweepByNamePrefix(['item_types'], prefix.toLowerCase());
}

async function sweepByNamePrefix(tables: string[], prefix: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  for (const table of tables) {
    try {
      // Read then delete by id, rather than pushing the prefix into a LIKE.
      // `_` is a single-character WILDCARD in SQL LIKE and TEST_TITLE_PREFIX is
      // `e2e_`, so `name=like.e2e_%` would also match `e2eX…`, `e2e-…` and
      // anything else with a fourth character — a hard DELETE matching more
      // than this function's own doc promises. A JS startsWith has no such
      // second reading.
      const res = await fetch(
        `${url}/rest/v1/${table}?user_id=eq.${testUserId()}&select=id,name`,
        { headers }
      );
      if (!res.ok) {
        console.warn(`[cleanup] ${table}: ${res.status} ${await res.text()}`);
        continue;
      }
      const litter = ((await res.json()) as { id: string; name: string }[]).filter((row) =>
        row.name?.startsWith(prefix)
      );
      if (litter.length === 0) continue;
      const ids = litter.map((row) => row.id).join(',');
      const del = await fetch(`${url}/rest/v1/${table}?id=in.(${ids})`, {
        method: 'DELETE',
        headers,
      });
      if (!del.ok) console.warn(`[cleanup] ${table}: ${del.status} ${await del.text()}`);
    } catch (err) {
      console.warn(`[cleanup] ${table}:`, err);
    }
  }
}

/**
 * Force the test user's settings back to the values globalSetup seeded.
 *
 * These columns are GLOBAL to the shared test user, so a spec that changes one
 * leaks into every other spec's fresh context — a leaked 24h clock or a leaked
 * `show_completed_tasks: false` makes unrelated assertions fail with no hint as to
 * why. Restoring through the UI is not enough: the write is debounced ~500ms with
 * only a fire-and-forget pagehide flush, and a failing test never reaches its
 * restore step at all. So write the row directly and don't depend on the app.
 */
export async function resetUserSettings(page: Page | APIRequestContext): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  const res = await fetch(`${url}/rest/v1/user_settings`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      user_id: testUserId(),
      onboarding_completed: true,
      morning_check_enabled: false,
      eod_review_enabled: false,
      show_completed_tasks: true,
      compact_mode: false,
      default_view: 'day',
      time_format: '12h',
      week_start_day: 'sunday',
      // The sidebar spec's hover-peek tests switch this on. Left out of the
      // upsert, it stayed on for every later run against the same database,
      // and each expand-zone click after that peeked instead of expanding.
      left_sidebar_hover: false,
    }),
  });
  if (!res.ok) console.warn(`[settings-reset] ${res.status}: ${await res.text()}`);
}

/**
 * Write specific columns on the test user's settings row.
 *
 * For asserting that a PERSISTED preference reaches the view, without depending on
 * the settings dialog's sectioned navigation (its selects are not mounted until
 * their section is chosen, so a locator can be looking at nothing).
 */
export async function setUserSetting(
  page: Page | APIRequestContext,
  columns: Record<string, unknown>
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  const res = await fetch(`${url}/rest/v1/user_settings`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ user_id: testUserId(), ...columns }),
  });
  if (!res.ok) {
    throw new Error(`setUserSetting failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * Delete every item whose title starts with `prefix`.
 *
 * The id-based cleanup above only covers fixtures created through the API. Items
 * created through the UI have no id on the test side, so tests that add via the
 * dialog or the omnibar used to leak a row on every run — permanently, into a
 * braindump that renders all of them unvirtualized.
 */
export async function cleanupByTitlePrefix(
  page: Page | APIRequestContext,
  prefix: string
): Promise<void> {
  const request = ctx(page);
  const headers = { Authorization: `Bearer ${apiKey()}` };

  const res = await request.get(`${BASE_URL}/api/agent/context`, { headers });
  if (!res.ok()) {
    console.warn(`[cleanup] context fetch failed: ${res.status()}`);
    return;
  }
  const body = await res.json();

  // items[], NOT tasks[]/habits[]. Those projections drop suppressed open loops
  // (the agent-context filter), so a fixture a spec paused — or one left paused
  // by a spec that failed mid-flight — is invisible to them, and this helper
  // never throws, so the leak is silent and permanent on a shared test user.
  // items[] is unfiltered by design and has carried both kinds since
  // schemaVersion 3.
  const litter = (body.items ?? []).filter((i: { title?: string }) => i.title?.startsWith(prefix));
  const tasks = litter.filter((i: { type?: string }) => i.type !== 'habit');
  const habits = litter.filter((i: { type?: string }) => i.type === 'habit');

  await cleanupTestData(
    page,
    tasks.map((t: { id: string }) => t.id),
    habits.map((h: { id: string }) => h.id)
  );
}
