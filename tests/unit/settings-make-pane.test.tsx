import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Settings → Make (components/settings/make-pane.tsx) rendered: the empty
 * state, a section per kind, the switch, Delete through the shared confirm,
 * safe mode, the missing-migration copy, and the pane inside the real shell
 * and its search.
 */

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));
vi.mock('@/lib/settings-service', () => ({
  saveSettings: vi.fn(async () => {}),
  flushSettings: vi.fn(async () => {}),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/make',
  useSearchParams: () => new URLSearchParams(),
}));

const sandbox = vi.hoisted(() => ({
  scratch: vi.fn(),
  status: vi.fn(() => 'idle'),
}));
vi.mock('@/lib/mods/sandbox-host', () => ({ modSandbox: sandbox }));
const faults = vi.hoisted(() => ({ fetchRecentFaults: vi.fn(async () => [] as unknown[]) }));
vi.mock('@/lib/mods/faults-log', () => faults);
const runtime = vi.hoisted(() => ({ saved: vi.fn() }));
vi.mock('@/lib/mods/runtime-manager', () => ({ activeModRuntime: () => runtime }));

import { MakePane } from '@/components/settings/make-pane';
import { SettingsShell } from '@/components/settings/settings-shell';
import { useModsStore } from '@/lib/mods-store';
import { useUIStore } from '@/lib/ui-store';
import type { UserMod } from '@/lib/mods/schema';
import type { SettingCtx } from '@/lib/settings/manifest';
import { useLookStore } from '@/lib/look-store';
import { saveSettings } from '@/lib/settings-service';
import { ModEditor, panelsInWords } from '@/components/settings/mod-editor';

const USER = 'test-user';
const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: USER };

function mod(over: Partial<UserMod>): UserMod {
  return {
    id: crypto.randomUUID(),
    userId: USER,
    kind: 'recipe',
    slug: 'a',
    name: 'A',
    enabled: false,
    manifest: {},
    disabledReason: null,
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    ...over,
  };
}

function seed(state: Partial<ReturnType<typeof useModsStore.getState>>) {
  // hydratedUserId matches ctx, so the pane's hydrate returns at once.
  useModsStore.setState({ available: true, loaded: true, rows: [], safeMode: false, hydratedUserId: USER, ...state });
}

const ACTIONS = {
  setEnabled: useModsStore.getState().setEnabled,
  remove: useModsStore.getState().remove,
  hydrate: useModsStore.getState().hydrate,
  createMod: useModsStore.getState().createMod,
  saveMod: useModsStore.getState().saveMod,
  loadModCode: useModsStore.getState().loadModCode,
  setModSettings: useModsStore.getState().setModSettings,
};

