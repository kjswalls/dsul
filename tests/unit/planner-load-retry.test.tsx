import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent, screen } from '@testing-library/react';

/**
 * "Couldn't load your data", in the app as it is put together: the REAL
 * SupabaseProvider, the REAL planner store and the REAL docks, with the
 * database, the auth client, settings, routing and the other stores' boot-time
 * loads stood in for.
 *
 * Every way back from a failed load was dead until the store stopped reading a
 * failed account as a loaded one. The dock's Retry re-entered the load and was
 * turned away, and so was the provider's own retry, which unlatches on a
 * failure precisely so that the next SIGNED_IN (Supabase sends one when the tab
 * is shown with a live session) or the next arrival on a route that needs the
 * planner loads again. Counted here in `fetchItems` calls, because the old code
 * did call the load again; the load just returned before fetching.
 *
 * Every item fetch is a deferred the test settles by hand, and every failure is
 * a plain PostgREST error object, as the fetchers really throw.
 */

const A = 'user-a';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ctl = {
  items: [] as Deferred<unknown[]>[],
  /** Off: every account reads as already seeded, so the seed stops at once. */
  holdSeeding: false,
  /** Every read of the seed latch, held or not. */
  seedReads: 0,
  seeded: [] as Deferred<boolean>[],
  trash: [] as Deferred<{ projects: { name: string }[] }>[],
  created: [] as string[],
  marked: [] as string[],
};

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(() => {
      const d = deferred<unknown[]>();
      ctl.items.push(d);
      return d.promise;
    }),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    fetchRoutines: vi.fn(async () => []),
    fetchPrograms: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
    fetchContainersSeeded: vi.fn(() => {
      ctl.seedReads++;
      if (!ctl.holdSeeding) return Promise.resolve(true);
      const d = deferred<boolean>();
      ctl.seeded.push(d);
      return d.promise;
    }),
    fetchTrashedNames: vi.fn(() => {
      if (!ctl.holdSeeding) return Promise.resolve({ projects: [] });
      const d = deferred<{ projects: { name: string }[] }>();
      ctl.trash.push(d);
      return d.promise;
    }),
    markContainersSeeded: vi.fn(async (userId: string) => {
      ctl.marked.push(userId);
    }),
    createProject: vi.fn(async (_userId: string, project: { name: string }) => {
      ctl.created.push(project.name);
    }),
    adoptContainerMembers: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/settings-service', () => ({
  loadSettings: vi.fn(async () => ({})),
  saveSettings: vi.fn(),
  flushSettings: vi.fn(async () => {}),
}));

let emitAuth: (event: string, session: { user: { id: string } } | null) => void = () => {};
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: A } } } }),
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        emitAuth = cb as typeof emitAuth;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  }),
}));

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));
let pathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { SupabaseProvider } from '@/components/providers/supabase-provider';
import { DockNotices, DockNoticesMobile } from '@/components/sidebar/dock-notices';
import { usePlannerStore } from '@/lib/planner-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useChannelSecretsStore } from '@/lib/channel-secrets-store';
import { useGatewayStore } from '@/lib/gateway-store';
import { useNudgeStore } from '@/lib/nudge-store';
import { useMorningStore } from '@/lib/morning-store';
import * as db from '@/lib/db';

const original = {
  extensions: useExtensionsStore.getState().hydrate,
  secrets: useChannelSecretsStore.getState().hydrate,
  gateway: useGatewayStore.getState().hydrate,
  nudges: useNudgeStore.getState().hydrate,
};

