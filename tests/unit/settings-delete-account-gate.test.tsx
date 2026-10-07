import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Delete account across the settings page's hydration gate
 * (app/settings/[[...pane]]/page.tsx).
 *
 * A browser can switch accounts under the open dialog: an email link for
 * account B opened in another tab replaces the cookie session, the planner is
 * B's at once, and the page drops to its skeleton until B's settings land. The
 * dialog has to keep its state through that, the account it was opened for,
 * so that a Delete is answered by the server's 409 changed. Mounted inside the
 * gate it unmounted at the skeleton and came back open by itself, asking about
 * B with an empty field (memory/plans/account-deletion.md).
 */

const nav = vi.hoisted(() => {
  const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  return { router, params: { pane: ['dsul'] }, search: new URLSearchParams() };
});

/** How often the dialog mounted and unmounted, and what it was last told. */
const dialog = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  useParams: () => nav.params,
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
// The dialog itself is delete-account-dialog.test.tsx's; here it only counts.
vi.mock('@/components/settings/delete-account-dialog', async () => {
  const { useEffect } = await import('react');
  return {
    DeleteAccountDialog: ({ open }: { open: boolean }) => {
      useEffect(() => {
        dialog.mounts += 1;
        return () => {
          dialog.unmounts += 1;
        };
      }, []);
      return open ? <div data-testid="delete-account-stub" /> : null;
    },
  };
});

import SettingsPage from '@/app/settings/[[...pane]]/page';
import { useMorningStore } from '@/lib/morning-store';
import { usePlannerStore } from '@/lib/planner-store';

const A = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const B = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

beforeEach(() => {
  dialog.mounts = 0;
  dialog.unmounts = 0;
  usePlannerStore.setState({ userId: A });
  useMorningStore.setState({ settingsHydratedUserId: A });
});

afterEach(() => {
  cleanup();
  usePlannerStore.setState({ userId: null });
  useMorningStore.setState({ settingsHydratedUserId: null });
});

describe('Delete account and the hydration gate', () => {
  it('keeps the open dialog mounted while the page waits on another account', async () => {
    render(<SettingsPage />);
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-setting="dsul.deleteAccount"]');
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(row);
    await screen.findByTestId('delete-account-stub');
    expect(dialog).toEqual({ mounts: 1, unmounts: 0 });

    // SIGNED_IN(B) from another tab: the planner is B's at once, its settings not yet.
    act(() => usePlannerStore.setState({ userId: B }));
    expect(screen.getByTestId('settings-page')).toHaveAttribute('data-settings-state', 'loading');
    expect(screen.getByTestId('delete-account-stub')).toBeInTheDocument();
    expect(dialog).toEqual({ mounts: 1, unmounts: 0 });

    // B's settings land: the same dialog, never torn down and opened afresh.
    act(() => useMorningStore.setState({ settingsHydratedUserId: B }));
    expect(screen.getByTestId('settings-page')).toHaveAttribute('data-settings-state', 'ready');
    expect(screen.getByTestId('delete-account-stub')).toBeInTheDocument();
    expect(dialog).toEqual({ mounts: 1, unmounts: 0 });
  });
});
