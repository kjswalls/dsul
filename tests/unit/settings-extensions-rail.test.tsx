import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * Settings → Extensions: the store is the pane, your extensions are the rail.
 *
 * Four claims:
 *   1. The Extensions pane is the store, with nothing to pick first — no tabs,
 *      no link card — and the rail opens a sub-list under Extensions that
 *      starts with Browse. No other pane nests anything.
 *   2. The sub-list splits On from Off, folds Off, and never folds away the
 *      row you are on.
 *   3. Its switches write the extension's own toggle, show that toggle's own
 *      value, are disabled when that toggle's row would be, and a flip does
 *      not move the row.
 *   4. A phone gets the same list at the top of the pane, and an extension
 *      reached from Browse still has a way back to its shelf.
 */

let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/extensions',
  useSearchParams: () => params,
}));
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

import { SettingsShell } from '@/components/settings/settings-shell';
import { extensionPaneId, type PaneId, type SettingCtx } from '@/lib/settings/manifest';
import { EXT_BEEMINDER, EXT_HABIT_HEATMAP, OFFICIAL_EXTENSIONS } from '@/lib/extension-registry';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useReminderStore } from '@/lib/reminder-store';
import { useExtensionAdoptionStore } from '@/lib/extension-adoption-store';

const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: 'test-user' };

function renderShell(pane: PaneId = 'extensions') {
  return render(<SettingsShell pane={pane} ctx={ctx} isMobile={false} onOpenDestination={() => {}} />);
}

const rail = () => screen.getByTestId('extension-list-rail');
// The phone's copy of the list is in the DOM too (CSS picks one at the md
// breakpoint), so a row is always looked up inside the list being tested.
const row = (slug: string, list: HTMLElement = rail()) =>
  list.querySelector<HTMLElement>(`[data-extension-row="${slug}"]`);

beforeEach(() => {
  params = new URLSearchParams();
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
  // The heatmap on, everything else explicitly off.
  useExtensionsStore.setState({
    available: true,
    configsLoaded: true,
    configs: {},
    enabled: Object.fromEntries(OFFICIAL_EXTENSIONS.map((e) => [e.slug, e.slug === EXT_HABIT_HEATMAP])),
  });
  useReminderStore.setState({ remindersEnabled: false, stakesEnabled: false });
  useExtensionAdoptionStore.setState({ status: 'ready', stats: {} });
});

afterEach(() => {
  cleanup();
  useExtensionsStore.getState().reset();
});

