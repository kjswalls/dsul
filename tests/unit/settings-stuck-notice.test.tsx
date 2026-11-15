import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings page's stuck notice (app/settings/[[...pane]]/page.tsx,
 * SettingsSkeleton): nothing for five seconds, then one card row with
 * Back to planner and Reload, and Enter reloads. Sign in only without a user.
 * Mocks follow settings-delete-account-gate.test.tsx.
 */

const nav = vi.hoisted(() => {
  const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  return { router, params: { pane: ['dsul'] }, search: new URLSearchParams() };
});

vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
  usePathname: () => '/settings/dsul',
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));
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
import SettingsPage from '@/app/settings/[[...pane]]/page';
import { useMorningStore } from '@/lib/morning-store';
import { usePlannerStore } from '@/lib/planner-store';

const A = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const reload = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  reload.mockReset();
  vi.stubGlobal('location', { ...window.location, reload });
  useMorningStore.setState({ settingsHydratedUserId: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  usePlannerStore.setState({ userId: null });
});

describe('settings stuck notice', () => {
  it('waits five seconds, then offers Back to planner and Reload', () => {
    usePlannerStore.setState({ userId: A });
    render(<SettingsPage />);
    expect(screen.getByTestId('settings-page')).toHaveAttribute('data-settings-state', 'loading');
    expect(screen.queryByText('Taking longer than usual')).toBeNull();

    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('Taking longer than usual')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to planner' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Reload/ }));
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('offers Sign in when no account was adopted', () => {
    render(<SettingsPage />);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?redirect=/settings');
  });
});