const store = () => usePlannerStore.getState();
const fetches = () => vi.mocked(db.fetchItems).mock.calls.length;
const postgrestError = () => ({ message: 'upstream request timeout', details: null, hint: null, code: '' });
const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  type: 'task',
  completedDates: [],
  ...extra,
});
/** Let every pending promise and the renders they cause run out. */
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));
const noticeRow = () => screen.queryByText('Couldn’t load your data');
/** The whole row is the button; "Retry" is a label inside it. */
const pressRetry = () => fireEvent.click(noticeRow()!.closest('button')!);
const signedIn = () => act(async () => emitAuth('SIGNED_IN', { user: { id: A } }));
/** The Nth item fetch, counting from 0, which must have been made. */
const itemFetch = (n: number) => {
  expect(fetches()).toBeGreaterThan(n);
  return ctl.items[n];
};
const loadFailures = () =>
  consoleError.mock.calls.filter(([what]) => what === 'planner load failed').length;

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  pathname = '/';
  ctl.items = [];
  ctl.holdSeeding = false;
  ctl.seedReads = 0;
  ctl.seeded = [];
  ctl.trash = [];
  ctl.created = [];
  ctl.marked = [];
  vi.mocked(db.fetchItems).mockClear();
  store().clearStore();
  useSidebarStore.setState({ leftSidebarOpen: true });
  useExtensionsStore.setState({ hydrate: async () => {} });
  useChannelSecretsStore.setState({ hydrate: async () => {} });
  useGatewayStore.setState({ hydrate: async () => {} });
  useNudgeStore.setState({ hydrate: async () => {} });
  useMorningStore.setState({ settingsHydratedUserId: null, morningAutoAgeReceiptByUser: {} });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  // The load's own record of a failure is expected; anything else logged here
  // (a render error, a seed that failed) went wrong unseen.
  const unexpected = consoleError.mock.calls.filter(([what]) => what !== 'planner load failed');
  vi.useRealTimers();
  vi.restoreAllMocks();
  useExtensionsStore.setState({ hydrate: original.extensions });
  useChannelSecretsStore.setState({ hydrate: original.secrets });
  useGatewayStore.setState({ hydrate: original.gateway });
  useNudgeStore.setState({ hydrate: original.nudges });
  expect(unexpected).toEqual([]);
});

type Dock = typeof DockNotices;

/** Open the app and let its first load fail. */
async function failFirstLoad(Dock: Dock = DockNotices) {
  render(
    <SupabaseProvider>
      <Dock />
    </SupabaseProvider>
  );
  await waitFor(() => expect(ctl.items).toHaveLength(1));
  await act(async () => ctl.items[0].reject(postgrestError()));
  await flush();
  expect(store().error).toBe('Failed to load data');
  expect(noticeRow()).not.toBeNull();
}

describe.each([
  ['the desktop dock', DockNotices],
  ['the phone dock', DockNoticesMobile],
] as const)('Retry on “Couldn’t load your data”, in %s', (_, Dock) => {
  it('loads the data, and the row goes', async () => {
    await failFirstLoad(Dock);

    pressRetry();
    await flush();
    expect(fetches()).toBe(2);

    await act(async () => itemFetch(1).resolve([task('a1')]));
    await flush();
    expect(store().items.map((i) => i.id)).toEqual(['a1']);
    expect(store().error).toBeNull();
    expect(noticeRow()).toBeNull();
    expect(loadFailures()).toBe(1);
  });

  it('brings the row back when the retry fails too', async () => {
    await failFirstLoad(Dock);

    pressRetry();
    // While it runs there is no failure to report.
    expect(noticeRow()).toBeNull();
    await flush();
    expect(fetches()).toBe(2);
    expect(noticeRow()).toBeNull();

    await act(async () => itemFetch(1).reject(postgrestError()));
    await flush();
    expect(store().error).toBe('Failed to load data');
    expect(noticeRow()).not.toBeNull();
    expect(loadFailures()).toBe(2);
  });
});

describe('the row, on the desktop dock', () => {
  it('stays dismissed for one failure, and shows again for the next', async () => {
    // Every failure stores the same fallback text, so a dismissal keyed on the
    // message hid every later one, including the provider's own retries.
    await failFirstLoad();
    fireEvent.click(screen.getByLabelText('Dismiss this warning'));
    expect(noticeRow()).toBeNull();

    await signedIn();
    await flush();
    await act(async () => itemFetch(1).reject(postgrestError()));
    await flush();

    expect(store().loadFailedUserId).toBe(A);
    expect(noticeRow()).not.toBeNull();
  });

  it('is not raised by an `error` the load did not write', async () => {
    // The row offers a Retry, and the store grants one only to a failed load.
    // A row keyed on `error` would offer a Retry that does nothing here.
    render(
      <SupabaseProvider>
        <DockNotices />
      </SupabaseProvider>
    );
    await waitFor(() => expect(ctl.items).toHaveLength(1));
    await act(async () => ctl.items[0].resolve([task('a1')]));
    await flush();

    act(() => usePlannerStore.setState({ error: 'Failed to save' }));
    await flush();

    expect(noticeRow()).toBeNull();
  });
});

