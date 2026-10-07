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
      for (const op of ['select', 'eq', 'in', 'order', 'update', 'delete', 'insert', 'maybeSingle']) {
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

import { useModsStore, hasSafeModeParam, slugFromName, uniqueSlug } from '@/lib/mods-store';

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

describe('recipes', () => {
  const manifest = { version: 1 as const, trigger: { on: 'command' as const }, filters: {}, steps: [{ do: 'toast' as const, text: 'Hi' }] };

  it('slugs follow 061: a letter first, [a-z0-9-], at most 30', () => {
    expect(slugFromName('After my run!')).toBe('after-my-run');
    expect(slugFromName('Résumé')).toBe('resume');
    expect(slugFromName('123 go')).toBe('go');
    expect(slugFromName('!!!')).toBe('recipe');
    expect(slugFromName('a'.repeat(40))).toHaveLength(30);
    expect(uniqueSlug('a', new Set(['a', 'a-2']))).toBe('a-3');
    expect(uniqueSlug('x'.repeat(30), new Set(['x'.repeat(30)]))).toBe(`${'x'.repeat(28)}-2`);
  });

  it('createRecipe inserts 061\'s columns, switched off, with a slug no kind uses', async () => {
    await hydrateWith([row({ kind: 'theme', slug: 'legs', name: 'Legs' })]);
    db.results.push({ error: null });
    const r = await useModsStore.getState().createRecipe(USER, { name: ' Legs ', manifest });
    expect(r.ok).toBe(true);
    const [op, args] = opsOf(1)[0];
    expect(op).toBe('insert');
    expect(args[0]).toEqual({
      id: (r as { id: string }).id,
      user_id: USER,
      kind: 'recipe',
      slug: 'legs-2',
      name: 'Legs',
      enabled: false,
      manifest,
    });
    expect(useModsStore.getState().rows.find((x) => x.kind === 'recipe')).toMatchObject({ slug: 'legs-2', enabled: false });
  });

  it('createRecipe takes the next suffix on a unique clash', async () => {
    await hydrateWith([]);
    db.results.push({ error: { code: '23505', message: 'duplicate' } }, { error: null });
    const r = await useModsStore.getState().createRecipe(USER, { name: 'Legs', manifest });
    expect(r.ok).toBe(true);
    expect((opsOf(1)[0][1][0] as { slug: string }).slug).toBe('legs');
    expect((opsOf(2)[0][1][0] as { slug: string }).slug).toBe('legs-2');
    expect(useModsStore.getState().rows).toHaveLength(1);
  });

  it('createRecipe refuses a bad name and drops the row when the insert fails', async () => {
    await hydrateWith([]);
    expect(await useModsStore.getState().createRecipe(USER, { name: '  ', manifest })).toEqual({ ok: false, reason: 'Give it a name.' });
    db.results.push({ error: { code: '500', message: 'boom' } });
    const r = await useModsStore.getState().createRecipe(USER, { name: 'Legs', manifest });
    expect(r.ok).toBe(false);
    expect(useModsStore.getState().rows).toEqual([]);
  });

  const themeManifest = { version: 1 as const, mode: 'light' as const, base: 'paper' as const, tokens: { paper0: '#fafafa' } };

  it('createTheme saves switched off, its slug from its id, and mints a new id on a clash', async () => {
    await hydrateWith([]);
    db.results.push({ error: { code: '23505', message: 'duplicate' } }, { error: null });
    const r = await useModsStore.getState().createTheme(USER, { name: 'Moss', manifest: themeManifest });
    expect(r.ok).toBe(true);
    const first = opsOf(1)[0][1][0] as { id: string; slug: string; kind: string; enabled: boolean };
    const second = opsOf(2)[0][1][0] as { id: string; slug: string; kind: string; enabled: boolean };
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ kind: 'theme', enabled: false, id: (r as { id: string }).id });
    expect(second.slug).toBe(`u-${second.id.replace(/-/g, '').slice(0, 8)}`);
    expect(useModsStore.getState().rows).toHaveLength(1);
  });

  it('createTheme refuses a manifest the grammar refuses', async () => {
    await hydrateWith([]);
    const bad = { ...themeManifest, tokens: { paper0: 'url(x)' } };
    expect(await useModsStore.getState().createTheme(USER, { name: 'Moss', manifest: bad })).toEqual({
      ok: false,
      reason: 'Something in it is not valid.',
    });
  });

  it('saveTheme keeps a switched-on theme on', async () => {
    const existing = row({ kind: 'theme', slug: 'u-aaaaaaaa', name: 'Moss', enabled: true, manifest: themeManifest });
    await hydrateWith([existing]);
    db.results.push({ error: null });
    const next = { ...themeManifest, tokens: { paper0: '#000000' } };
    expect(await useModsStore.getState().saveTheme(existing.id, { name: 'Moss', manifest: next })).toBe(true);
    expect(opsOf(1)[0]).toEqual(['update', [{ name: 'Moss', manifest: next }]]);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: true, manifest: next });
  });

  it('createTheme never mints the preview slug', async () => {
    await hydrateWith([]);
    const spy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-1111-4111-8111-111111111111')
      .mockReturnValueOnce('abcdef01-1111-4111-8111-111111111111');
    db.results.push({ error: null });
    const r = await useModsStore.getState().createTheme(USER, { name: 'Moss', manifest: themeManifest });
    spy.mockRestore();
    expect(r).toEqual({ ok: true, id: 'abcdef01-1111-4111-8111-111111111111' });
    expect(opsOf(1)[0][1][0]).toMatchObject({ slug: 'u-abcdef01' });
  });

  it('saveTheme refuses to switch a theme between light and dark', async () => {
    const existing = row({ kind: 'theme', slug: 'u-aaaaaaaa', name: 'Moss', enabled: true, manifest: themeManifest });
    await hydrateWith([existing]);
    const dark = { version: 1 as const, mode: 'dark' as const, base: 'night' as const, tokens: {} };
    expect(await useModsStore.getState().saveTheme(existing.id, { name: 'Moss', manifest: dark })).toBe(false);
    expect(useModsStore.getState().rows[0]).toMatchObject({ manifest: themeManifest });
  });

  const lookManifest = { version: 1 as const, layout: 'notebook' as const, light: 'paper' as const, dark: 'dusk' as const };

  it('createLook saves switched off, its slug from its id, and mints a new id on a clash', async () => {
    await hydrateWith([]);
    db.results.push({ error: { code: '23505', message: 'duplicate' } }, { error: null });
    const r = await useModsStore.getState().createLook(USER, { name: 'Deep work', manifest: lookManifest });
    expect(r.ok).toBe(true);
    const first = opsOf(1)[0][1][0] as { id: string };
    const second = opsOf(2)[0][1][0] as { id: string; slug: string; kind: string; enabled: boolean; manifest: unknown };
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ kind: 'look', enabled: false, manifest: lookManifest, id: (r as { id: string }).id });
    expect(second.slug).toBe(`u-${second.id.replace(/-/g, '').slice(0, 8)}`);
    expect(useModsStore.getState().rows).toHaveLength(1);
  });

  it('createLook refuses a remix or a label', async () => {
    await hydrateWith([]);
    for (const bad of [{ ...lookManifest, layout: 'mine' }, { ...lookManifest, label: 'x' }]) {
      expect(
        await useModsStore.getState().createLook(USER, { name: 'Deep work', manifest: bad as unknown as typeof lookManifest })
      ).toEqual({ ok: false, reason: 'Something in it is not valid.' });
    }
    expect(db.calls).toHaveLength(1);
  });

  it('saveLook keeps a switched-on Look on', async () => {
    const existing = row({ kind: 'look', slug: 'u-aaaaaaaa', name: 'Deep work', enabled: true, manifest: lookManifest });
    await hydrateWith([existing]);
    db.results.push({ error: null });
    const next = { ...lookManifest, layout: 'writer' as const };
    expect(await useModsStore.getState().saveLook(existing.id, { name: 'Deep work', manifest: next })).toBe(true);
    expect(opsOf(1)[0]).toEqual(['update', [{ name: 'Deep work', manifest: next }]]);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: true, manifest: next });
  });

  it('saveRecipe: a rename alone leaves a switched-on recipe on', async () => {
    // Read back from jsonb, so its keys come in another order than the form's.
    const stored = { filters: {}, steps: [{ text: 'Hi', do: 'toast' }], trigger: { on: 'command' }, version: 1 };
    const existing = row({ slug: 'a', name: 'A', enabled: true, manifest: stored });
    await hydrateWith([existing]);
    db.results.push({ error: null });
    expect(await useModsStore.getState().saveRecipe(existing.id, { name: 'B', manifest })).toBe(true);
    expect(opsOf(1)[0]).toEqual(['update', [{ name: 'B', manifest }]]);
    expect(useModsStore.getState().rows[0]).toMatchObject({ name: 'B', enabled: true, manifest });
  });

  it('saveRecipe: a changed manifest saves a switched-on recipe off, and a failed save puts it back', async () => {
    const existing = row({ slug: 'a', name: 'A', enabled: true, manifest });
    await hydrateWith([existing]);
    const changed = { ...manifest, steps: [{ do: 'toast' as const, text: 'Bye' }] };
    db.results.push({ error: null });
    expect(await useModsStore.getState().saveRecipe(existing.id, { name: 'A', manifest: changed })).toBe(true);
    expect(opsOf(1)[0]).toEqual(['update', [{ name: 'A', manifest: changed, enabled: false }]]);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: false, manifest: changed });

    useModsStore.setState((st) => ({ rows: st.rows.map((r) => ({ ...r, enabled: true, manifest })) }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.results.push({ error: { code: '500', message: 'boom' } });
    expect(await useModsStore.getState().saveRecipe(existing.id, { name: 'A', manifest: changed })).toBe(false);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: true, manifest });
    err.mockRestore();
  });

  it('disable switches off with a reason, capped at 200', async () => {
    const existing = row({ enabled: true });
    await hydrateWith([existing]);
    db.results.push({ error: null });
    await useModsStore.getState().disable(existing.id, 'x'.repeat(300));
    expect(opsOf(1)[0]).toEqual(['update', [{ enabled: false, disabled_reason: 'x'.repeat(200) }]]);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: false, disabledReason: 'x'.repeat(200) });
  });
});

