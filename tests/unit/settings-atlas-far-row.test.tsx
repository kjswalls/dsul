/**
 * The Look pane's "Atlas zoomed out, light mode" row on the real settings page
 * (app/settings/[[...pane]]/page.tsx). The manifest reads through getState(),
 * so the page re-renders a row only off a store tick it subscribes to. The
 * Atlas pick was missing from the look tick: picking Dusk wrote the store, but
 * the chip kept saying Bloom until something else re-rendered the page, so the
 * setting read as broken.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


const nav = vi.hoisted(() => {
  const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  return { router, params: { pane: ['look'] }, search: new URLSearchParams() };
});
const themes = vi.hoisted(() => ({ resolvedTheme: 'light' as string }));


vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
  usePathname: () => '/settings/look',
}));
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', resolvedTheme: themes.resolvedTheme, setTheme: vi.fn() }),
}));
vi.mock('@/lib/settings-service', () => ({
  saveSettings: vi.fn(async () => {}),
  flushSettings: vi.fn(async () => {}),
}));
vi.mock('@/lib/user-profile', () => ({ resetOnboardingComplete: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    auth: { getUser: async () => ({ data: { user: null } }), signOut: async () => ({}) },
  }),
}));
// The page's deferred modals, loaded the way next/dynamic would, through a
// lazy component.
vi.mock('next/dynamic', async () => {
  const React = await import('react');
  return {
    default: (loader: () => Promise<React.ComponentType<object>>) => {
      const Lazy = React.lazy(async () => ({ default: await loader() }));
      return function Dynamic(props: object) {
        return (
          <React.Suspense fallback={null}>
            <Lazy {...props} />
          </React.Suspense>
        );
      };
    },
  };
});

vi.mock('@/hooks/use-mobile', async (orig) => ({ ...(await orig<object>()), useIsMobile: () => false }));

import SettingsPage from '@/app/settings/[[...pane]]/page';
import { useMorningStore } from '@/lib/morning-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useLookStore } from '@/lib/look-store';
import { settingById } from '@/lib/settings/manifest';

const A = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

beforeEach(() => {
  usePlannerStore.setState({ userId: A });
  useMorningStore.setState({ settingsHydratedUserId: A });
  useLookStore.setState({ atlasFarPaper: 'bloom' });
});

afterEach(() => {
  cleanup();
  usePlannerStore.setState({ userId: null });
  useMorningStore.setState({ settingsHydratedUserId: null });
  useLookStore.setState({ atlasFarPaper: 'bloom' });
  themes.resolvedTheme = 'light';
});

describe('look.atlasFar on the settings page', () => {
  it('shows the new pick as soon as it is written', async () => {
    render(<SettingsPage />);
    const chip = await screen.findByTestId('setting-look.atlasFar');
    expect(chip).toHaveTextContent('Bloom');
    act(() => settingById('look.atlasFar')!.write('dusk', {} as never));
    expect(useLookStore.getState().atlasFarPaper).toBe('dusk');
    await waitFor(() => expect(screen.getByTestId('setting-look.atlasFar')).toHaveTextContent('Dusk'));
  });

  it('says so while a dark theme is showing, and stays live', () => {
    const r = settingById('look.atlasFar')!;
    const ctx = (theme: string) => ({ theme }) as never;
    expect(r.note?.(ctx('dark'))).toMatch(/dark theme/);
    expect(r.note?.(ctx('light'))).toBeNull();
    expect(r.unavailable).toBeUndefined();
    // Under "system", the theme actually showing decides, not the pick.
    expect(r.note?.({ theme: 'system', resolvedTheme: 'dark' } as never)).toMatch(/dark theme/);
    expect(r.note?.({ theme: 'system', resolvedTheme: 'light' } as never)).toBeNull();
  });

  it('shows the note on the page while a dark theme is showing under System, and not under light', async () => {
    themes.resolvedTheme = 'dark';
    const { unmount } = render(<SettingsPage />);
    const row = (await screen.findByTestId('setting-look.atlasFar')).closest('[data-setting-row]');
    expect(row).not.toBeNull();
    await waitFor(() => expect(row!.querySelector('[data-setting-note]')).toHaveTextContent(/dark theme/));
    unmount();

    themes.resolvedTheme = 'light';
    render(<SettingsPage />);
    const lightRow = (await screen.findByTestId('setting-look.atlasFar')).closest('[data-setting-row]');
    expect(lightRow).not.toBeNull();
    expect(lightRow!.querySelector('[data-setting-note]')).toBeNull();
  });
});
