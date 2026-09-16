import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

/**
 * The item load follows the route, and the identity does not.
 *
 * Driven through the REAL provider rather than a reimplementation of its
 * ordering, because the ordering is the thing under test: `adoptLocalState`
 * before any stamp, the stamp before the settings hydration that the /settings
 * gate reads, and the seven-table load only where something renders it.
 *
 * The property that matters most is the LAST test here. Skipping the load is
 * only safe because the navigation effect picks it up; without it, /settings →
 * / lands on the planner with an empty store and no event left to fill it —
 * a client-side navigation raises no Supabase auth event at all.
 */

const USER = 'user-a';

const loadSettings = vi.fn(async () => ({}));
vi.mock('@/lib/settings-service', () => ({
  loadSettings: () => loadSettings(),
  saveSettings: vi.fn(),
  flushSettings: vi.fn(async () => {}),
}));

/**
 * The provider's auth listener, captured so a test can deliver the events
 * Supabase would. SIGNED_IN is re-emitted on every hidden→visible transition
 * AND broadcast across tabs, which is what makes an A → B → A sequence with no
 * navigation between the steps an ordinary thing rather than a contrived one.
 */
let emitAuth: (event: string, session: { user: { id: string } } | null) => void = () => {};

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: USER } } } }),
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        emitAuth = cb as typeof emitAuth;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  }),
}));

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));

/** The route on screen, swapped between renders. */
let pathname = '/settings/day';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { SupabaseProvider } from '@/components/providers/supabase-provider';
import { usePlannerStore } from '@/lib/planner-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useChannelSecretsStore } from '@/lib/channel-secrets-store';
import { useGatewayStore } from '@/lib/gateway-store';
import { useNudgeStore } from '@/lib/nudge-store';
import { useMorningStore } from '@/lib/morning-store';

const original = {
  initializeStore: usePlannerStore.getState().initializeStore,
  extensions: useExtensionsStore.getState().hydrate,
  secrets: useChannelSecretsStore.getState().hydrate,
  gateway: useGatewayStore.getState().hydrate,
  nudges: useNudgeStore.getState().hydrate,
};

/** Stands in for the seven-table fetch, counting the calls it never makes. */
const initializeStore = vi.fn(async (userId: string) => {
  usePlannerStore.setState({ userId, isLoading: false });
});

describe('the item load follows the route', () => {
  beforeEach(() => {
    pathname = '/settings/day';
    initializeStore.mockClear();
    loadSettings.mockClear();
    usePlannerStore.getState().clearStore();
    usePlannerStore.setState({ initializeStore });
    useExtensionsStore.setState({ hydrate: async () => {} });
    useChannelSecretsStore.setState({ hydrate: async () => {} });
    useGatewayStore.setState({ hydrate: async () => {} });
    useNudgeStore.setState({ hydrate: async () => {} });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  afterEach(() => {
    cleanup();
    usePlannerStore.setState({ initializeStore: original.initializeStore });
    useExtensionsStore.setState({ hydrate: original.extensions });
    useChannelSecretsStore.setState({ hydrate: original.secrets });
    useGatewayStore.setState({ hydrate: original.gateway });
    useNudgeStore.setState({ hydrate: original.nudges });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  it('stamps the account on a lean route without fetching a single item', async () => {
    render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    // The identity arrives — this is what /settings' hydration gate reads, and
    // the page stays on its skeleton forever without it.
    await waitFor(() => expect(usePlannerStore.getState().userId).toBe(USER));
    // The settings themselves still load; it is only the ITEMS that are skipped.
    await waitFor(() => expect(loadSettings).toHaveBeenCalled());

    expect(initializeStore).not.toHaveBeenCalled();
    // And the store reads as unsettled, not as an account that owns nothing.
    expect(usePlannerStore.getState().isLoading).toBe(true);
  });

  it('loads on a route that renders items', async () => {
    pathname = '/';
    render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER));
  });

  it('picks the load up on navigation out of a lean route', async () => {
    const view = render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    await waitFor(() => expect(usePlannerStore.getState().userId).toBe(USER));
    expect(initializeStore).not.toHaveBeenCalled();

    // The planner, reached by a client-side navigation — which raises no
    // Supabase event, so the auth path above will never run again.
    pathname = '/';
    view.rerender(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER));
  });

  it('does not re-enter the load when moving between item routes', async () => {
    pathname = '/item/one';
    const view = render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );
    await waitFor(() => expect(initializeStore).toHaveBeenCalledTimes(1));

    pathname = '/item/two';
    view.rerender(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );
    await waitFor(() => expect(usePlannerStore.getState().userId).toBe(USER));

    // Re-entering it would clear the undo stack and replace `items` wholesale
    // — a rename committed inside that window is silently reverted.
    expect(initializeStore).toHaveBeenCalledTimes(1);
  });

  /**
   * The wipe and the load latch have to agree about which account is loaded.
   *
   * `loadPlanner` latches `loadedUserId` so a SIGNED_IN re-emit cannot re-enter
   * a load and throw away the undo stack. `identifyUser` empties the store
   * whenever the account changes. Those two facts can disagree: an account
   * wiped while its latch still names it could never be loaded again, and the
   * planner sat empty with `isLoading` stuck true and no error to explain it.
   *
   * Supabase broadcasts SIGNED_IN across tabs, so signing into B in another tab
   * and back to A in this one delivers exactly this sequence with no navigation
   * in between.
   */
  it('reloads an account that was wiped while its latch still named it', async () => {
    pathname = '/';
    const view = render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER));

    // Off to settings, where nothing loads.
    pathname = '/settings/day';
    view.rerender(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    // Two cross-tab broadcasts: A's rows are wiped by the switch to B, and
    // wiped again on the way back.
    emitAuth('SIGNED_IN', { user: { id: 'user-b' } });
    await waitFor(() => expect(usePlannerStore.getState().userId).toBe('user-b'));
    emitAuth('SIGNED_IN', { user: { id: USER } });
    await waitFor(() => expect(usePlannerStore.getState().userId).toBe(USER));
    expect(usePlannerStore.getState().items).toEqual([]);

    // Back to the planner. A's items are gone, so they must be fetched again.
    initializeStore.mockClear();
    pathname = '/';
    view.rerender(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER));
  });
});
