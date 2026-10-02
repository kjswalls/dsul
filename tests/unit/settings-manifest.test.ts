import { afterEach, describe, it, expect, vi } from 'vitest';

// The manifest imports the stores, which import the Supabase client. Nothing
// here exercises a write path — these are structural assertions over data.
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

import {
  SETTINGS,
  DESTINATIONS,
  PANES,
  ALL_PANES,
  EXTENSION_PANES,
  settingById,
  settingsForPane,
  paneById,
  isPaneId,
  isExtensionPane,
  extensionPaneId,
  extensionSlugFromPane,
  railPaneFor,
  subPanesOf,
  displayValue,
  valueLabels,
  CONNECT_PANEL_RECORD_IDS,
  SHORTCUT_RECORDS,
  type SettingCtx,
} from '@/lib/settings/manifest';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import {
  seedAI,
  CONNECTED_MODEL,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
} from './helpers/ai-fixtures';
import { OFFICIAL_EXTENSIONS } from '@/lib/extension-registry';
import { EXTENSION_SETTINGS } from '@/lib/extension-settings';
import {
  searchSettings,
  paneRows,
  paneMatchCount,
  queryTerms,
  highlightRuns,
} from '@/lib/settings/search';
import { STATIC_COMMANDS } from '@/lib/commands/registry';
import type { CommandContext } from '@/lib/commands/types';

const ctx: SettingCtx = {
  theme: 'system',
  setTheme: () => {},
  userId: 'test-user',
};

