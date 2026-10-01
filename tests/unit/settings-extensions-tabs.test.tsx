import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The store lives in Settings → Extensions as the Browse tab.
 *
 * Three claims:
 *   1. The pane opens on List (the plain rows) unless told otherwise, and the
 *      link card that used to sit above them is gone — the tabs are the door.
 *   2. Browse shows the store and widens the column; ?view=browse opens it, and
 *      the tab you pick is what the pane comes back to.
 *   3. An extension reached from Browse has a way back to Browse.
 */

const replace = vi.fn();
let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), prefetch: vi.fn() }),
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
import { EXT_HABIT_HEATMAP } from '@/lib/extension-registry';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useReminderStore } from '@/lib/reminder-store';
import { useExtensionAdoptionStore } from '@/lib/extension-adoption-store';

const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: 'test-user' };

function renderShell(pane: PaneId = 'extensions') {
  return render(<SettingsShell pane={pane} ctx={ctx} isMobile={false} onOpenDestination={() => {}} />);
}

beforeEach(() => {
  params = new URLSearchParams();
  replace.mockClear();
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
  useExtensionsStore.setState({ available: true, configsLoaded: true, enabled: {}, configs: {} });
  useReminderStore.setState({ remindersEnabled: false, stakesEnabled: false });
  useExtensionAdoptionStore.setState({ status: 'ready', stats: {} });
});

afterEach(() => {
  cleanup();
  useExtensionsStore.getState().reset();
});

describe('Settings → Extensions', () => {
  it('opens on List, with no store link card above the rows', () => {
    renderShell();
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('extension-store-door')).toBeNull();
    expect(screen.queryByTestId('extension-browse')).toBeNull();
  });

  it('opens on Browse from ?view=browse', () => {
    params = new URLSearchParams('view=browse');
    renderShell();
    expect(screen.getByRole('button', { name: 'Browse' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('extension-browse')).toBeTruthy();
    expect(document.querySelector('main')!.dataset.extensionsView).toBe('browse');
  });

  it('remembers the tab you picked', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(replace).toHaveBeenCalledWith('/settings/extensions?view=browse', { scroll: false });
    expect(localStorage.getItem('dsul-settings-extensions-view')).toBe('browse');
    cleanup();
    params = new URLSearchParams();
    renderShell();
    expect(screen.getByRole('button', { name: 'Browse' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('counts arriving on ?view=browse as picking Browse', () => {
    params = new URLSearchParams('view=browse');
    renderShell();
    expect(localStorage.getItem('dsul-settings-extensions-view')).toBe('browse');
    cleanup();
    params = new URLSearchParams();
    renderShell();
    expect(screen.getByRole('button', { name: 'Browse' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the search box and tabs in the 600px column on Browse', () => {
    params = new URLSearchParams('view=browse');
    renderShell();
    const column = screen.getByTestId('settings-search').closest('.md\\:max-w-\\[600px\\]');
    expect(column).toBeTruthy();
    expect(column!.contains(screen.getByTestId('extensions-view-tabs'))).toBe(true);
  });

  it('shows no tabs on any other pane', () => {
    renderShell('day');
    expect(screen.queryByTestId('extensions-view-tabs')).toBeNull();
  });
});

describe('an extension reached from Browse', () => {
  it('links back to Browse at the top', () => {
    params = new URLSearchParams('from=browse');
    renderShell(extensionPaneId(EXT_HABIT_HEATMAP));
    const back = screen.getByTestId('extension-back-to-browse');
    expect(back.getAttribute('href')).toBe('/settings/extensions?view=browse');
  });

  it('returns to the shelf you were browsing', () => {
    params = new URLSearchParams('from=browse&shelf=habits');
    renderShell(extensionPaneId(EXT_HABIT_HEATMAP));
    expect(screen.getByTestId('extension-back-to-browse').getAttribute('href')).toBe(
      '/settings/extensions?view=browse&shelf=habits'
    );
  });

  it('offers the store at the bottom instead when you came from the list', () => {
    renderShell(extensionPaneId(EXT_HABIT_HEATMAP));
    expect(screen.queryByTestId('extension-back-to-browse')).toBeNull();
    expect(screen.getByRole('link', { name: 'Browse all extensions' }).getAttribute('href')).toBe(
      '/settings/extensions?view=browse'
    );
  });
});