describe('refresh', () => {
  it('reads the list again past hydrate’s guard, and takes what changed', async () => {
    const r = row({ kind: 'mod', slug: 'water', name: 'Water', enabled: true });
    await hydrateWith([r]);
    db.results.push({ data: [{ ...r, enabled: false, disabled_reason: 'off elsewhere' }], error: null });
    await useModsStore.getState().refresh(USER);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: false, disabledReason: 'off elsewhere' });
  });

  it('keeps the same rows when nothing changed', async () => {
    const r = row({ kind: 'mod', slug: 'water', name: 'Water' });
    await hydrateWith([r]);
    const before = useModsStore.getState().rows;
    db.results.push({ data: [r], error: null });
    await useModsStore.getState().refresh(USER);
    expect(useModsStore.getState().rows).toBe(before);
  });

  it('drops an answer when a local write started after the select went out', async () => {
    const r = row({ kind: 'mod', slug: 'water', name: 'Water', enabled: false });
    await hydrateWith([r]);
    let release!: () => void;
    db.gate = new Promise<void>((resolve) => (release = resolve));
    db.results.push({ data: [{ ...r, name: 'Stale' }], error: null });
    const refreshing = useModsStore.getState().refresh(USER);
    db.gate = null;
    await useModsStore.getState().setEnabled(r.id, true);
    release();
    await refreshing;
    expect(useModsStore.getState().rows[0]).toMatchObject({ name: 'Water', enabled: true });
  });

  it('does nothing for another account, or before the list loaded', async () => {
    await useModsStore.getState().refresh(USER);
    expect(db.calls).toEqual([]);
    await hydrateWith([]);
    await useModsStore.getState().refresh(OTHER);
    expect(db.calls).toHaveLength(1);
  });
});