beforeEach(() => {
  useModsStore.setState(ACTIONS);
  useModsStore.getState().reset();
  useUIStore.setState({ confirmRequest: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MakePane', () => {
  it('explains Make when nothing is made yet', () => {
    seed({});
    render(<MakePane ctx={ctx} />);
    const empty = screen.getByTestId('make-empty');
    expect(empty.textContent).toContain('Nothing made yet');
    expect(empty.textContent).not.toContain('coming soon');
    // Recipes can be made now (PR 4).
    expect(screen.getByTestId('make-new-recipe').textContent).toContain('New recipe');
    expect(screen.queryByTestId('make-safe-mode')).toBeNull();
  });

  it('draws one section per kind it has, in kind order, and none for the rest', () => {
    seed({
      rows: [
        mod({ kind: 'recipe', name: 'After run' }),
        mod({ kind: 'theme', name: 'Moss', slug: 'moss', enabled: true }),
        mod({ kind: 'recipe', name: 'Water', slug: 'water', disabledReason: 'It ran too often.' }),
      ],
    });
    render(<MakePane ctx={ctx} />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Recipes', 'Themes']);
    expect(screen.queryByTestId('make-empty')).toBeNull();
    expect(screen.getByText('Switched off: It ran too often.')).toBeTruthy();
    expect(screen.getByText('On. Pick it in Look, under Yours.')).toBeTruthy();
  });

  it('the switch calls setEnabled', () => {
    const r = mod({ name: 'After run' });
    seed({ rows: [r] });
    const setEnabled = vi.fn(async () => true);
    useModsStore.setState({ setEnabled });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('switch', { name: 'After run' }));
    expect(setEnabled).toHaveBeenCalledWith(r.id, true);
  });

  it('Delete asks first, and only the confirm removes', () => {
    const r = mod({ name: 'After run' });
    seed({ rows: [r] });
    const remove = vi.fn(async () => true);
    useModsStore.setState({ remove });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete After run' }));
    const request = useUIStore.getState().confirmRequest;
    expect(request).toMatchObject({ title: 'Delete After run?', destructive: true, testId: 'make-delete-confirm' });
    expect(remove).not.toHaveBeenCalled();
    request!.onConfirm();
    expect(remove).toHaveBeenCalledWith(r.id);
  });

  it('shows the safe-mode banner only in safe mode', () => {
    seed({ safeMode: true });
    render(<MakePane ctx={ctx} />);
    expect(screen.getByTestId('make-safe-mode').textContent).toContain('?safe-mode');
  });

  it('says when the database update has not landed', () => {
    seed({ available: false, loaded: false });
    render(<MakePane ctx={ctx} />);
    expect(screen.getByTestId('make-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('make-empty')).toBeNull();
  });

  it('says when the load failed, and Try again loads again', () => {
    seed({ loaded: false, failed: true, hydratedUserId: null });
    const hydrate = vi.fn(async () => {});
    useModsStore.setState({ hydrate });
    render(<MakePane ctx={ctx} />);
    expect(screen.getByTestId('make-failed').textContent).toContain('Could not load what you made.');
    hydrate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(hydrate).toHaveBeenCalledWith(USER);
    expect(screen.queryByTestId('make-empty')).toBeNull();
  });

  it('labels a row by its slug when its name is one only the database took', () => {
    seed({ rows: [mod({ name: '\u00a0', slug: 'nbsp' })] });
    render(<MakePane ctx={ctx} />);
    expect(screen.getByRole('switch', { name: 'nbsp' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete nbsp' })).toBeTruthy();
  });

  it('copy has no em dashes and never names Beacon', () => {
    seed({ safeMode: true });
    const { container, unmount } = render(<MakePane ctx={ctx} />);
    const text = container.textContent ?? '';
    unmount();
    seed({ available: false });
    const second = render(<MakePane ctx={ctx} />).container.textContent ?? '';
    for (const t of [text, second]) {
      expect(t).not.toContain('—');
      expect(t).not.toMatch(/beacon/i);
    }
  });
});

describe('Make in the settings shell', () => {
  function renderShell() {
    return render(<SettingsShell pane="make" ctx={ctx} isMobile={false} onOpenDestination={() => {}} />);
  }

  it('the pane draws the list and the Turn all mods off row', () => {
    seed({});
    const { container } = renderShell();
    expect(screen.getByTestId('make-empty')).toBeTruthy();
    expect(container.querySelector('[data-setting-row="make.allOff"]')).not.toBeNull();
  });

  it('a search for "recipe" finds the pane', async () => {
    seed({});
    renderShell();
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'recipe' } });
    await waitFor(() => expect(screen.getByTestId('settings-status').textContent).not.toBe(''), { timeout: 3000 });
    const heading = screen.getByRole('heading', { name: /Make/ });
    expect(heading).toBeTruthy();
    const results = heading.closest('section') ?? document.body;
    expect(within(results as HTMLElement).getByText('Turn all mods off')).toBeTruthy();
  });
});

describe('the settings route re-reads Make when the store latches', () => {
  // make.allOff's unavailable() reads the store outside React; without a tick
  // in the page's ctx deps, a hydrate that latches PGRST205 after the row first
  // rendered would leave the row enabled.
  it('subscribes to the mods store and lists the tick in the ctx deps', () => {
    const src = readFileSync(join(process.cwd(), 'app/settings/[[...pane]]/page.tsx'), 'utf8');
    expect(src).toContain('const modsTick = useModsStore((s) => s.available);');
    const deps = src.slice(src.indexOf('const ctx = useMemo<SettingCtx>'));
    expect(deps.slice(0, deps.indexOf(']\n  );'))).toContain('modsTick,');
  });
});

describe('MakePane: themes', () => {
  const THEME_ID = 'abcdef01-2345-4678-9abc-def012345678';
  const theme = (over: Partial<UserMod> = {}) =>
    mod({
      id: THEME_ID,
      kind: 'theme',
      slug: 'u-abcdef01',
      name: 'Moss',
      enabled: true,
      manifest: { version: 1, mode: 'light', base: 'paper', tokens: { paper0: '#fafafa' } },
      ...over,
    });

  afterEach(() => {
    useLookStore.setState({ light: 'paper', dark: 'night' });
    vi.mocked(saveSettings).mockClear();
  });

  it('New theme opens the theme form, and Cancel puts focus back on it', () => {
    seed({});
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-theme'));
    expect(screen.getByTestId('theme-builder').textContent).toContain('New theme');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('theme-builder')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('make-new-theme'));
  });

  it('a theme row has Edit, which opens it in the theme form', () => {
    seed({ rows: [theme()] });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Moss' }));
    expect(screen.getByTestId('theme-builder').textContent).toContain('Edit theme');
    expect((screen.getByTestId('theme-name') as HTMLInputElement).value).toBe('Moss');
  });

  it('deleting the theme in use writes the default pick once the delete lands', async () => {
    seed({ rows: [theme()] });
    useLookStore.setState({ light: 'u-abcdef01' });
    const remove = vi.fn(async () => true);
    useModsStore.setState({ remove });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Moss' }));
    useUIStore.getState().confirmRequest!.onConfirm();
    expect(remove).toHaveBeenCalledWith(THEME_ID);
    await waitFor(() => expect(useLookStore.getState().light).toBe('paper'));
    expect(saveSettings).toHaveBeenCalledWith(USER, { theme_light: 'paper' });
  });

  it('switching off the theme in use writes the default; one not in use is left alone', async () => {
    seed({ rows: [theme()] });
    const setEnabled = vi.fn(async () => true);
    useModsStore.setState({ setEnabled });
    useLookStore.setState({ dark: 'u-abcdef01' });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Moss' }));
    expect(setEnabled).toHaveBeenCalledWith(THEME_ID, false);
    await waitFor(() => expect(useLookStore.getState().dark).toBe('night'));
    expect(saveSettings).toHaveBeenCalledWith(USER, { theme_dark: 'night' });
    expect(useLookStore.getState().light).toBe('paper');
  });

  it('a switch-off or delete that fails keeps the pick', async () => {
    seed({ rows: [theme()] });
    const setEnabled = vi.fn(async () => false);
    const remove = vi.fn(async () => false);
    useModsStore.setState({ setEnabled, remove });
    useLookStore.setState({ dark: 'u-abcdef01' });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Moss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Moss' }));
    useUIStore.getState().confirmRequest!.onConfirm();
    await waitFor(() => expect(remove).toHaveBeenCalled());
    await Promise.resolve();
    expect(useLookStore.getState().dark).toBe('u-abcdef01');
    expect(saveSettings).not.toHaveBeenCalledWith(USER, { theme_dark: 'night' });
  });
});

describe('MakePane: Looks', () => {
  const LOOK_ID = '12345678-2345-4678-9abc-def012345678';
  const look = (over: Partial<UserMod> = {}) =>
    mod({
      id: LOOK_ID,
      kind: 'look',
      slug: 'u-12345678',
      name: 'Deep work',
      enabled: true,
      manifest: { version: 1, layout: 'notebook', light: 'paper', dark: 'dusk' },
      ...over,
    });

  it('New Look opens the Look form, and Cancel puts focus back on it', () => {
    seed({});
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-look'));
    expect(screen.getByTestId('look-builder').textContent).toContain('New Look');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('look-builder')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('make-new-look'));
  });

  it('a Look row has Edit, which opens it in the Look form, and says where to apply it when on', () => {
    seed({ rows: [look()] });
    render(<MakePane ctx={ctx} />);
    expect(screen.getByText('On. Apply it in Look, under Yours.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Deep work' }));
    expect(screen.getByTestId('look-builder').textContent).toContain('Edit Look');
    expect((screen.getByTestId('look-name') as HTMLInputElement).value).toBe('Deep work');
    expect((screen.getByTestId('look-layout') as HTMLSelectElement).value).toBe('notebook');
  });

  it('on a phone, an on Look says to apply it on a computer, since a phone has no Looks row', () => {
    seed({ rows: [look()] });
    render(<MakePane ctx={ctx} isMobile />);
    expect(screen.getByText('On. Apply it in Look on a computer, under Yours.')).toBeTruthy();
    expect(screen.queryByText('On. Apply it in Look, under Yours.')).toBeNull();
  });
});

describe('Write with AI in Make', () => {
  it('is there only while the gate says canMake: hidden while unknown and for OpenClaw alone', async () => {
    const { seedAI, CONNECTED_MODEL, OPENCLAW_PLUGIN } = await import('./helpers/ai-fixtures');
    seed({});
    render(<MakePane ctx={ctx} />);
    expect(screen.queryByTestId('make-write')).toBeNull();
    cleanup();

    let unseed = seedAI(OPENCLAW_PLUGIN);
    render(<MakePane ctx={ctx} />);
    expect(screen.queryByTestId('make-write')).toBeNull();
    cleanup();
    unseed();

    unseed = seedAI(CONNECTED_MODEL);
    try {
      render(<MakePane ctx={ctx} />);
      const write = screen.getByTestId('make-write');
      // Above the New buttons.
      expect(write.compareDocumentPosition(screen.getByTestId('make-new-recipe')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect((screen.getByTestId('make-write-kind') as HTMLSelectElement).value).toBe('recipe');
    } finally {
      unseed();
    }
  });
});

describe('MakePane: mods', () => {
  const MANIFEST = { version: 1, uses: ['storage', 'ui'], commands: [{ id: 'add-glass', label: 'Add a glass' }] };
  const scratched = (manifest: unknown = MANIFEST) => ({
    ok: true,
    manifestJson: JSON.stringify(manifest),
    hooks: ['command'],
  });

  beforeEach(() => {
    sandbox.scratch.mockReset();
    sandbox.status.mockReturnValue('idle');
    faults.fetchRecentFaults.mockReset();
    runtime.saved.mockReset();
  });

  it('New mod opens the editor on the Water template, and Cancel puts focus back on it', () => {
    seed({});
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-mod'));
    expect((screen.getByTestId('mod-name') as HTMLInputElement).value).toBe('Water');
    expect((screen.getByTestId('mod-source') as HTMLTextAreaElement).value).toContain('export function register(on)');
    expect(screen.getByTestId('mod-uses').textContent).toBe(
      'It may keep its own saved data and show short messages, and open items and views from its commands.'
    );
    expect(screen.getByTestId('mod-bytes').textContent).toMatch(/ of 65,536 bytes$/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByTestId('make-new-mod'));
  });

  it('a scratch fault is shown inline, in words, and nothing is saved', async () => {
    seed({});
    const createMod = vi.fn();
    useModsStore.setState({ createMod });
    sandbox.scratch.mockResolvedValue({ ok: false, fault: { code: 'cpu', message: 'InternalError: interrupted' } });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-mod'));
    fireEvent.click(screen.getByTestId('mod-save'));
    const error = await screen.findByTestId('mod-editor-error');
    expect(error.textContent).toContain('It used too much time.');
    expect(error.textContent).toContain('The code said: InternalError: interrupted');
    expect(createMod).not.toHaveBeenCalled();
  });

  it('says when the sandbox cannot run here, or needs a reload, and does not save', async () => {
    seed({});
    const createMod = vi.fn();
    useModsStore.setState({ createMod });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-mod'));
    sandbox.scratch.mockResolvedValueOnce({ ok: false, status: 'unavailable' });
    fireEvent.click(screen.getByTestId('mod-save'));
    expect((await screen.findByTestId('mod-editor-error')).textContent).toContain('Mods can’t run in this browser yet');
    sandbox.scratch.mockResolvedValueOnce({ ok: false, status: 'outdated' });
    fireEvent.click(screen.getByTestId('mod-save'));
    await waitFor(() =>
      expect(screen.getByTestId('mod-editor-error').textContent).toContain('dsul was updated; reload to save mods.')
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(createMod).not.toHaveBeenCalled();
  });

  it('refuses a name under the label rule before running anything', () => {
    seed({});
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-mod'));
    fireEvent.change(screen.getByTestId('mod-name'), { target: { value: 'Account' } });
    fireEvent.click(screen.getByTestId('mod-save'));
    expect(screen.getByTestId('mod-editor-error')).toBeTruthy();
    expect(sandbox.scratch).not.toHaveBeenCalled();
  });

  it('saves the manifest the code declared, in safe mode too', async () => {
    seed({ safeMode: true });
    const createMod = vi.fn(async () => ({ ok: true as const, id: 'new-id' }));
    useModsStore.setState({ createMod });
    sandbox.scratch.mockResolvedValue(scratched());
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-mod'));
    fireEvent.click(screen.getByTestId('mod-save'));
    await waitFor(() => expect(createMod).toHaveBeenCalled());
    expect(createMod).toHaveBeenCalledWith(USER, {
      name: 'Water',
      source: expect.stringContaining('add-glass'),
      manifest: { ...MANIFEST, panels: [], settings: [] },
    });
    expect(await screen.findByTestId('make-notice')).toBeTruthy();
    expect(screen.getByTestId('make-notice').textContent).toBe('Saved. It starts switched off.');
  });

  it('a manifest the schema refuses is not saved', async () => {
    seed({});
    const createMod = vi.fn();
    useModsStore.setState({ createMod });
    sandbox.scratch.mockResolvedValue(scratched({ ...MANIFEST, panels: [{ id: 'x' }] }));
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-mod'));
    fireEvent.click(screen.getByTestId('mod-save'));
    expect((await screen.findByTestId('mod-editor-error')).textContent).toContain('Its manifest is not valid.');
    expect(createMod).not.toHaveBeenCalled();
  });

  it('a mod row has Edit, which loads its code, and a save tells the running runtime', async () => {
    const r = mod({ kind: 'mod', slug: 'water', name: 'Water', enabled: true, manifest: MANIFEST });
    seed({ rows: [r] });
    const loadModCode = vi.fn(async () => ({ enabled: true, source: 'export const manifest = {};', store: {}, manifest: MANIFEST, updatedAt: 'u' }));
    const saveMod = vi.fn(async () => ({ ok: true as const, switchedOff: false }));
    useModsStore.setState({ loadModCode, saveMod });
    sandbox.scratch.mockResolvedValue(scratched());
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Water' }));
    expect(loadModCode).toHaveBeenCalledWith(r.id);
    await waitFor(() =>
      expect((screen.getByTestId('mod-source') as HTMLTextAreaElement).value).toBe('export const manifest = {};')
    );
    fireEvent.click(screen.getByTestId('mod-save'));
    await waitFor(() => expect(saveMod).toHaveBeenCalled());
    expect(runtime.saved).toHaveBeenCalledWith(r.id);
    expect((await screen.findByTestId('make-notice')).textContent).toBe('Saved.');
  });

  it('frames the mod’s own words: Problems and the switched-off reason sit under "Your mod reported:"', async () => {
    const r = mod({
      kind: 'mod',
      slug: 'water',
      name: 'Water',
      manifest: MANIFEST,
      disabledReason: '3 errors in 10 minutes. Last: Error: Sign in again',
    });
    seed({ rows: [r] });
    faults.fetchRecentFaults.mockResolvedValue([
      { at: new Date().toISOString(), summary: { kind: 'fault', hook: 'command', code: 'error', message: 'TypeError: x is null', day: '2026-10-07' } },
    ]);
    render(<MakePane ctx={ctx} />);
    expect(screen.getByText('Switched off: 3 errors in 10 minutes.')).toBeTruthy();
    expect(screen.getByTestId('mod-reported').textContent).toBe('Your mod reported: Error: Sign in again');
    expect(screen.getByTestId('recipe-runs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Problems for Water' }));
    const problem = await screen.findByTestId('mod-problem');
    expect(faults.fetchRecentFaults).toHaveBeenCalledWith(r.id);
    expect(problem.textContent).toContain('command · It hit an error');
    expect(problem.textContent).toContain('Your mod reported: TypeError: x is null');
  });

  it('editor copy has no em dashes and never names Beacon', () => {
    seed({});
    const { container } = render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByTestId('make-new-mod'));
    const text = container.textContent ?? '';
    expect(text).not.toContain('—');
    expect(text).not.toMatch(/beacon/i);
  });
});

describe('ModEditor: a "Write with AI" draft (build order 10)', () => {
  const SOURCE = "export const manifest = { version: 1, uses: ['storage'], commands: [{ id: 'log', label: 'Log a page' }] };\nexport function register(on) {\n  on('command', async ($) => {\n    await $.store.set({ key: 'n', value: 1 });\n  });\n}\n";
  const MANIFEST = { version: 1 as const, uses: ['storage' as const], commands: [{ id: 'log', label: 'Log a page' }], panels: [], settings: [] };
  const editor = (initial: Parameters<typeof ModEditor>[0]['initial'], onDone = vi.fn()) =>
    render(<ModEditor userId={USER} editing={null} initial={initial} onDone={onDone} onCancel={vi.fn()} />);
  const scratched = (manifest: unknown, hooks = ['command']) => ({ ok: true, manifestJson: JSON.stringify(manifest), hooks });

  beforeEach(() => {
    sandbox.scratch.mockReset();
    sandbox.status.mockReturnValue('idle');
  });

  it('seeds the name, the code and what it asks for from the draft, never the template', () => {
    editor({ name: 'Pages', source: SOURCE, manifest: MANIFEST, fromAI: true });
    expect((screen.getByTestId('mod-name') as HTMLInputElement).value).toBe('Pages');
    expect((screen.getByTestId('mod-source') as HTMLTextAreaElement).value).toBe(SOURCE);
    expect(screen.getByTestId('mod-uses').textContent).toBe('It may keep its own saved data.');
  });

  it('a draft that would not load starts with nothing read, not the template\'s uses', async () => {
    const createMod = vi.fn(async () => ({ ok: true as const, id: 'new-id' }));
    useModsStore.setState({ createMod });
    editor({ name: 'Pages', source: SOURCE, manifest: null, fromAI: true });
    expect(screen.getByTestId('mod-uses').textContent).toBe('Not read yet: save to check it.');
    sandbox.scratch.mockResolvedValue(scratched(MANIFEST));
    fireEvent.click(screen.getByTestId('mod-save'));
    await waitFor(() => expect(createMod).toHaveBeenCalled());
    expect(screen.getByTestId('mod-uses').textContent).toBe('It may keep its own saved data.');
  });

  it('holds Save on the draft\'s checks, and still does after an edit elsewhere', async () => {
    const createMod = vi.fn(async () => ({ ok: true as const, id: 'new-id' }));
    useModsStore.setState({ createMod });
    const chat = { ...MANIFEST, commands: [{ id: 'chat', label: 'Chat' }] };
    sandbox.scratch.mockResolvedValue(scratched(chat));
    editor({ name: 'Pages', source: SOURCE, manifest: chat, fromAI: true });
    fireEvent.click(screen.getByTestId('mod-save'));
    const checks = await screen.findByTestId('mod-editor-checks');
    expect(checks.textContent).toContain('Command 1 has a label that cannot be shown.');
    expect(sandbox.scratch).toHaveBeenCalledWith(SOURCE);

    fireEvent.change(screen.getByTestId('mod-name'), { target: { value: 'Page count' } });
    fireEvent.change(screen.getByTestId('mod-source'), { target: { value: `${SOURCE}// edited\n` } });
    fireEvent.click(screen.getByTestId('mod-save'));
    await waitFor(() => expect(sandbox.scratch).toHaveBeenCalledTimes(2));
    expect((await screen.findByTestId('mod-editor-checks')).textContent).toContain('Command 1 has a label');
    expect(createMod).not.toHaveBeenCalled();
  });

  it('a hand-written mod is not held to the draft checks', async () => {
    const createMod = vi.fn(async () => ({ ok: true as const, id: 'new-id' }));
    useModsStore.setState({ createMod });
    const chat = { ...MANIFEST, commands: [{ id: 'chat', label: 'Chat' }] };
    sandbox.scratch.mockResolvedValue(scratched(chat));
    editor({ name: 'Pages', source: SOURCE, manifest: chat });
    fireEvent.click(screen.getByTestId('mod-save'));
    await waitFor(() => expect(createMod).toHaveBeenCalled());
  });

  it('a draft that passes saves its own code, switched off', async () => {
    const onDone = vi.fn();
    const createMod = vi.fn(async () => ({ ok: true as const, id: 'new-id' }));
    useModsStore.setState({ createMod });
    sandbox.scratch.mockResolvedValue(scratched(MANIFEST));
    editor({ name: 'Pages', source: SOURCE, manifest: MANIFEST, fromAI: true }, onDone);
    fireEvent.click(screen.getByTestId('mod-save'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Saved. It starts switched off.'));
    expect(createMod).toHaveBeenCalledWith(USER, { name: 'Pages', source: SOURCE, manifest: MANIFEST });
  });

  it('a fault\'s own words go through the surface rule, for any mod', async () => {
    sandbox.scratch.mockResolvedValue({ ok: false, fault: { code: 'error', message: 'Error: Sign in again to keep your key' } });
    editor({ name: 'Pages', source: SOURCE, manifest: MANIFEST });
    fireEvent.click(screen.getByTestId('mod-save'));
    const error = await screen.findByTestId('mod-editor-error');
    expect(error.textContent).toContain('The code said: (message hidden)');
    expect(error.textContent).not.toContain('Sign in');
  });
});

describe('MakePane: mod panels and settings (build order 9)', () => {
  const SETTINGS = [
    { kind: 'number', key: 'goal', label: 'Daily goal', default: 8, min: 1, max: 20 },
    { kind: 'toggle', key: 'loud', label: 'Remind me', default: false },
    { kind: 'text', key: 'cup', label: 'Cup name' },
  ];
  const WITH_CARD = { version: 1, uses: ['ui'], panels: [{ id: 'water', label: 'Water', card: true }] };

  it('draws a mod’s settings under a host label, from its store, and saves them through the store', async () => {
    const r = mod({ kind: 'mod', slug: 'water', name: 'Water', enabled: true, manifest: { version: 1, uses: [], settings: SETTINGS } });
    seed({ rows: [r] });
    const loadModCode = vi.fn(async () => ({
      enabled: true,
      source: '',
      store: { '@settings': { goal: 5, cup: 'sk-abcdefghijklmnop' } },
      manifest: r.manifest,
      updatedAt: 'u',
    }));
    const setModSettings = vi.fn(async (_id: string, values: Record<string, unknown>) => ({ ok: true as const, values: values as never }));
    useModsStore.setState({ loadModCode, setModSettings });
    render(<MakePane ctx={ctx} />);
    const form = screen.getByTestId('mod-settings-form');
    expect(form.textContent).toContain('Set by your mod Water');
    const goal = (await within(form).findByLabelText('Daily goal')) as HTMLInputElement;
    expect(goal.value).toBe('5');
    // A stored value shaped like a key falls back, never shown.
    expect((within(form).getByLabelText('Cup name') as HTMLInputElement).value).toBe('');
    expect(within(form).getByLabelText('Cup name')).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(goal, { target: { value: '30' } });
    fireEvent.click(within(form).getByTestId('mod-settings-save'));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Daily goal needs a number between 1 and 20.');
    expect(setModSettings).not.toHaveBeenCalled();
    fireEvent.change(goal, { target: { value: '12' } });
    fireEvent.click(within(form).getByRole('switch', { name: 'Remind me' }));
    fireEvent.click(within(form).getByTestId('mod-settings-save'));
    await waitFor(() => expect(setModSettings).toHaveBeenCalledWith(r.id, { goal: 12, loud: true, cup: null }));
    expect(await within(form).findByRole('status')).toHaveTextContent('Saved.');
  });

  it('a mod without settings draws no form', () => {
    seed({ rows: [mod({ kind: 'mod', slug: 'water', name: 'Water', manifest: { version: 1, uses: [] } })] });
    render(<MakePane ctx={ctx} />);
    expect(screen.queryByTestId('mod-settings-form')).toBeNull();
  });

  it('says which mod’s card is the one under the braindump', () => {
    const first = mod({ kind: 'mod', slug: 'water', name: 'Water', enabled: true, manifest: WITH_CARD, createdAt: '2026-10-01T00:00:00Z' });
    const second = mod({ kind: 'mod', slug: 'steps', name: 'Steps', enabled: true, manifest: WITH_CARD, createdAt: '2026-10-02T00:00:00Z' });
    const off = mod({ kind: 'mod', slug: 'tea', name: 'Tea', enabled: false, manifest: WITH_CARD, createdAt: '2026-09-01T00:00:00Z' });
    seed({ rows: [first, second, off] });
    render(<MakePane ctx={ctx} />);
    const line = (id: string) => document.querySelector(`[data-make-row="${id}"] [data-testid="mod-card-line"]`);
    expect(line(first.id)?.textContent).toBe('Shows under the braindump');
    expect(line(second.id)?.textContent).toBe('Another mod’s card is showing');
    expect(line(off.id)).toBeNull();
  });

  it('the editor says what a mod draws and asks for, in plain words', () => {
    expect(panelsInWords({ uses: ['ui'], panels: [{ id: 'a', label: 'A', card: true }], settings: [] })).toBe(
      'Draws 1 panel, shown under the braindump.'
    );
    expect(
      panelsInWords({
        uses: ['ui', 'items:read'],
        panels: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', card: true }],
        settings: [{ kind: 'toggle', key: 'x', label: 'X' }],
      })
    ).toBe('Draws 2 panels, one shown under the braindump. Shows titles of items you link to. Has 1 setting you set in Make.');
    expect(panelsInWords({ uses: [], panels: [], settings: [] })).toBe('');
  });
});
