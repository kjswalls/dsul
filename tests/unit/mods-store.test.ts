import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * lib/mods-store.ts against a recorded fake of the session client: what it
 * sends, what it keeps, and how it latches when 061 is missing.
 */

type Result = { data?: unknown; error: { code?: string; message?: string } | null };

const db = vi.hoisted(() => ({
  calls: [] as { table: string; ops: [string, unknown[]][] }[],
  results: [] as Result[],
  /** Set to make the next query hang until released. */
  gate: null as Promise<void> | null,
}));

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: (table: string) => {
      const call = { table, ops: [] as [string, unknown[]][] };
      db.calls.push(call);
      const result = db.results.shift() ?? { data: [], error: null };
      const gate = db.gate;
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'in', 'order', 'update', 'delete']) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
      builder.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
        (gate ?? Promise.resolve()).then(() => result).then(resolve, reject);
      return builder;
    },
  }),
}));

import { useModsStore, hasSafeModeParam } from '@/lib/mods-store';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: crypto.randomUUID(),
    user_id: USER,
    kind: 'recipe',
    slug: 'a',
    name: 'A',
    enabled: false,
    manifest: {},
    disabled_reason: null,
    created_at: '2026-10-07T00:00:00Z',
    updated_at: '2026-10-07T00:00:00Z',
    ...over,
  };
}

const opsOf = (i: number) => db.calls[i].ops;