describe('loadModCode', () => {
  it('selects one mod’s source, store, manifest and updated_at, as its owner', async () => {
    const r = row({ kind: 'mod', slug: 'water', name: 'Water' });
    await hydrateWith([r]);
    db.results.push({
      data: { source: 'export function register() {}', store: { n: 1 }, manifest: { version: 1, uses: [] }, updated_at: 'u' },
      error: null,
    });
    expect(await useModsStore.getState().loadModCode(r.id)).toEqual({
      source: 'export function register() {}',
      store: { n: 1 },
      manifest: { version: 1, uses: [] },
      updatedAt: 'u',
    });
    expect(opsOf(1)).toEqual([
      ['select', ['source,store,manifest,updated_at']],
      ['eq', ['id', r.id]],
      ['eq', ['user_id', USER]],
      ['eq', ['kind', 'mod']],
      ['maybeSingle', []],
    ]);
  });

  it('is null for a row with no source, or a failed read', async () => {
    await hydrateWith([]);
    db.results.push({ data: { source: null, store: {}, manifest: {}, updated_at: 'u' }, error: null });
    expect(await useModsStore.getState().loadModCode(USER)).toBeNull();
    db.results.push({ data: null, error: { code: 'XX000' } });
    expect(await useModsStore.getState().loadModCode(USER)).toBeNull();
  });
});