describe('the retry the provider makes by itself', () => {
  it('loads on the next SIGNED_IN, which Supabase sends when the tab is shown', async () => {
    await failFirstLoad();

    await signedIn();
    await flush();
    expect(fetches()).toBe(2);

    await act(async () => itemFetch(1).resolve([task('a1')]));
    await flush();
    expect(store().items.map((i) => i.id)).toEqual(['a1']);
    expect(noticeRow()).toBeNull();
  });

  it('loads on coming back to a route that needs the planner', async () => {
    const app = () => (
      <SupabaseProvider>
        <DockNotices />
      </SupabaseProvider>
    );
    const { rerender } = render(app());
    await waitFor(() => expect(ctl.items).toHaveLength(1));
    await act(async () => ctl.items[0].reject(postgrestError()));
    await flush();
    expect(store().loadFailedUserId).toBe(A);

    // Settings loads no items, so going there asks for nothing...
    pathname = '/settings';
    rerender(app());
    await flush();
    expect(fetches()).toBe(1);

    // ...and coming back to the planner asks again.
    pathname = '/';
    rerender(app());
    await flush();
    expect(fetches()).toBe(2);
    await act(async () => itemFetch(1).resolve([task('a1')]));
    await flush();
    expect(store().items.map((i) => i.id)).toEqual(['a1']);
  });

  it('never loads without being asked, however long a failure sits', async () => {
    // One load per event, and none of its own: a retry that fed on its own
    // failure is how a client hammers a database that is already struggling.
    // The clock is faked, so "however long" is ten minutes, not ten
    // milliseconds, and a retry on any backoff shorter than that is caught.
    render(
      <SupabaseProvider>
        <DockNotices />
      </SupabaseProvider>
    );
    await waitFor(() => expect(ctl.items).toHaveLength(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const wait = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    await act(async () => ctl.items[0].reject(postgrestError()));
    await wait(10);
    expect(store().loadFailedUserId).toBe(A);
    for (let i = 0; i < 60; i++) await wait(10_000);
    expect(fetches()).toBe(1);

    await signedIn();
    await wait(10);
    await act(async () => itemFetch(1).reject(postgrestError()));
    for (let i = 0; i < 60; i++) await wait(10_000);
    expect(fetches()).toBe(2);
  });

  it('after a Retry-button recovery, neither reloads nor drops the undo history', async () => {
    // The button goes straight to the store, so the provider stays unlatched
    // and its next SIGNED_IN reaches the store's guard. That event is also
    // when the first-run seed, which the button path does not start, runs.
    await failFirstLoad();
    pressRetry();
    await flush();
    await act(async () => itemFetch(1).resolve([task('a1')]));
    await flush();
    act(() => usePlannerStore.setState({ items: [...store().items, task('typed')] } as never));
    await flush();
    expect(store().canUndo).toBe(true);

    await signedIn();
    await flush();

    expect(fetches()).toBe(2);
    expect(store().items.map((i) => i.id)).toEqual(['a1', 'typed']);
    expect(store().canUndo).toBe(true);
    expect(ctl.seedReads).toBeGreaterThan(0);
  });
});

describe('the first-run seed across a failure and a retry', () => {
  it('never commits a plan it made from the failed store', async () => {
    // An account with no container rows whose items name one: what the seed
    // should do for it is adopt that name, and nothing else.
    const rows = [task('x1', { project: 'Personal' }), task('x2', { project: 'Personal' })];
    ctl.holdSeeding = true;
    render(
      <SupabaseProvider>
        <DockNotices />
      </SupabaseProvider>
    );
    await waitFor(() => expect(ctl.items).toHaveLength(1));
    await act(async () => ctl.items[0].resolve(rows));
    await flush();
    // That load worked, so a seed started. It waits on its latch read.
    expect(ctl.seeded).toHaveLength(1);

    // Signed out and back in as the same person (another tab can do this),
    // and this time the load fails.
    await act(async () => emitAuth('SIGNED_OUT', null));
    await signedIn();
    await flush();
    await act(async () => itemFetch(1).reject(postgrestError()));
    await flush();
    expect(store().loadFailedUserId).toBe(A);

    // The first seed's latch read comes back "not seeded". What it would plan
    // from now is the failed store: no items, no containers, a new account.
    await act(async () => ctl.seeded[0].resolve(false));
    await flush();

    // The tab is shown and the retry loads the real rows...
    await signedIn();
    await flush();
    await act(async () => itemFetch(2).resolve(rows));
    await flush();
    expect(store().items.map((i) => i.id)).toEqual(['x1', 'x2']);

    // ...and every seed still waiting is answered.
    for (const read of ctl.seeded.slice(1)) await act(async () => read.resolve(false));
    await flush();
    for (const bin of ctl.trash) await act(async () => bin.resolve({ projects: [] }));
    await flush();

    // Adopted from the real rows, once. Planned from the failed store, this
    // was all six starter containers, latched for good.
    expect(ctl.created).toEqual(['Personal']);
    expect(ctl.marked).toEqual([A]);
  });
});
