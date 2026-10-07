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

import { MakePane } from '@/components/settings/make-pane';
import { SettingsShell } from '@/components/settings/settings-shell';
import { useModsStore } from '@/lib/mods-store';
import { useUIStore } from '@/lib/ui-store';
import type { UserMod } from '@/lib/mods/schema';
import type { SettingCtx } from '@/lib/settings/manifest';
import { useLookStore } from '@/lib/look-store';
import { saveSettings } from '@/lib/settings-service';

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