describe('the Extensions pane is the store', () => {
  it('shows Browse straight away, with no tabs and no link card', () => {
    renderShell();
    expect(screen.getByTestId('extension-browse')).toBeTruthy();
    expect(screen.queryByTestId('extensions-view-tabs')).toBeNull();
    expect(screen.queryByTestId('extension-store-door')).toBeNull();
  });

  it('opens a sub-list under Extensions in the rail, starting with Browse', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.contains(rail())).toBe(true);
    const browse = within(rail()).getByRole('link', { name: /Browse/ });
    expect(browse.getAttribute('href')).toBe('/settings/extensions');
    expect(browse.getAttribute('aria-current')).toBe('page');
    // The lit row is Browse, not the parent.
    expect(within(nav).getByRole('button', { name: 'Extensions' }).getAttribute('aria-current')).toBeNull();
  });

  it('nests nothing on any other pane', () => {
    renderShell('day');
    expect(screen.queryByTestId('extension-list-rail')).toBeNull();
    expect(
      within(screen.getByRole('navigation', { name: 'Settings sections' }))
        .getByRole('button', { name: 'Your day' })
        .getAttribute('aria-current')
    ).toBe('true');
  });

  it('widens the whole page around the store, so it stays centred', () => {
    renderShell();
    const main = document.querySelector('main')!;
    expect(main.className).toContain('mx-auto');
    expect(main.className).toContain('max-w-[1320px]');
    // The store takes the full column; nothing caps it at 600px.
    expect(screen.getByTestId('extension-browse').closest('.md\\:max-w-\\[600px\\]')).toBeNull();
  });

  it('keeps an extension’s own page at the usual width', () => {
    renderShell(extensionPaneId(EXT_HABIT_HEATMAP));
    expect(document.querySelector('main')!.className).toContain('max-w-[880px]');
  });

  it('keeps the search box in the 600px column', () => {
    renderShell();
    expect(screen.getByTestId('settings-search').closest('.md\\:max-w-\\[600px\\]')).toBeTruthy();
  });

  it('closes the sub-list while searching', () => {
    vi.useFakeTimers();
    try {
      renderShell();
      fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'heatmap' } });
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByTestId('extension-list-rail')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the sub-list', () => {
  it('lists what is on and folds what is off', () => {
    renderShell();
    expect(within(rail()).getByText(/On · 1/)).toBeTruthy();
    expect(within(rail()).getByText(new RegExp(`Off · ${OFFICIAL_EXTENSIONS.length - 1}`))).toBeTruthy();
    expect(row(EXT_HABIT_HEATMAP)).toBeTruthy();
    expect(row(EXT_BEEMINDER)).toBeNull();

    fireEvent.click(within(rail()).getByRole('button', { name: 'Show' }));
    expect(row(EXT_BEEMINDER)).toBeTruthy();
    expect(localStorage.getItem('dsul-settings-extensions-off-open')).toBe('1');
  });

  it('never folds away the extension you are on', () => {
    renderShell(extensionPaneId(EXT_BEEMINDER));
    expect(within(row(EXT_BEEMINDER)!).getByRole('link').getAttribute('aria-current')).toBe('page');
    expect(within(rail()).queryByRole('button', { name: 'Show' })).toBeNull();
  });

  it('unfolds Off when nothing is on', () => {
    useExtensionsStore.setState({ enabled: Object.fromEntries(OFFICIAL_EXTENSIONS.map((e) => [e.slug, false])) });
    renderShell();
    expect(within(rail()).getByText(/On · 0/)).toBeTruthy();
    expect(row(EXT_BEEMINDER)).toBeTruthy();
  });

  it('flips the extension’s own toggle, and the row stays where it was', () => {
    renderShell();
    const toggle = within(row(EXT_HABIT_HEATMAP)!).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(useExtensionsStore.getState().enabled[EXT_HABIT_HEATMAP]).toBe(false);
    // Same group, now saying Off.
    expect(row(EXT_HABIT_HEATMAP)!.dataset.extensionState).toBe('Off');
    expect(within(rail()).getByText(/On · 1/)).toBeTruthy();
    expect(within(row(EXT_HABIT_HEATMAP)!).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('draws an on-but-unavailable extension the way its pane does: on, disabled, with the reason', () => {
    // Beeminder switched on, riding Settle the day, which is off.
    useExtensionsStore.setState({ enabled: { ...useExtensionsStore.getState().enabled, [EXT_BEEMINDER]: true } });
    renderShell(extensionPaneId(EXT_BEEMINDER));
    const beeminder = row(EXT_BEEMINDER)!;
    expect(beeminder.dataset.extensionState).toBe('Unavailable');
    const railSwitch = within(beeminder).getByRole('switch') as HTMLButtonElement;
    expect(railSwitch.disabled).toBe(true);
    // The pane's own switch for the same record, in the same position.
    const paneSwitch = document
      .querySelector('[data-setting-row="extensions.beeminder"]')!
      .querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(railSwitch.getAttribute('aria-checked')).toBe(paneSwitch.getAttribute('aria-checked'));
    expect(railSwitch.getAttribute('aria-checked')).toBe('true');
    // The reason is in the link's name, not only in a tooltip.
    expect(within(beeminder).getByRole('link').textContent).toContain('Settle the day');
  });

  it('keeps the switch out of the pointer’s reach until it is shown', () => {
    renderShell();
    const holder = within(row(EXT_HABIT_HEATMAP)!).getByRole('switch').parentElement!;
    expect(holder.className).toContain('pointer-events-none');
    expect(holder.className).toContain('group-hover/ext:pointer-events-auto');
    expect(holder.className).toContain('group-focus-within/ext:pointer-events-auto');
  });

  it('is not a second setting row, so a deep link still has one target', () => {
    renderShell(extensionPaneId(EXT_HABIT_HEATMAP));
    expect(rail().querySelector('[data-setting-row]')).toBeNull();
  });
});

describe('on a phone', () => {
  it('puts the same list at the top of the pane, and the rail copy is desktop-only', () => {
    renderShell();
    const list = screen.getByTestId('extension-list-pane');
    // CSS, not isMobile, picks the copy: isMobile reads false on a phone's
    // first frame, which drew the rail's list into the chip strip.
    expect(list.parentElement!.className).toContain('md:hidden');
    expect(rail().parentElement!.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(rail().parentElement!.className).toContain('md:block');
    expect(within(row(EXT_HABIT_HEATMAP, list)!).getByRole('switch')).toBeTruthy();
    expect(
      list.compareDocumentPosition(screen.getByTestId('extension-browse')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

describe('an extension reached from Browse', () => {
  it('links back to Browse at the top', () => {
    params = new URLSearchParams('from=browse');
    renderShell(extensionPaneId(EXT_HABIT_HEATMAP));
    expect(screen.getByTestId('extension-back-to-browse').getAttribute('href')).toBe('/settings/extensions');
  });

  it('returns to the shelf you were browsing', () => {
    params = new URLSearchParams('from=browse&shelf=habits');
    renderShell(extensionPaneId(EXT_HABIT_HEATMAP));
    expect(screen.getByTestId('extension-back-to-browse').getAttribute('href')).toBe(
      '/settings/extensions?shelf=habits'
    );
  });

  it('offers the store at the bottom on a phone when you came another way', () => {
    renderShell(extensionPaneId(EXT_HABIT_HEATMAP));
    expect(screen.queryByTestId('extension-back-to-browse')).toBeNull();
    const link = screen.getByRole('link', { name: 'Browse all extensions' });
    expect(link.getAttribute('href')).toBe('/settings/extensions');
    // A desktop has Browse in the rail; with no figure beside it, the row goes.
    expect(link.parentElement!.className).toContain('md:hidden');
  });
});
