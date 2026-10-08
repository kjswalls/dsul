import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';

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

/** What getSession answers on mount. Null is a page with no session at all. */
let mountSession: { user: { id: string } } | null = { user: { id: USER } };
const getSession = vi.fn(async () => ({ data: { session: mountSession }, error: null }));

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    auth: {
      getSession,
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

/**
 * The planner snapshot's two provider-side hooks, as spies: the clear is also a
 * RAW clearer inside adoptLocalState, so the tests below arrange the owner
 * stamp to tell the provider's own calls apart from that one. Both are no-ops
 * in jsdom anyway (no IndexedDB).
 */
const { clearPlannerSnapshot, warmPlannerSnapshot, startPlannerSnapshotWriter, stopPlannerSnapshotWriter } =
  vi.hoisted(() => {
    const stopPlannerSnapshotWriter = vi.fn();
    return {
      clearPlannerSnapshot: vi.fn(),
      warmPlannerSnapshot: vi.fn(),
      stopPlannerSnapshotWriter,
      startPlannerSnapshotWriter: vi.fn(() => stopPlannerSnapshotWriter),
    };
  });
vi.mock('@/lib/planner-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planner-snapshot')>()),
  clearPlannerSnapshot,
  warmPlannerSnapshot,
}));
vi.mock('@/lib/planner-snapshot-writer', () => ({ startPlannerSnapshotWriter }));

import { SupabaseProvider } from '@/components/providers/supabase-provider';
import { usePlannerStore } from '@/lib/planner-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useChannelSecretsStore } from '@/lib/channel-secrets-store';
import { useGatewayStore } from '@/lib/gateway-store';
import { useNudgeStore } from '@/lib/nudge-store';
import { useMorningStore } from '@/lib/morning-store';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { LOCAL_STATE_OWNER_KEY } from '@/lib/local-state';
import { signedOutNav } from '@/lib/signed-out-redirect';
import { useUIStore } from '@/lib/ui-store';

/**
 * The second argument a page's FIRST load carries: the look-only preview's
 * offer (supabase-provider's `previewOffered`). Every later load is bare.
 */
const OFFERED = { preview: expect.any(Function) };

const original = {
  initializeStore: usePlannerStore.getState().initializeStore,
  extensions: useExtensionsStore.getState().hydrate,
  secrets: useChannelSecretsStore.getState().hydrate,
  gateway: useGatewayStore.getState().hydrate,
  nudges: useNudgeStore.getState().hydrate,
  ai: useAIConnectionStore.getState().hydrate,
};

type LoadFn = (userId: string, opts?: { preview?: () => boolean }) => Promise<void>;

/** Stands in for the seven-table fetch, counting the calls it never makes. */
const initializeStore = vi.fn<LoadFn>(async (userId) => {
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
    useAIConnectionStore.setState({ hydrate: async () => {} });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  afterEach(() => {
    cleanup();
    usePlannerStore.setState({ initializeStore: original.initializeStore });
    useExtensionsStore.setState({ hydrate: original.extensions });
    useChannelSecretsStore.setState({ hydrate: original.secrets });
    useGatewayStore.setState({ hydrate: original.gateway });
    useNudgeStore.setState({ hydrate: original.nudges });
    useAIConnectionStore.setState({ hydrate: original.ai });
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

    // The page's first load: it carries the preview offer (intended, design §4).
    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER, OFFERED));
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

    // Still the page's first load, so it carries the offer (intended, design §4).
    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER, OFFERED));
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

    // The page's first load carries the preview offer (intended, design §4).
    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER, OFFERED));

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
    // Once per page (intended, design §4): the offer went with the first load,
    // and a re-preview here would flash the cache over a wiped store.
    expect(initializeStore.mock.calls.at(-1)?.[1]?.preview).toBeUndefined();
  });
});

/**
 * Channel secrets, gateway and dismissed nudges render nothing on the planner,
 * so on a needs-items route they wait for the item load to settle instead of
 * queueing beside it in the cold-start burst. Settings, extensions and the AI
 * gate do not wait: one paints the grid and gates /settings, one drives
 * grouping, and the last decides whether any AI surface may show at all —
 * every one of them hidden until it answers, so it cannot queue behind items.
 */