beforeEach(() => {
  db.calls = [];
  db.results = [];
  db.gate = null;
  useModsStore.getState().reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

async function hydrateWith(rows: unknown[]) {
  db.results.push({ data: rows, error: null });
  await useModsStore.getState().hydrate(USER);
}

describe('hydrate', () => {
  it('selects the list columns for the user, parses, sorts by kind then name, and drops a malformed row', async () => {
    await hydrateWith([
      row({ kind: 'theme', name: 'Moss', slug: 'moss' }),
      row({ kind: 'recipe', name: 'Zed', slug: 'zed' }),
      row({ kind: 'recipe', name: 'Alpha', slug: 'alpha' }),
      row({ kind: 'mod', name: 'Water', slug: 'water' }),
      row({ slug: 'Bad Slug' }),
    ]);
    const s = useModsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.available).toBe(true);
    expect(s.rows.map((r) => r.name)).toEqual(['Alpha', 'Zed', 'Water', 'Moss']);
    expect(db.calls[0].table).toBe('user_mods');
    const [select, eq] = opsOf(0);
    expect(select[0]).toBe('select');
    expect(String(select[1][0])).not.toMatch(/source|store/);
    expect(eq).toEqual(['eq', ['user_id', USER]]);
  });

  it.each(['PGRST205', '42P01'])('latches unavailable on %s, and writes then make no call', async (code) => {
    db.results.push({ data: null, error: { code } });
    await useModsStore.getState().hydrate(USER);
    expect(useModsStore.getState()).toMatchObject({ available: false, rows: [], loaded: false });
    const before = db.calls.length;
    await useModsStore.getState().setEnabled('x', true);
    await useModsStore.getState().turnAllOff(USER);
    expect(db.calls.length).toBe(before);
  });

  it('un-stamps on a transient error and leaves available alone', async () => {
    db.results.push({ data: null, error: { code: '500', message: 'boom' } });
    await useModsStore.getState().hydrate(USER);
    expect(useModsStore.getState()).toMatchObject({
      available: true,
      hydratedUserId: null,
      loaded: false,
      failed: true,
    });
    await hydrateWith([row()]);
    expect(useModsStore.getState()).toMatchObject({ loaded: true, failed: false });
  });

  it('keeps a row whose name only the database accepts, so Make can still reach it', async () => {
    await hydrateWith([row({ name: '\u00a0', slug: 'nbsp' })]);
    expect(useModsStore.getState().rows.map((r) => r.slug)).toEqual(['nbsp']);
  });

  it('drops a response that arrives after the account changed', async () => {
    let release!: () => void;
    db.gate = new Promise<void>((r) => (release = r));
    db.results.push({ data: [row({ name: 'Old' })], error: null });
    const first = useModsStore.getState().hydrate(USER);
    db.gate = null;
    db.results.push({ data: [row({ user_id: OTHER, name: 'New' })], error: null });
    await useModsStore.getState().hydrate(OTHER);
    release();
    await first;
    expect(useModsStore.getState().rows.map((r) => r.name)).toEqual(['New']);
  });
});

describe('writes', () => {
  it('setEnabled sends enabled and clears the reason, scoped by id and user', async () => {
    const r = row({ disabled_reason: 'Hit an error 3 times' });
    await hydrateWith([r]);
    db.results.push({ error: null });
    await useModsStore.getState().setEnabled(r.id, true);
    expect(opsOf(1)).toEqual([
      ['update', [{ enabled: true, disabled_reason: null }]],
      ['eq', ['id', r.id]],
      ['eq', ['user_id', USER]],
    ]);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: true, disabledReason: null });
  });

  it('setEnabled rolls back only enabled and the reason on error, keeping a rename that landed meanwhile', async () => {
    const r = row({ disabled_reason: 'Hit an error 3 times' });
    await hydrateWith([r]);
    let release!: () => void;
    db.gate = new Promise<void>((res) => (release = res));
    db.results.push({ error: { code: '500' } });
    const toggling = useModsStore.getState().setEnabled(r.id, true);
    db.gate = null;
    db.results.push({ error: null });
    await useModsStore.getState().rename(r.id, 'Renamed');
    release();
    await toggling;
    expect(useModsStore.getState().rows[0]).toMatchObject({
      enabled: false,
      disabledReason: 'Hit an error 3 times',
      name: 'Renamed',
    });
  });

  it('a write that finds the table gone latches unavailable', async () => {
    const r = row();
    await hydrateWith([r]);
    db.results.push({ error: { code: 'PGRST205' } });
    await useModsStore.getState().setEnabled(r.id, true);
    expect(useModsStore.getState().available).toBe(false);
  });

  it('rename refuses a blank or overlong name without a call, and trims a good one', async () => {
    const r = row();
    await hydrateWith([r]);
    expect(await useModsStore.getState().rename(r.id, '   ')).toBe(false);
    expect(await useModsStore.getState().rename(r.id, 'x'.repeat(61))).toBe(false);
    expect(db.calls).toHaveLength(1);
    db.results.push({ error: null });
    expect(await useModsStore.getState().rename(r.id, '  Legs next ')).toBe(true);
    expect(opsOf(1)[0]).toEqual(['update', [{ name: 'Legs next' }]]);
    expect(useModsStore.getState().rows[0].name).toBe('Legs next');
  });

  it('remove deletes by id and user, and restores the row at its place on error', async () => {
    const a = row({ name: 'A', slug: 'a' });
    const b = row({ name: 'B', slug: 'b' });
    const c = row({ name: 'C', slug: 'c' });
    await hydrateWith([a, b, c]);
    db.results.push({ error: { code: '500' } });
    await useModsStore.getState().remove(b.id);
    expect(opsOf(1)).toEqual([
      ['delete', []],
      ['eq', ['id', b.id]],
      ['eq', ['user_id', USER]],
    ]);
    expect(useModsStore.getState().rows.map((r) => r.name)).toEqual(['A', 'B', 'C']);

    db.results.push({ error: null });
    await useModsStore.getState().remove(b.id);
    expect(useModsStore.getState().rows.map((r) => r.name)).toEqual(['A', 'C']);
  });

  it('turnAllOff switches off recipes and mods only, on the server and here', async () => {
    await hydrateWith([
      row({ kind: 'recipe', enabled: true, slug: 'r' }),
      row({ kind: 'mod', enabled: true, slug: 'm' }),
      row({ kind: 'theme', enabled: true, slug: 't' }),
    ]);
    db.results.push({ error: null });
    await useModsStore.getState().turnAllOff(USER);
    expect(opsOf(1)).toEqual([
      ['update', [{ enabled: false }]],
      ['eq', ['user_id', USER]],
      ['eq', ['enabled', true]],
      ['in', ['kind', ['recipe', 'mod']]],
    ]);
    expect(useModsStore.getState().rows.map((r) => [r.kind, r.enabled])).toEqual([
      ['recipe', false],
      ['mod', false],
      ['theme', true],
    ]);
  });

  it('turnAllOff rolls back only the rows it flipped, and a Delete in flight stands', async () => {
    const a = row({ kind: 'recipe', enabled: true, slug: 'a', name: 'A' });
    const b = row({ kind: 'mod', enabled: true, slug: 'b', name: 'B' });
    await hydrateWith([a, b]);
    let release!: () => void;
    db.gate = new Promise<void>((res) => (release = res));
    db.results.push({ error: { code: '500' } });
    const off = useModsStore.getState().turnAllOff(USER);
    db.gate = null;
    db.results.push({ error: null });
    await useModsStore.getState().remove(b.id);
    release();
    await off;
    expect(useModsStore.getState().rows.map((r) => [r.slug, r.enabled])).toEqual([['a', true]]);
  });

  it('reset keeps safeMode, which belongs to the tab', () => {
    useModsStore.setState({ safeMode: true, rows: [], loaded: true });
    useModsStore.getState().reset();
    expect(useModsStore.getState()).toMatchObject({ safeMode: true, loaded: false });
  });
});

describe('?safe-mode', () => {
  it('reads the flag with or without a value', () => {
    expect(hasSafeModeParam('?safe-mode')).toBe(true);
    expect(hasSafeModeParam('?a=1&safe-mode=')).toBe(true);
    expect(hasSafeModeParam('?safemode')).toBe(false);
    expect(hasSafeModeParam('')).toBe(false);
  });

  it('a tab loaded with ?safe-mode starts in safe mode', async () => {
    const before = window.location.href;
    window.history.replaceState({}, '', '/?safe-mode');
    try {
      vi.resetModules();
      const fresh = await import('@/lib/mods-store');
      expect(fresh.useModsStore.getState().safeMode).toBe(true);
    } finally {
      window.history.replaceState({}, '', before);
      vi.resetModules();
    }
  });
});