describe('mods (build order 8)', () => {
  const SOURCE = 'export const manifest = { version: 1, uses: [] };\nexport function register(on) {}';
  const manifest = { version: 1 as const, uses: ['storage' as const], commands: [] };

  it('slugs fall back to the kind’s own word', () => {
    expect(slugFromName('Вода', 'mod')).toBe('mod');
    expect(slugFromName('Water', 'mod')).toBe('water');
  });

  it('createMod sends the source, switched off, with a slug no kind uses', async () => {
    await hydrateWith([row({ kind: 'recipe', slug: 'water', name: 'Water' })]);
    db.results.push({ error: null });
    const r = await useModsStore.getState().createMod(USER, { name: 'Water', source: SOURCE, manifest });
    expect(r.ok).toBe(true);
    const [op, args] = opsOf(1)[0];
    expect(op).toBe('insert');
    expect(args[0]).toEqual({
      id: (r as { id: string }).id,
      user_id: USER,
      kind: 'mod',
      slug: 'water-2',
      name: 'Water',
      enabled: false,
      manifest,
      source: SOURCE,
    });
  });

  it('createMod refuses a name under the label rule, an invalid manifest and code over 64KB, with no call', async () => {
    await hydrateWith([]);
    const store = useModsStore.getState();
    expect((await store.createMod(USER, { name: 'Sign in', source: SOURCE, manifest })).ok).toBe(false);
    expect(
      (await store.createMod(USER, { name: 'Water', source: SOURCE, manifest: { ...manifest, panels: [] } as never })).ok
    ).toBe(false);
    expect((await store.createMod(USER, { name: 'Water', source: 'x'.repeat(65537), manifest })).ok).toBe(false);
    expect(db.calls).toHaveLength(1);
  });

  it('saveMod keeps a switched-on mod on when its uses do not widen', async () => {
    const existing = row({ kind: 'mod', slug: 'water', name: 'Water', enabled: true, manifest: { version: 1, uses: ['storage', 'ui'] } });
    await hydrateWith([existing]);
    db.results.push({ data: [{ updated_at: '2026-10-08T00:00:00Z' }], error: null });
    const r = await useModsStore.getState().saveMod(existing.id, { name: 'Water', source: SOURCE, manifest });
    expect(r).toEqual({ ok: true, switchedOff: false });
    expect(opsOf(1)).toEqual([
      ['update', [{ name: 'Water', manifest, source: SOURCE }]],
      ['eq', ['id', existing.id]],
      ['eq', ['user_id', USER]],
      ['select', ['updated_at']],
    ]);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: true, updatedAt: '2026-10-08T00:00:00Z' });
  });

  it('saveMod switches a mod off when its uses widen, and a failed save puts it back', async () => {
    const existing = row({ kind: 'mod', slug: 'water', name: 'Water', enabled: true, manifest: { version: 1, uses: [] } });
    await hydrateWith([existing]);
    db.results.push({ data: [{ updated_at: 'u2' }], error: null });
    expect(await useModsStore.getState().saveMod(existing.id, { name: 'Water', source: SOURCE, manifest })).toEqual({
      ok: true,
      switchedOff: true,
    });
    expect(opsOf(1)[0]).toEqual(['update', [{ name: 'Water', manifest, enabled: false, source: SOURCE }]]);
    expect(useModsStore.getState().rows[0].enabled).toBe(false);

    useModsStore.setState((st) => ({ rows: st.rows.map((r) => ({ ...r, enabled: true, manifest: { version: 1, uses: [] } })) }));
    db.results.push({ data: null, error: { code: '500', message: 'boom' } });
    expect((await useModsStore.getState().saveMod(existing.id, { name: 'Water', source: SOURCE, manifest })).ok).toBe(false);
    expect(useModsStore.getState().rows[0]).toMatchObject({ enabled: true, manifest: { version: 1, uses: [] } });
  });

  it('rename of a mod refuses "Sign in" with no call; a recipe may still be called that', async () => {
    const mod = row({ kind: 'mod', slug: 'water', name: 'Water' });
    const recipe = row({ kind: 'recipe', slug: 'a', name: 'A' });
    await hydrateWith([mod, recipe]);
    expect(await useModsStore.getState().rename(mod.id, 'Sign in')).toBe(false);
    expect(db.calls).toHaveLength(1);
    db.results.push({ error: null });
    expect(await useModsStore.getState().rename(recipe.id, 'Sign in')).toBe(true);
  });

  it('turnAllOff still includes mods', async () => {
    await hydrateWith([row({ kind: 'mod', slug: 'water', enabled: true })]);
    db.results.push({ error: null });
    await useModsStore.getState().turnAllOff(USER);
    expect(opsOf(1)).toContainEqual(['in', ['kind', ['recipe', 'mod']]]);
    expect(useModsStore.getState().rows[0].enabled).toBe(false);
  });
});