describe('the post-load reads wait for the planner', () => {
  const secrets = vi.fn<(userId: string) => Promise<void>>(async () => {});
  const gateway = vi.fn<(userId: string) => Promise<void>>(async () => {});
  const nudges = vi.fn<(userId: string) => Promise<void>>(async () => {});
  const extensions = vi.fn<(userId: string) => Promise<void>>(async () => {});
  const ai = vi.fn<(userId: string) => Promise<void>>(async () => {});
  const deferredStubs = [secrets, gateway, nudges];

  /** The load, held open until the test settles it. */
  let settle: (outcome?: { error: string }) => void = () => {};
  // Each test mounts a fresh provider, so its first load carries the preview
  // offer: the waits below expect OFFERED (intended, design §4).
  const heldLoad = vi.fn<LoadFn>((userId) => {
    // As the real one does: raised synchronously, before the first await.
    usePlannerStore.setState({ userId, isLoading: true });
    return new Promise<void>((resolve) => {
      settle = (outcome) => {
        // A load that bowed out (switched / signed out) leaves the store alone.
        if (usePlannerStore.getState().userId === userId) {
          usePlannerStore.setState({ isLoading: false, error: outcome?.error ?? null });
        }
        resolve();
      };
    });
  });

  const renderProvider = () =>
    render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

  beforeEach(() => {
    pathname = '/';
    settle = () => {};
    heldLoad.mockClear();
    loadSettings.mockClear();
    for (const fn of [...deferredStubs, extensions, ai]) fn.mockClear();
    usePlannerStore.getState().clearStore();
    usePlannerStore.setState({ initializeStore: heldLoad, error: null });
    useExtensionsStore.setState({ hydrate: extensions });
    useChannelSecretsStore.setState({ hydrate: secrets });
    useGatewayStore.setState({ hydrate: gateway });
    useNudgeStore.setState({ hydrate: nudges });
    useAIConnectionStore.setState({ hydrate: ai });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  afterEach(() => {
    cleanup();
    usePlannerStore.setState({ initializeStore: original.initializeStore, error: null });
    useExtensionsStore.setState({ hydrate: original.extensions });
    useChannelSecretsStore.setState({ hydrate: original.secrets });
    useGatewayStore.setState({ hydrate: original.gateway });
    useNudgeStore.setState({ hydrate: original.nudges });
    useAIConnectionStore.setState({ hydrate: original.ai });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  const settleLoad = async (outcome?: { error: string }) => {
    await act(async () => {
      settle(outcome);
      await Promise.resolve();
    });
  };

  it('on the planner: settings, extensions and the AI gate in the burst, the other three after it', async () => {
    renderProvider();
    await waitFor(() => expect(heldLoad).toHaveBeenCalledWith(USER, OFFERED));
    await waitFor(() => expect(loadSettings).toHaveBeenCalled());
    expect(extensions).toHaveBeenCalledWith(USER);
    // The load is still held open: the gate did not wait for it.
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai).toHaveBeenCalledWith(USER);
    for (const fn of deferredStubs) expect(fn).not.toHaveBeenCalled();

    await settleLoad();
    for (const fn of deferredStubs) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(USER);
    }
    // And the settle does not ask for it a second time.
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('the AI gate is asked on a lean route too, where there is no load at all', async () => {
    pathname = '/settings/day';
    renderProvider();
    await waitFor(() => expect(ai).toHaveBeenCalledWith(USER));
    expect(heldLoad).not.toHaveBeenCalled();
  });

  it('a FAILED load does not hold the AI gate back either', async () => {
    renderProvider();
    await waitFor(() => expect(heldLoad).toHaveBeenCalledWith(USER, OFFERED));
    expect(ai).toHaveBeenCalledWith(USER);
    await settleLoad({ error: 'boom' });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('a FAILED load still releases them — the settings rows do not wait on a retry', async () => {
    renderProvider();
    await waitFor(() => expect(heldLoad).toHaveBeenCalledWith(USER, OFFERED));
    await settleLoad({ error: 'boom' });
    for (const fn of deferredStubs) expect(fn).toHaveBeenCalledWith(USER);
  });

  it('on a lean route there is no load to wait for', async () => {
    pathname = '/settings/day';
    renderProvider();
    await waitFor(() => {
      for (const fn of deferredStubs) expect(fn).toHaveBeenCalledWith(USER);
    });
    expect(heldLoad).not.toHaveBeenCalled();
  });

  it('leaving for a lean route mid-load flushes them before the load settles', async () => {
    const view = renderProvider();
    await waitFor(() => expect(heldLoad).toHaveBeenCalledWith(USER, OFFERED));
    for (const fn of deferredStubs) expect(fn).not.toHaveBeenCalled();

    pathname = '/settings/day';
    view.rerender(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );
    for (const fn of deferredStubs) expect(fn).toHaveBeenCalledWith(USER);
    // The load's own `.then` may ask again later; the stores dedupe that.
    await settleLoad();
  });

  it("the boot's double adoption releases each read once", async () => {
    renderProvider();
    await waitFor(() => expect(heldLoad).toHaveBeenCalledWith(USER, OFFERED));
    // The SIGNED_IN the client raises at init, beside getSession's answer.
    act(() => emitAuth('SIGNED_IN', { user: { id: USER } }));
    expect(heldLoad).toHaveBeenCalledTimes(1);
    for (const fn of deferredStubs) expect(fn).not.toHaveBeenCalled();

    await settleLoad();
    for (const fn of deferredStubs) expect(fn).toHaveBeenCalledTimes(1);
  });

  it("an account switch mid-load: A's settle releases nothing, B's does", async () => {
    renderProvider();
    await waitFor(() => expect(heldLoad).toHaveBeenCalledWith(USER, OFFERED));
    const settleA = settle;

    act(() => emitAuth('SIGNED_IN', { user: { id: 'user-b' } }));
    await waitFor(() => expect(heldLoad).toHaveBeenCalledWith('user-b'));
    const settleB = settle;
    // The gate is asked for B at once, with A's load still open.
    expect(ai).toHaveBeenLastCalledWith('user-b');

    await act(async () => {
      settleA();
      await Promise.resolve();
    });
    for (const fn of deferredStubs) expect(fn).not.toHaveBeenCalled();

    await act(async () => {
      settleB();
      await Promise.resolve();
    });
    for (const fn of deferredStubs) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('user-b');
    }
  });

  it('a sign-out mid-load: the settle releases nothing', async () => {
    renderProvider();
    await waitFor(() => expect(heldLoad).toHaveBeenCalledWith(USER, OFFERED));
    act(() => emitAuth('SIGNED_OUT', null));
    await settleLoad();
    for (const fn of deferredStubs) expect(fn).not.toHaveBeenCalled();
  });

  it('a SIGNED_IN after the load has settled asks again — the stores own the dedupe', async () => {
    renderProvider();
    await waitFor(() => expect(heldLoad).toHaveBeenCalledWith(USER, OFFERED));
    await settleLoad();
    for (const fn of deferredStubs) expect(fn).toHaveBeenCalledTimes(1);

    // A visibility re-emit: what lets channel-secrets retry an un-stamped read.
    act(() => emitAuth('SIGNED_IN', { user: { id: USER } }));
    for (const fn of deferredStubs) expect(fn).toHaveBeenCalledTimes(2);
  });
});

/**
 * The planner snapshot (lib/planner-snapshot.ts) is a copy of every title and
 * note, and the provider owns two of the ways it is dropped. RAW_CLEARERS covers
 * an adoption and a SIGNED_OUT; these are the two paths no event reaches.
 */
describe('the planner snapshot', () => {
  const renderProvider = () =>
    render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

  beforeEach(() => {
    pathname = '/';
    mountSession = { user: { id: USER } };
    getSession.mockClear();
    clearPlannerSnapshot.mockClear();
    warmPlannerSnapshot.mockClear();
    startPlannerSnapshotWriter.mockClear();
    stopPlannerSnapshotWriter.mockClear();
    initializeStore.mockClear();
    loadSettings.mockClear();
    usePlannerStore.getState().clearStore();
    usePlannerStore.setState({ initializeStore });
    useExtensionsStore.setState({ hydrate: async () => {} });
    useChannelSecretsStore.setState({ hydrate: async () => {} });
    useGatewayStore.setState({ hydrate: async () => {} });
    useNudgeStore.setState({ hydrate: async () => {} });
    useAIConnectionStore.setState({ hydrate: async () => {} });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mountSession = { user: { id: USER } };
    localStorage.removeItem(LOCAL_STATE_OWNER_KEY);
    sessionStorage.clear();
    usePlannerStore.setState({ initializeStore: original.initializeStore });
    useExtensionsStore.setState({ hydrate: original.extensions });
    useChannelSecretsStore.setState({ hydrate: original.secrets });
    useGatewayStore.setState({ hydrate: original.gateway });
    useNudgeStore.setState({ hydrate: original.nudges });
    useAIConnectionStore.setState({ hydrate: original.ai });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  it('is purged at mount when no account owns this browser, ahead of the auth effect', () => {
    // /login after a sign-out whose IndexedDB clear the hard navigation
    // aborted: the owner stamp went synchronously, the snapshot did not.
    localStorage.removeItem(LOCAL_STATE_OWNER_KEY);
    renderProvider();
    // At mount, before getSession has answered (the adoption that follows
    // clears again through RAW_CLEARERS, which is local-state's to test).
    expect(clearPlannerSnapshot).toHaveBeenCalledTimes(1);
    expect(clearPlannerSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      getSession.mock.invocationCallOrder[0]
    );
  });

  it('is left alone at mount when an account owns this browser', async () => {
    localStorage.setItem(LOCAL_STATE_OWNER_KEY, USER);
    renderProvider();
    await waitFor(() => expect(initializeStore).toHaveBeenCalled());
    expect(clearPlannerSnapshot).not.toHaveBeenCalled();
  });

  it('is purged when the page has no session, on the way to /login', async () => {
    // The stamp outlives an expired session (lib/local-state.ts), so the
    // mount purge does not fire here; the no-session branch must.
    localStorage.setItem(LOCAL_STATE_OWNER_KEY, USER);
    mountSession = null;
    const replace = vi.spyOn(signedOutNav, 'replace').mockImplementation(() => {});
    renderProvider();
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(clearPlannerSnapshot).toHaveBeenCalledTimes(1);
    expect(initializeStore).not.toHaveBeenCalled();
  });

  it('is warmed beside getSession, for the owner on disk, where items are needed', async () => {
    localStorage.setItem(LOCAL_STATE_OWNER_KEY, USER);
    renderProvider();
    // A prefetch only: started BEFORE getSession is even asked, so a slow token
    // refresh is not also a slow preview. Nothing paints until the load offers.
    expect(warmPlannerSnapshot).toHaveBeenCalledTimes(1);
    expect(warmPlannerSnapshot).toHaveBeenCalledWith(USER);
    expect(warmPlannerSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      getSession.mock.invocationCallOrder[0]
    );
    await waitFor(() => expect(initializeStore).toHaveBeenCalled());
  });

  it('is warmed with the stamp as it stands — null on an unowned browser', () => {
    // The snapshot module opens nothing for a null hint; what matters here is
    // that the provider asks with localStateOwner(), not with a guess.
    renderProvider();
    expect(warmPlannerSnapshot).toHaveBeenCalledTimes(1);
    expect(warmPlannerSnapshot).toHaveBeenCalledWith(null);
  });

  it('is not warmed on a lean route, which has no load to preview', async () => {
    localStorage.setItem(LOCAL_STATE_OWNER_KEY, USER);
    pathname = '/settings/day';
    renderProvider();
    await waitFor(() => expect(usePlannerStore.getState().userId).toBe(USER));
    expect(warmPlannerSnapshot).not.toHaveBeenCalled();
  });

  it("runs the snapshot writer for the provider's lifetime", () => {
    localStorage.setItem(LOCAL_STATE_OWNER_KEY, USER);
    const view = renderProvider();
    expect(startPlannerSnapshotWriter).toHaveBeenCalledTimes(1);
    expect(stopPlannerSnapshotWriter).not.toHaveBeenCalled();
    view.unmount();
    expect(stopPlannerSnapshotWriter).toHaveBeenCalledTimes(1);
  });
});

/**
 * The look-only preview is OFFERED by the provider and applied by the store
 * (initializeStore's `preview` option, lib/planner-store.ts). The provider owns
 * two things about it: it is offered once per page, on the first load, and the
 * offer's predicate is asked at APPLY time — the route and the dialog slot as
 * they are when the cache arrives, not when the load began.
 */
describe('the preview offer', () => {
  const renderProvider = () =>
    render(
      <SupabaseProvider>
        <div />
      </SupabaseProvider>
    );

  /** The predicate the page's first load was handed. */
  const offered = () => {
    const call = initializeStore.mock.calls.find((c) => c[1]?.preview);
    expect(call, 'no load carried the offer').toBeDefined();
    return call![1]!.preview!;
  };

  beforeEach(() => {
    pathname = '/';
    window.history.replaceState({}, '', '/');
    initializeStore.mockClear();
    loadSettings.mockClear();
    usePlannerStore.getState().clearStore();
    usePlannerStore.setState({ initializeStore });
    useExtensionsStore.setState({ hydrate: async () => {} });
    useChannelSecretsStore.setState({ hydrate: async () => {} });
    useGatewayStore.setState({ hydrate: async () => {} });
    useNudgeStore.setState({ hydrate: async () => {} });
    useAIConnectionStore.setState({ hydrate: async () => {} });
    useMorningStore.setState({ settingsHydratedUserId: null });
    useUIStore.setState({ activeDialog: null, deferredDialog: null });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
    useUIStore.setState({ activeDialog: null, deferredDialog: null });
    usePlannerStore.setState({ initializeStore: original.initializeStore });
    useExtensionsStore.setState({ hydrate: original.extensions });
    useChannelSecretsStore.setState({ hydrate: original.secrets });
    useGatewayStore.setState({ hydrate: original.gateway });
    useNudgeStore.setState({ hydrate: original.nudges });
    useAIConnectionStore.setState({ hydrate: original.ai });
    useMorningStore.setState({ settingsHydratedUserId: null });
  });

  it("asks at apply time: on '/', and with no data dialog armed", async () => {
    renderProvider();
    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER, OFFERED));
    const allowed = offered();
    expect(allowed()).toBe(true);

    // /settings arms Organize and pushes '/': that console opens on fresh data.
    useUIStore.setState({ activeDialog: { type: 'organize' } });
    expect(allowed()).toBe(false);
    useUIStore.setState({ activeDialog: null, deferredDialog: { type: 'organize' } });
    expect(allowed()).toBe(false);
    useUIStore.setState({ deferredDialog: null });
    expect(allowed()).toBe(true);

    // Left '/' while the cache was still being read: no preview off the planner.
    window.history.pushState({}, '', '/item/x');
    expect(allowed()).toBe(false);
  });

  it('a first load on /item/x spends the offer, and its answer there is no', async () => {
    pathname = '/item/x';
    window.history.replaceState({}, '', '/item/x');
    renderProvider();
    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER, OFFERED));
    // The inline editor there autosaves; it never sees the cache.
    expect(offered()()).toBe(false);

    // The next load in this page — an account switch here — is bare.
    act(() => emitAuth('SIGNED_IN', { user: { id: 'user-b' } }));
    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith('user-b'));
    expect(initializeStore).toHaveBeenCalledTimes(2);
    expect(initializeStore.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it('a retry after a failed first load is bare', async () => {
    // initializeStore RESOLVES on failure with `error` set; the provider
    // unlatches and the next SIGNED_IN loads again — with no offer, so an
    // offline retry never flickers cached → empty → cached.
    initializeStore.mockImplementationOnce(async (userId: string) => {
      usePlannerStore.setState({ userId, isLoading: false, error: 'offline', loadFailedUserId: userId });
    });
    renderProvider();
    await waitFor(() => expect(initializeStore).toHaveBeenCalledWith(USER, OFFERED));
    await waitFor(() => expect(usePlannerStore.getState().error).toBe('offline'));

    act(() => emitAuth('SIGNED_IN', { user: { id: USER } }));
    await waitFor(() => expect(initializeStore).toHaveBeenCalledTimes(2));
    expect(initializeStore.mock.calls[1]).toEqual([USER]);
  });
});
