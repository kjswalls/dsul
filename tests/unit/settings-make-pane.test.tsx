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
    expect(empty.textContent).toContain('Recipes are coming soon.');
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
    expect(screen.getByText('On')).toBeTruthy();
  });

  it('the switch calls setEnabled', () => {
    const r = mod({ name: 'After run' });
    seed({ rows: [r] });
    const setEnabled = vi.fn(async () => {});
    useModsStore.setState({ setEnabled });
    render(<MakePane ctx={ctx} />);
    fireEvent.click(screen.getByRole('switch', { name: 'After run' }));
    expect(setEnabled).toHaveBeenCalledWith(r.id, true);
  });

  it('Delete asks first, and only the confirm removes', () => {
    const r = mod({ name: 'After run' });
    seed({ rows: [r] });
    const remove = vi.fn(async () => {});
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