describe('settings manifest — structure', () => {
  it('every id is unique', () => {
    const ids = SETTINGS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every id is dotted and stable-looking', () => {
    // Three shapes, all permanent — these ids are the deep links and the e2e
    // handles, so the point of this test is that they look DELIBERATE, not that
    // they are short.
    //
    //   pane.setting                      — a hand-written record.
    //   extensions.<slug>[.<field>]       — a record generated per extension in
    //                                       channelRecords(). The slug segment
    //                                       is the extension's own permanent
    //                                       slug, which is kebab-case by the
    //                                       user_extensions CHECK constraint,
    //                                       so hyphens are admitted HERE and
    //                                       nowhere else.
    //   keys.<shortcut_id>                — a record generated per binding in
    //                                       SHORTCUT_RECORDS. The second
    //                                       segment is the shortcut id
    //                                       VERBATIM, which is snake_case and
    //                                       frozen by commands.test.ts, so
    //                                       underscores are admitted here and
    //                                       nowhere else. Reusing that id
    //                                       rather than camel-casing it is the
    //                                       point: a transform would be a
    //                                       second name for the same binding,
    //                                       and `new_task` / `newTask` would
    //                                       collide on it.
    for (const s of SETTINGS) {
      expect(s.id, s.id).toMatch(
        /^[a-z]+\.[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9]*)?$|^keys\.[a-z][a-z0-9_]*$/
      );
    }
  });

  it('every record lands in a real pane', () => {
    for (const s of SETTINGS) {
      expect(isPaneId(s.pane), `${s.id} → ${s.pane}`).toBe(true);
    }
  });

  it('every pane has at least one record on EVERY platform — no empty rooms', () => {
    // Through the real filter, on both platforms. Asserting against raw
    // SETTINGS passed while the Keyboard pane — whose only record was
    // desktopOnly — was empty on every phone, with the rail still offering it.
    //
    // `extensions` is the one exemption and it is a deliberate one: it holds no
    // records because every extension switch moved into the extension's own
    // pane, and its body is the catalog index instead. The test below is what
    // stops that exemption from becoming "the extensions pane is empty" —
    // it asserts the index actually has something to list.
    for (const pane of ALL_PANES) {
      if (pane.id === 'extensions') continue;
      for (const isMobile of [false, true]) {
        const { rows, advanced } = paneRows(pane.id, { isMobile });
        expect(
          rows.length + advanced.length,
          `${pane.id} is empty (isMobile=${isMobile})`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('the extensions pane holds no records — its body is the index', () => {
    // A switch rendered both on the index and inside the extension would give
    // one permanent id two homes, and ?focus= plus every data-setting-row
    // selector would then have two candidates for it.
    expect(settingsForPane('extensions')).toHaveLength(0);
    expect(subPanesOf('extensions').length).toBeGreaterThan(0);
  });

  it('enum records declare options, and non-enums do not', () => {
    for (const s of SETTINGS) {
      if (s.control === 'enum') {
        expect(s.options?.length, `${s.id} has no options`).toBeGreaterThan(1);
      } else {
        expect(s.options, `${s.id} should not carry options`).toBeUndefined();
      }
    }
  });

  it('every enum default is one of its own option values', () => {
    for (const s of SETTINGS) {
      if (s.control !== 'enum') continue;
      const values = s.options!.map((o) => o.value);
      expect(values, `${s.id} default ${String(s.defaultValue)}`).toContain(String(s.defaultValue));
    }
  });

  it('every dependsOn points at a real record in the same pane', () => {
    for (const s of SETTINGS) {
      if (!s.dependsOn) continue;
      const parent = settingById(s.dependsOn);
      expect(parent, `${s.id} depends on missing ${s.dependsOn}`).toBeDefined();
      expect(parent!.pane, `${s.id} depends across panes`).toBe(s.pane);
    }
  });

  it('keywords are hand-authored, lowercase, and never just the label', () => {
    for (const s of SETTINGS) {
      expect(s.keywords.length, `${s.id} has no keywords`).toBeGreaterThan(2);
      for (const k of s.keywords) {
        expect(k, `${s.id}: "${k}"`).toBe(k.toLowerCase());
        expect(k.trim(), `${s.id} has a blank keyword`).not.toBe('');
      }
      expect(
        s.keywords.some((k) => k === s.label.toLowerCase()),
        `${s.id} duplicates its own label as a keyword`
      ).toBe(false);
    }
  });

  it('aliases are single lowercase words', () => {
    for (const s of SETTINGS) {
      for (const a of s.aliases ?? []) {
        expect(a, `${s.id}: "${a}"`).toMatch(/^[a-z0-9]+$/);
      }
    }
  });

  it('no record is both advanced and a dependent row', () => {
    // A dependent row that only appears behind a disclosure is two levels of
    // hiding for one control — the nesting the redesign exists to remove.
    for (const s of SETTINGS) {
      expect(!(s.advanced && s.dependsOn), `${s.id} is advanced AND dependent`).toBe(true);
    }
  });
});

describe('settings manifest — one pane per extension', () => {
  it('every catalog entry gets a pane, generated rather than declared', () => {
    // The point of the whole change: adding an extension is adding a manifest
    // entry and a field list, never a pane. If these two lists can differ, a
    // hand-written pane has crept in.
    expect(EXTENSION_PANES.map((p) => p.id)).toEqual(
      OFFICIAL_EXTENSIONS.map((e) => extensionPaneId(e.slug))
    );
    for (const pane of EXTENSION_PANES) {
      expect(pane.parent, `${pane.id} must hang off the Extensions rail row`).toBe('extensions');
    }
  });

  it('every extension pane has at least its own toggle in it', () => {
    // The "no empty rooms" rule, applied where a route can now be generated
    // from a catalog entry: a manifest entry with no settings record is an
    // extension nobody can switch on.
    for (const extension of OFFICIAL_EXTENSIONS) {
      const rows = settingsForPane(extensionPaneId(extension.slug));
      expect(rows.length, `${extension.slug} has no settings record`).toBeGreaterThan(0);
    }
  });

  it('every extension pane has exactly ONE switch of its own', () => {
    // The extension index finds the toggle by SHAPE — the one switch in the
    // pane that depends on nothing — because two of the eight ids predate the
    // slug convention and `extensions.${slug}` misses them. A second free
    // switch in a pane would make that lookup ambiguous and the index's state
    // chip arbitrary.
    for (const extension of OFFICIAL_EXTENSIONS) {
      const toggles = settingsForPane(extensionPaneId(extension.slug)).filter(
        (r) => r.control === 'switch' && !r.dependsOn
      );
      expect(toggles.map((t) => t.id), `${extension.slug} toggles`).toHaveLength(1);
    }
  });

  it('an extension pane holds ONLY that extension — one broken config, one pane', () => {
    // Isolation is the standing rule for channels and stake adapters, and the
    // panes have to keep it: every record in a sub-pane is prefixed with that
    // extension's own id, so nothing another extension declares can be read,
    // written or rendered from here.
    for (const spec of EXTENSION_SETTINGS) {
      const pane = extensionPaneId(spec.slug);
      for (const record of settingsForPane(pane)) {
        expect(
          record.id === `extensions.${spec.slug}` ||
            record.id.startsWith(`extensions.${spec.slug}.`),
          `${record.id} is rendered in ${pane}`
        ).toBe(true);
      }
    }
  });

  it('the sub-pane route is a real pane id and an unknown slug is not', () => {
    // isPaneId is the route's whole gate. ExtensionPaneId is an open template
    // literal type precisely because this runtime check is the closed half.
    expect(isPaneId('extensions')).toBe(true);
    expect(isPaneId('extensions/beeminder')).toBe(true);
    expect(isPaneId('extensions/not-a-real-extension')).toBe(false);
    expect(isPaneId('extensions/')).toBe(false);
  });

  it('the pane that predates sub-panes still resolves — old links keep working', () => {
    // The link that existed before sub-panes did. It has to land on the index,
    // not 404 and not silently fall back to Your day.
    expect(isPaneId('extensions')).toBe(true);
    expect(paneById('extensions')?.name).toBe('Extensions');
    expect(paneById('extensions')?.parent).toBeUndefined();
  });

  it('a sub-pane lights its parent rail row, and the rail stays one level', () => {
    expect(railPaneFor('extensions/beeminder')).toBe('extensions');
    expect(railPaneFor('look')).toBe('look');
    // PANES is the rail. No extension may appear in it.
    expect(PANES.some((p) => isExtensionPane(p.id))).toBe(false);
  });

  it('slug and pane id round-trip', () => {
    expect(extensionSlugFromPane(extensionPaneId('beeminder'))).toBe('beeminder');
    expect(extensionSlugFromPane('look')).toBeNull();
  });

  it('ALL_PANES reads parent-then-children, which is the result grouping order', () => {
    const ids = ALL_PANES.map((p) => p.id);
    const parentAt = ids.indexOf('extensions');
    expect(parentAt).toBeGreaterThan(-1);
    for (const pane of EXTENSION_PANES) {
      expect(ids.indexOf(pane.id), `${pane.id} is not under its parent`).toBeGreaterThan(parentAt);
    }
    // Contiguous — the block ends before the next rail entry begins.
    expect(ids.slice(parentAt + 1, parentAt + 1 + EXTENSION_PANES.length)).toEqual(
      EXTENSION_PANES.map((p) => p.id)
    );
  });
});

describe('settings manifest — persistence contract', () => {
  it('show_completed_tasks keeps the column name the e2e suite selects on', () => {
    // tests/e2e/settings.spec.ts reaches this switch through
    // data-setting="show_completed_tasks". Renaming it breaks the suite
    // silently — the switch is simply never found.
    const record = settingById('look.showCompleted');
    expect(record?.dbColumn).toBe('show_completed_tasks');
  });

  it('records that name a DB column use snake_case', () => {
    for (const s of SETTINGS) {
      if (!s.dbColumn) continue;
      expect(s.dbColumn, s.id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('device-local settings declare no DB column', () => {
    // view-store and ai-settings-store have no user_settings columns at all.
    // Naming one here would put an unknown key into the debounced upsert, and
    // PostgREST fails the ENTIRE patch with PGRST204 — dropping every other
    // setting batched into the same flush.
    const localOnly = [
      'look.typeface',
      'look.buckets',
      'look.markStyle',
      'look.showPaused',
      'beacon.provider',
      'beacon.instructions',
      'beacon.apiKey',
      'beacon.model',
    ];
    for (const id of localOnly) {
      expect(settingById(id)?.dbColumn, `${id} must not name a column`).toBeUndefined();
    }
  });
});

describe('settings manifest — no drift with the command palette', () => {
  it('manifest aliases never collide with a command alias', () => {
    // The palette's settings.* group is still hand-declared, and its aliases
    // are globally unique under an exhaustive test. This is what stops the two
    // surfaces growing into a conflict before they are unified.
    const commandCtx: CommandContext = {
      theme: { resolved: 'light', value: 'system', set: () => {} },
      openChat: () => {},
      userId: 'test-user',
      isMobile: false,
    };

    const commandAliases = new Set(
      STATIC_COMMANDS.flatMap((c) => [
        ...(c.aliases ?? []),
        // Enum commands flatten their option values into the SAME namespace
        // (/dark, /light, /system), so those count as claimed too.
        ...(c.argument?.kind === 'enum'
          ? c.argument.options(commandCtx).flatMap((o) => o.aliases ?? [])
          : []),
      ])
    );
    for (const s of SETTINGS) {
      for (const a of s.aliases ?? []) {
        expect(commandAliases.has(a), `alias "${a}" (${s.id}) is already a command alias`).toBe(
          false
        );
      }
    }
  });

  it('destination ids are unique and disjoint from setting ids', () => {
    const ids = DESTINATIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of DESTINATIONS) {
      expect(settingById(d.id), `${d.id} collides with a setting`).toBeUndefined();
    }
  });
});

describe('the credential boundary', () => {
  /* The generated secret records are the only ones whose displayed value is
     never their stored value: user_secrets has its grants revoked from
     `authenticated` and /api/reminders/secrets answers only WHICH keys are set.
     The word "secret" did not appear in this file before, and the row test next
     door builds its own hand-written record — so changing one of these `read`s
     to return the token passed every existing test in both. */

  // EVERY secret record, not just the generated ones. The old filter carved
  // out `beacon.apiKey`, a device-local key the user could read back; that key
  // is gone from the browser (it is sealed server-side now), so nothing earns
  // the carve-out and the gateway token is held to the same contract.
  const generatedSecrets = SETTINGS.filter((r) => r.textVariant === 'secret');

  it('covers every credential every extension declares, plus the gateway token', () => {
    // Anchors the tests below to the catalog rather than to a number: a new
    // channel with a new token is covered the day it is added.
    const declared = EXTENSION_SETTINGS.flatMap((spec) =>
      spec.secrets.map((field) => `extensions.${spec.slug}.${field.key}`)
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(generatedSecrets.map((r) => r.id).sort()).toEqual(
      [...declared, 'beacon.gatewayToken'].sort()
    );
  });

  it('never reads a value back — read() is empty whatever is stored', () => {
    for (const record of generatedSecrets) {
      expect(record.read(ctx), `${record.id} read() must be ''`).toBe('');
      expect(record.defaultValue, `${record.id} default`).toBe('');
    }
  });

  it('puts nothing indexable on a credential — the index cannot ingest a value', () => {
    // scoreRecord scores label, valueLabels, keywords, description and aliases.
    // valueLabels is derived from `options`, and a `text` control has none — so
    // a credential is structurally unable to reach the search index through its
    // value. Stated as a test so a stray `options` on one of these is caught.
    for (const record of generatedSecrets) {
      expect(record.control, record.id).toBe('text');
      expect(record.options, `${record.id} declares options`).toBeUndefined();
      expect(valueLabels(record), record.id).toEqual([]);
    }
  });
});

describe('the model key never reaches a record', () => {
  /* The model key is typed into the Connect-a-model panel, sent once, sealed
     server-side and never sent back. `beacon.apiKey` survives as an INFO record
     so search still finds it (its hit's "Set up" opens the panel) and deep
     links still land on the panel, and its read() is a status word. These pin that it can never become the key again. */

  const SENTINEL = 'sk-test-SENTINEL-9876';
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.unstubAllGlobals();
  });

  it('beacon.apiKey and beacon.model are info rows the panel owns', () => {
    for (const id of ['beacon.apiKey', 'beacon.model']) {
      const record = settingById(id)!;
      expect(record, id).toBeDefined();
      expect(record.control, id).toBe('info');
      expect(record.advanced, id).toBeFalsy();
      expect(record.textVariant, id).toBeUndefined();
      expect(record.placeholder, id).toBeUndefined();
      expect(CONNECT_PANEL_RECORD_IDS.has(id), id).toBe(true);
    }
    // In the pane's own records (search and the empty-room test read these)…
    const ids = paneRows('beacon').rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['beacon.apiKey', 'beacon.model']));
    // …and drawn by the panel, not as flat rows: the shell drops exactly these.
    const flat = paneRows('beacon').rows.filter((r) => !CONNECT_PANEL_RECORD_IDS.has(r.id));
    expect(flat.map((r) => r.id)).toEqual(['beacon.provider', 'beacon.instructions']);
  });

  it('beacon.apiKey reads only a status word, in every gate state', () => {
    const allowed = new Set([
      'Checking…',
      'Couldn’t check',
      'Not available on this server',
      'Not connected',
      'Stopped working',
      'Saved (OpenAI)',
      'Signed in (OpenRouter)',
    ]);
    const record = settingById('beacon.apiKey')!;
    const cases: [Parameters<typeof seedAI>[0], string][] = [
      [undefined, 'Checking…'],
      [{ phase: 'error' }, 'Couldn’t check'],
      [{ ...NOTHING_CONNECTED, available: false }, 'Not available on this server'],
      [NOTHING_CONNECTED, 'Not connected'],
      [CONNECTED_MODEL, 'Saved (OpenAI)'],
      [{ ...CONNECTED_MODEL, model: { provider: 'openrouter', authMethod: 'oauth' } }, 'Signed in (OpenRouter)'],
      [{ ...CONNECTED_MODEL, model: { status: 'failing', problem: 'key_rejected' } }, 'Stopped working'],
    ];
    for (const [seed, expected] of cases) {
      cleanup?.();
      cleanup = seedAI(seed);
      const value = record.read(ctx);
      expect(value, JSON.stringify(seed)).toBe(expected);
      expect(allowed.has(String(value))).toBe(true);
    }
  });

  it('no record reads back a key that was just connected', async () => {
    cleanup = seedAI(NOTHING_CONNECTED);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          connection: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            baseUrl: null,
            authMethod: 'key',
            status: 'ok',
            problem: null,
            checkedAt: '2026-10-01T00:00:00.000Z',
          },
          models: [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }],
          listed: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await useAIConnectionStore.getState().connect({ provider: 'openai', apiKey: SENTINEL });
    expect(result).toEqual({ ok: true });
    // The key did go out, once, in the PUT body…
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // …and nothing in the store or the manifest can answer with it.
    expect(JSON.stringify(useAIConnectionStore.getState())).not.toContain('SENTINEL');
    for (const record of SETTINGS) {
      let value: string | boolean = '';
      try {
        value = record.read(ctx);
      } catch {
        continue;
      }
      const shown = `${String(value)} ${displayValue(record, value)}`;
      expect(shown, record.id).not.toContain('SENTINEL');
      expect(shown, record.id).not.toContain('9876');
      const placeholder =
        typeof record.placeholder === 'function' ? record.placeholder(ctx) : record.placeholder;
      expect(placeholder ?? '', record.id).not.toContain('SENTINEL');
    }
    expect(settingById('beacon.apiKey')!.read(ctx)).toBe('Saved (OpenAI)');
    expect(settingById('beacon.model')!.read(ctx)).toBe('gpt-4o-mini');
  });

  it('no relabelled beacon.* record repeats its own label as a keyword', () => {
    // The structural rule above, named for these four: `beacon.apiKey` is
    // labelled "API key" now, and 'api key' was one of its old keywords.
    expect(settingById('beacon.apiKey')!.keywords).not.toContain('api key');
    for (const id of ['beacon.provider', 'beacon.instructions', 'beacon.apiKey', 'beacon.model']) {
      const record = settingById(id)!;
      expect(record.keywords, id).not.toContain(record.label.toLowerCase());
    }
  });
});

describe('the AI pane', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('is called AI, keeps its permanent id, and never says Beacon', () => {
    const pane = paneById('beacon')!;
    expect(pane.name).toBe('AI');
    expect(pane.blurb).toBe('Connect a model and choose who answers.');
    for (const record of settingsForPane('beacon')) {
      const copy = [
        record.label,
        record.description ?? '',
        ...(record.options ?? []).map((o) => o.label),
      ].join(' ');
      expect(copy, record.id).not.toMatch(/\bBeacon\b/);
    }
  });

  it('"Who answers in chat" offers the three choices and waits for the gate', () => {
    const record = settingById('beacon.provider')!;
    expect(record.label).toBe('Who answers in chat');
    expect(record.options!.map((o) => [o.value, o.label])).toEqual([
      ['model', 'Your model'],
      ['openclaw', 'OpenClaw'],
      ['none', 'Off'],
    ]);
    expect(record.defaultValue).toBe('model');
    expect(record.keywords).toContain('beacon');
    expect(record.advanced).toBeFalsy();

    cleanup = seedAI();
    expect(record.pending!(ctx)).toBe(true);
    expect(record.unavailable!(ctx)).toBeNull();

    cleanup();
    cleanup = seedAI(NOTHING_CONNECTED);
    expect(record.pending!(ctx)).toBe(false);
    expect(record.unavailable!(ctx)).toBe('Connect a model or OpenClaw first.');

    cleanup();
    cleanup = seedAI(CONNECTED_MODEL);
    expect(record.unavailable!(ctx)).toBeNull();

    cleanup();
    cleanup = seedAI(OPENCLAW_PLUGIN);
    expect(record.unavailable!(ctx)).toBeNull();
    expect(record.read(ctx)).toBe('openclaw');
  });

  it('the gateway rows are no longer gated on who answers', () => {
    // Choosing OpenClaw first, then configuring the gateway that makes it
    // usable, was a chicken-and-egg.
    cleanup = seedAI({ ...NOTHING_CONNECTED, choice: 'model' });
    for (const id of ['beacon.gatewayUrl', 'beacon.gatewayToken']) {
      const reason = settingById(id)!.unavailable?.(ctx) ?? null;
      expect(reason === null || /database update/.test(reason), `${id}: ${reason}`).toBe(true);
    }
  });

  it('the ⌘] row says when it works, and never holds its recorder back', () => {
    const record = SHORTCUT_RECORDS.find((r) => r.shortcutId === 'toggle_right_sidebar')!;
    expect(record).toBeDefined();
    // Said in the description, which is true in every state and locks nothing.
    expect(record.description).toContain('Works while a model or OpenClaw is connected.');

    // No binding is ever unavailable or pending: either one disables the row
    // (no recorder, no reset) while its chord still counts as taken in every
    // other row's conflict check. With nothing connected, that held ⌘] (or the
    // user's own chord for it) hostage. tests/unit/shortcut-records.test.tsx
    // renders it.
    for (const other of SHORTCUT_RECORDS) {
      expect(other.unavailable, other.id).toBeUndefined();
      expect(other.pending, other.id).toBeUndefined();
    }
  });
});

describe('settings search', () => {
  it('finds the model connection by the words people use for it', () => {
    for (const term of ['api key', 'openai', 'claude', 'gemini', 'openrouter', 'byok']) {
      const hits = searchSettings(term, ctx).settings.map((h) => h.record.id);
      expect(hits, term).toContain('beacon.apiKey');
    }
    expect(searchSettings('model', ctx).settings.map((h) => h.record.id)).toContain('beacon.model');
  });

  it('splits and lowercases the query — scoreText only lowercases the text', () => {
    expect(queryTerms('  Week  Start ')).toEqual(['week', 'start']);
  });

  it('finds a setting by its VALUE label, not just its own label', () => {
    // The most commonly forgotten field. "Sunday" is nowhere in the label
    // "Week starts on".
    const hits = searchSettings('sunday', ctx).settings.map((h) => h.record.id);
    expect(hits).toContain('day.weekStart');
  });

  it('finds a setting by the words you use when annoyed', () => {
    const hits = searchSettings('pile up', ctx).settings.map((h) => h.record.id);
    expect(hits).toContain('rituals.autoAge');
  });

  it('ANDs multiple terms across different fields', () => {
    // "week" comes from the label, "start" from the label too — but the pair
    // must not match records that only carry one of them.
    const hits = searchSettings('week starts', ctx).settings.map((h) => h.record.id);
    expect(hits).toContain('day.weekStart');
    expect(hits).not.toContain('look.theme');
  });

  it('a label hit outranks a description-only hit', () => {
    const { settings } = searchSettings('mode', ctx);
    expect(settings[0]?.record.id).toBe('look.theme');
  });

  it('"theme" finds the mode and both per-mode theme pickers', () => {
    const hits = searchSettings('theme', ctx).settings.map((h) => h.record.id);
    expect(hits).toEqual(expect.arrayContaining(['look.theme', 'look.lightTheme', 'look.darkTheme']));
  });

  it('excludes advanced rows unless asked', () => {
    const plain = searchSettings('resize', ctx).settings.map((h) => h.record.id);
    expect(plain).not.toContain('look.markStyle');

    const withAdv = searchSettings('resize', ctx, { includeAdvanced: true }).settings.map(
      (h) => h.record.id
    );
    expect(withAdv).toContain('look.markStyle');
  });

  it('does not index desktop-only rows on mobile', () => {
    // A result that deep-links to a row which will never render is
    // indistinguishable from a bug.
    const hits = searchSettings('sidebar', ctx, {
      includeAdvanced: true,
      isMobile: true,
    }).settings.map((h) => h.record.id);
    expect(hits).not.toContain('look.sidebarHover');
  });

  it('surfaces destinations for configuration that lives elsewhere', () => {
    // The whole reason the rail can stay at six panes.
    const { destinations } = searchSettings('season', ctx);
    expect(destinations.map((d) => d.record.id)).toContain('dest.seasons');
  });

  it('the per-pane counts add up and name only panes that actually have hits', () => {
    // NOT `total === settings.length` — search.ts builds both from the same
    // array, so that assertion can never fail. `counts` is the field with a
    // consumer: the RESULTS LIST groups by exactly these keys, so a pane in
    // `counts` with no hits, or hits under a key nothing groups on, is a row
    // that is counted and never drawn. (The rail stopped reading `counts`
    // directly when extensions got sub-panes — it goes through paneMatchCount
    // now, whose own invariant is the next test.)
    const result = searchSettings('time', ctx);
    expect(result.settings.length).toBeGreaterThan(0);
    expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(result.total);
    for (const [pane, n] of Object.entries(result.counts)) {
      expect(n, `${pane} is in counts with zero hits`).toBeGreaterThan(0);
      expect(result.settings.some((h) => h.record.pane === pane)).toBe(true);
    }
  });

  it('the rail rollup accounts for every hit exactly once', () => {
    // The rail is one level, so the number on Extensions has to be every hit
    // in every extension's own pane and no hit twice. Over-count and the rail
    // promises rows the list cannot produce; under-count (which is what
    // reading `counts` directly did) and it dims the only route to a result.
    for (const query of ['time', 'beeminder', 'token', 'week']) {
      const result = searchSettings(query, ctx, { includeAdvanced: true });
      const railed = PANES.reduce((sum, p) => sum + paneMatchCount(result, p.id), 0);
      expect(railed, `${query}: rail total`).toBe(result.total);
    }
  });

  it('an advanced row can still be reached by typing its exact label', () => {
    // The escape hatch: `terms` is split on whitespace, so comparing against
    // terms[0] made this unreachable for every multi-word advanced label.
    const hits = searchSettings('schedule handles', ctx).settings.map((h) => h.record.id);
    expect(hits).toContain('look.markStyle');
  });

  it('names the value that actually matched, including on the reverse-word tier', () => {
    // 'mondays' matches the option 'Monday' only through scoreText's
    // reverse-word tier, where a plain includes() is false — which is exactly
    // the case the "matches: …" subline exists to explain.
    const hit = searchSettings('mondays', ctx).settings.find(
      (h) => h.record.id === 'day.weekStart'
    );
    expect(hit).toBeDefined();
    expect(hit!.matchedValue).toBe('Monday');
  });

  it('does not explain a value that is already the one on screen', () => {
    // The stored default is Sunday, so surfacing "matches: Sunday" would be
    // noise next to a chip already reading Sunday.
    const hit = searchSettings('sundays', ctx).settings.find(
      (h) => h.record.id === 'day.weekStart'
    );
    expect(hit).toBeDefined();
    expect(hit!.matchedValue).toBeUndefined();
  });

  it('tolerates a transposition, which is the most common typo there is', () => {
    // Typos match labels: "Light theme" is the label one edit away.
    const result = searchSettings('thmee', ctx);
    expect(result.didYouMean).toBe(true);
    expect(result.settings.map((h) => h.record.id)).toContain('look.lightTheme');
  });

  it('returns nothing for a query that means nothing here', () => {
    const result = searchSettings('quiet hours', ctx);
    expect(result.settings).toHaveLength(0);
    expect(result.destinations).toHaveLength(0);
  });

  it('falls back to one-edit matches ONLY when the strict pass is empty', () => {
    const typo = searchSettings('thene', ctx);
    expect(typo.didYouMean).toBe(true);
    expect(typo.settings.map((h) => h.record.id)).toContain('look.lightTheme');

    // …and never interleaves them into a list that already has strict hits.
    expect(searchSettings('theme', ctx).didYouMean).toBe(false);
  });

  it('an empty query is not a search', () => {
    expect(searchSettings('   ', ctx).total).toBe(0);
  });

  /* ── Settings that live one level down ──────────────────────────────────
     Search is the thing most likely to break silently when a record moves
     into a sub-pane: nothing throws, the row simply stops being findable, or
     is found and then rendered under a group nobody prints. These four are
     the whole contract. */

  it('finds a setting that lives inside an extension sub-pane', () => {
    // "twilio" is nowhere in the label "Account SID" — the channel's keyword
    // is what carries it, and the record now sits at extensions/sms-nudge.
    const hits = searchSettings('twilio', ctx, { includeAdvanced: true }).settings;
    const hit = hits.find((h) => h.record.id === 'extensions.sms-nudge.accountSid');
    expect(hit).toBeDefined();
    expect(hit!.record.pane).toBe(extensionPaneId('sms-nudge'));
  });

  it('counts a sub-pane hit under the sub-pane, and rolls it up for the rail', () => {
    // `counts` stays keyed by the pane a record actually lives in — the
    // results list groups by exactly those keys, and the existing "counts add
    // up" test depends on it. The rail is the only consumer that needs the
    // rollup, and paneMatchCount is the only place it happens.
    const result = searchSettings('beeminder', ctx, { includeAdvanced: true });
    const pane = extensionPaneId('beeminder');
    expect(result.counts[pane], 'sub-pane hits are counted under the sub-pane').toBeGreaterThan(0);
    expect(result.counts['extensions'] ?? 0).toBe(0);
    expect(paneMatchCount(result, 'extensions')).toBeGreaterThanOrEqual(result.counts[pane]);
    // …and the rollup never invents hits for a pane that has none.
    expect(paneMatchCount(searchSettings('sunday', ctx), 'extensions')).toBe(0);
  });

  it('every hit is renderable — its pane is a real one that groups print', () => {
    // The silent failure this guards: a record whose pane has no group in the
    // results list is counted, scrolls the count up, and never appears.
    const groupable = new Set(ALL_PANES.map((p) => p.id));
    for (const query of ['twilio', 'beeminder', 'webhook', 'speaker']) {
      for (const hit of searchSettings(query, ctx, { includeAdvanced: true }).settings) {
        expect(groupable.has(hit.record.pane), `${hit.record.id} → ${hit.record.pane}`).toBe(true);
      }
    }
  });

  it('a sub-pane record deep-links to its own pane, not the index', () => {
    // The ?focus= contract: the shell scrolls to the row on the pane it was
    // sent to, so a link built from record.pane has to name the sub-pane. A
    // stale `extensions` here would open the index and quietly focus nothing.
    const record = settingById('extensions.beeminder.username')!;
    expect(record.pane).toBe(extensionPaneId('beeminder'));
    expect(paneRows(record.pane).rows.map((r) => r.id)).toContain(record.id);
    expect(paneRows('extensions').rows).toHaveLength(0);
  });
});

describe('highlighting', () => {
  it('slices ranges rather than replacing text', () => {
    const runs = highlightRuns('Week starts on', [[0, 4]]);
    expect(runs).toEqual([
      { text: 'Week', hit: true },
      { text: ' starts on', hit: false },
    ]);
  });

  it('merges overlapping ranges from multiple terms', () => {
    const runs = highlightRuns('Time format', [
      [0, 4],
      [2, 6],
    ]);
    expect(runs.filter((r) => r.hit)).toHaveLength(1);
    expect(runs.map((r) => r.text).join('')).toBe('Time format');
  });

  it('never drops characters', () => {
    for (const s of SETTINGS) {
      const runs = highlightRuns(s.label, [[1, 3]]);
      expect(runs.map((r) => r.text).join(''), s.id).toBe(s.label);
    }
  });
});

describe('value display', () => {
  it('renders an enum by its label, not its stored value', () => {
    const record = settingById('look.buckets')!;
    // The stored value stays 'spine' forever — renaming it to match the label
    // would reset every user's choice.
    expect(displayValue(record, 'spine')).toBe('Floating card');
  });

  it('renders a switch as On/Off', () => {
    const record = settingById('look.showCompleted')!;
    expect(displayValue(record, true)).toBe('On');
    expect(displayValue(record, false)).toBe('Off');
  });

  it('exposes every value label to the index', () => {
    expect(valueLabels(settingById('day.timeFormat')!)).toEqual(['12-hour', '24-hour']);
  });
});

describe('the push row in the desktop app', () => {
  // A browser's push state, supported and not yet asked: the row is live.
  const push: NonNullable<SettingCtx['push']> = {
    isSupported: true,
    isSubscribed: false,
    permissionState: 'default',
    subscribe: async () => {},
    unsubscribe: async () => {},
  };
  const record = settingById('rituals.push')!;
  const DESKTOP_COPY =
    'not available in the desktop app yet — turn push on from your phone or browser';

  afterEach(() => {
    delete window.dsulDesktop;
  });

  const installBridge = () => {
    window.dsulDesktop = {
      version: 1,
      shellVersion: '0.1.0',
      electronVersion: '44.5.1',
      platform: 'win32',
      onQuickCapture: () => () => {},
      openAuthUrl: async () => true,
      armEmailSignIn: async () => {},
      takeSignInNotice: async () => false,
    };
  };

  it('is available in a browser that supports push', () => {
    expect(record.unavailable?.({ ...ctx, push })).toBeNull();
  });

  it('says so in the desktop app, where subscribe() would only fail', () => {
    installBridge();
    expect(record.unavailable?.({ ...ctx, push })).toBe(DESKTOP_COPY);
  });

  it('keeps its no-push-state answer ahead of the desktop one', () => {
    // The desktop line sits right after the `!ctx.push` check, so a caller
    // with no push state to give still gets the answer it always got.
    installBridge();
    expect(record.unavailable?.(ctx)).toBeNull();
  });
});

describe('settings manifest — layout and its style', () => {
  // userId null: the writes stop at the store, never reaching saveSettings.
  const local: SettingCtx = { ...ctx, userId: null };
  const layout = () => settingById('look.layout')!;
  const style = () => settingById('look.layoutStyle')!;

  afterEach(async () => {
    const { useLookStore } = await import('@/lib/look-store');
    useLookStore.getState().setLayout('classic');
  });

  it('Layout lists one entry per family, and Style the styles', () => {
    expect(layout().options?.map((o) => o.value)).toEqual(['classic', 'console', 'notebook', 'notepad']);
    expect(style().options?.map((o) => o.label)).toEqual(['Quiet', 'Markdown', 'Retro']);
  });

  it('a style is kept when its family is picked again, and dropped for another family', async () => {
    const { useLookStore } = await import('@/lib/look-store');
    layout().write('notepad', local);
    expect(style().unavailable?.(local)).toBeNull();
    style().write('notepad-retro', local);
    expect(useLookStore.getState().layout).toBe('notepad-retro');
    expect(layout().read(local)).toBe('notepad');

    layout().write('notepad', local);
    expect(useLookStore.getState().layout).toBe('notepad-retro');

    layout().write('console', local);
    expect(useLookStore.getState().layout).toBe('console');
    expect(style().unavailable?.(local)).toMatch(/Only Notepad/);
  });
});
