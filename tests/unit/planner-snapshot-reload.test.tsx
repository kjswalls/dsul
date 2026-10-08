import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Component, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';

import type { PlannerSnapshotData } from '@/lib/planner-snapshot';
import type { Item } from '@/lib/planner-types';

/**
 * The crash marker across a reload, end to end: the real snapshot module, the
 * real writer, the real planner store, SettleHost and PreviewCrashBoundary,
 * over fake IndexedDB. Only the load itself is held, as a slow network holds
 * load_planner, and the settle conductor is a stub (it has its own suite).
 *
 * A "page" is a fresh module graph over the SAME sessionStorage and the SAME
 * database, which is all a reload keeps. A reload that runs pagehide runs it
 * here by dispatching it; a page that hung or was killed simply never does.
 *
 * The rule under test: the marker purges the snapshot only for a preview that
 * hung or crashed its page. A reload, a navigation, pull-to-refresh or a tab
 * put away while a cleanly rendered preview is up costs the next page nothing.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** Every load stays out, as on a stalled connection: the preview never ends by landing here. */
const pendingLoads: Deferred<unknown>[] = [];

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/db');
  const mocked: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== 'function' || name === 'itemDbType') continue;
    mocked[name] = vi.fn(async () => (name.startsWith('fetch') ? [] : undefined));
  }
  mocked.loadPlannerData = vi.fn(() => {
    const d = deferred<unknown>();
    pendingLoads.push(d);
    return d.promise;
  });
  return mocked;
});
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/settle', () => ({
  registerSettleHost: () => () => {},
  notePreviewPainted: () => {},
  onLandingCommitted: () => {},
}));

const A = 'user-a';
const MARKER = 'dsul-preview-pending';

const task = (id: string, title: unknown): Item =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: false, order: 0, completedDates: [] }) as Item;

function cached(items: Item[] = [task('t-1', 'Cached title'), task('t-2', 'Another')]): PlannerSnapshotData {
  return {
    items,
    projects: [],
    itemTypes: [],
    routines: [],
    seasons: [],
    goals: [],
    itemTypesAvailable: true,
    collectionsAvailable: true,
    goalsAvailable: true,
  };
}

/* ── pages ───────────────────────────────────────────────────────────────── */

type Page = {
  snap: typeof import('@/lib/planner-snapshot');
  usePlannerStore: typeof import('@/lib/planner-store').usePlannerStore;
  SettleHost: typeof import('@/components/shell/settle-host').SettleHost;
  PreviewCrashBoundary: typeof import('@/components/shell/preview-crash-boundary').PreviewCrashBoundary;
};

const writers: (() => void)[] = [];

/** A fresh page on `/`: new modules, the writer started as the provider starts it. */
async function bootPage(): Promise<Page> {
  vi.resetModules();
  const snap = await import('@/lib/planner-snapshot');
  const { usePlannerStore } = await import('@/lib/planner-store');
  const { startPlannerSnapshotWriter } = await import('@/lib/planner-snapshot-writer');
  const { SettleHost } = await import('@/components/shell/settle-host');
  const { PreviewCrashBoundary } = await import('@/components/shell/preview-crash-boundary');
  writers.push(startPlannerSnapshotWriter());
  return { snap, usePlannerStore, SettleHost, PreviewCrashBoundary };
}

/** Only the snapshot module: what the next page's warm-up and read touch first. */
async function nextPageSnapshot(): Promise<Page['snap']> {
  vi.resetModules();
  return import('@/lib/planner-snapshot');
}

/** Last session left A's planner on disk. */
async function lastSessionWrote(data = cached()) {
  const earlier = await nextPageSnapshot();
  expect(await earlier.writePlannerSnapshot(A, data, Date.now(), earlier.getSnapshotEpoch())).toBe(true);
}

/** Sign-in on `/`: the warm-up, then the first load offering the preview, until it paints. */
async function preview(page: Page) {
  page.snap.warmPlannerSnapshot(A);
  page.usePlannerStore.getState().identifyUser(A);
  void page.usePlannerStore.getState().initializeStore(A, { preview: () => true });
  await vi.waitFor(() => expect(page.usePlannerStore.getState().isPreview).toBe(true));
}

/* ── the tree: AppShell's place, as app/page.tsx lays it out ─────────────── */

/** The page whose store the components below read. Set before each render, never during one. */
let current: Page;
/** When a component ABOVE the boundary (outside AppShell) throws on the preview's rows. */
let aboveThrows: (s: { isPreview: boolean; compactMode: boolean }) => boolean = () => false;

/** A stand-in for the views: a row per item, and a cached row this build cannot render throws. */
function Rows() {
  const items = current.usePlannerStore((s) => s.items);
  return (
    <ul>
      {items.map((i) => (
        <li key={i.id} data-testid="row">
          {(i.title as string).trim()}
        </li>
      ))}
    </ul>
  );
}

/** A consumer above AppShell, which the preview boundary does not wrap. */
function Above() {
  const isPreview = current.usePlannerStore((s) => s.isPreview);
  const compactMode = current.usePlannerStore((s) => s.compactMode);
  if (aboveThrows({ isPreview, compactMode })) throw new Error('a consumer above AppShell cannot render the cached rows');
  return null;
}

/** Whatever catches above the page: Next's root boundary, in the app. */
class Root extends Component<{ children: ReactNode }, { caught: boolean }> {
  state = { caught: false };
  static getDerivedStateFromError() {
    return { caught: true };
  }
  render() {
    return this.state.caught ? <p data-testid="root-fallback" /> : this.props.children;
  }
}

function mount(page: Page) {
  current = page;
  const { PreviewCrashBoundary, SettleHost } = page;
  return render(
    <Root>
      <Above />
      <PreviewCrashBoundary>
        <SettleHost />
        <Rows />
      </PreviewCrashBoundary>
    </Root>
  );
}

/* ── the browser ─────────────────────────────────────────────────────────── */

const setVisibility = (state: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
const pagehide = () => window.dispatchEvent(new Event('pagehide'));
const hide = () => {
  setVisibility('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
};
const show = () => {
  setVisibility('visible');
  document.dispatchEvent(new Event('visibilitychange'));
};

/** The old page is gone: its tree and its writer with it. Its connections stay, as a dying page's may. */
function pageGone() {
  cleanup();
  while (writers.length) writers.pop()!();
}

/* ── the disk, through a connection of the test's own ────────────────────── */

function rawKeys(snap: Page['snap']): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(snap.SNAPSHOT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(snap.SNAPSHOT_STORE);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(snap.SNAPSHOT_STORE, 'readonly');
      const keys = tx.objectStore(snap.SNAPSHOT_STORE).getAllKeys();
      tx.oncomplete = () => {
        db.close();
        resolve(keys.result.map(String).sort());
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** The next page finds the marker: it purges the database and skips the preview. */
async function expectNextPagePurges() {
  const next = await nextPageSnapshot();
  const del = vi.spyOn(indexedDB, 'deleteDatabase');
  next.warmPlannerSnapshot(A);
  expect(del).toHaveBeenCalledWith(next.SNAPSHOT_DB);
  expect(sessionStorage.getItem(MARKER)).toBeNull();
  expect(await next.readPlannerSnapshot(A)).toBeNull();
  await vi.waitFor(async () => expect(await rawKeys(next)).toEqual([]));
}

/** The next page finds no marker, deletes nothing, and paints last session's planner again. */
async function expectNextPagePreviews(ids = ['t-1', 't-2']) {
  const next = await bootPage();
  const del = vi.spyOn(indexedDB, 'deleteDatabase');
  await preview(next);
  expect(del).not.toHaveBeenCalled();
  expect(next.usePlannerStore.getState().items.map((i) => i.id).sort()).toEqual(ids);
  expect(sessionStorage.getItem(MARKER)).toBe('1'); // armed again, by this page's preview
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  sessionStorage.clear();
  aboveThrows = () => false;
  // React reports every caught render error; the boundary and the writer warn.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  pageGone();
  pendingLoads.length = 0; // abandoned, as a reload abandons them
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('leaving a cleanly rendered preview is not a crash', () => {
  it('a reload (pagehide) while the load is still out: the next page previews again', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    mount(page);
    expect(screen.getAllByTestId('row')).toHaveLength(2);
    expect(sessionStorage.getItem(MARKER)).toBe('1');
    expect(page.snap.previewRenderedCleanly()).toBe(true);

    pagehide();
    expect(sessionStorage.getItem(MARKER)).toBeNull();
    expect(page.usePlannerStore.getState().isPreview).toBe(true); // still up: the load never landed
    pageGone();

    await expectNextPagePreviews();
  });

  it('a tab put away and discarded in the background: the restored page previews again', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    mount(page);

    hide(); // a discarded tab gets this, and never its pagehide
    expect(sessionStorage.getItem(MARKER)).toBeNull();
    pageGone();

    await expectNextPagePreviews();
  });
});

/** A client navigation: AppShell (and SettleHost's hold) unmounts, the preview stays up, the URL moves. */
function navigateOffPlanner(view: ReturnType<typeof render>, path = '/settings') {
  view.unmount();
  window.history.pushState({}, '', path);
}

describe('leaving the planner mid-preview is not a crash either', () => {
  afterEach(() => window.history.pushState({}, '', '/'));

  it('navigated to /settings, then reloaded there: the next page previews again', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    navigateOffPlanner(mount(page));
    expect(page.usePlannerStore.getState().isPreview).toBe(true); // the load is still out
    expect(page.snap.previewRenderedCleanly()).toBe(true);

    pagehide();
    expect(sessionStorage.getItem(MARKER)).toBeNull();
    pageGone();

    await expectNextPagePreviews();
  });

  it('navigated away and the PWA killed in the background: the restored page previews again', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    navigateOffPlanner(mount(page));

    hide();
    expect(sessionStorage.getItem(MARKER)).toBeNull();
    pageGone();

    await expectNextPagePreviews();
  });

  it('still keeps the marker off `/` for a page whose preview never committed', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    window.history.pushState({}, '', '/settings');
    expect(page.snap.previewRenderedCleanly()).toBe(false);

    pagehide();
    expect(sessionStorage.getItem(MARKER)).toBe('1');
  });

  it('still keeps the marker off `/` once the crash boundary has caught a throw', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    const view = mount(page);
    page.snap.notePreviewThrew();
    navigateOffPlanner(view);
    expect(page.snap.previewRenderedCleanly()).toBe(false);

    pagehide();
    expect(sessionStorage.getItem(MARKER)).toBe('1');
  });
});

describe('a preview that hung or crashed its page still purges', () => {
  it('a page that never reaches pagehide (hung on the preview, or killed)', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    mount(page);
    expect(page.snap.previewRenderedCleanly()).toBe(true);
    pageGone(); // no pagehide: a hung page runs none of its handlers

    await expectNextPagePurges();
  });

  it('a page hidden, shown again, then hung: coming back armed it again', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    mount(page);

    hide();
    expect(sessionStorage.getItem(MARKER)).toBeNull();
    show();
    expect(sessionStorage.getItem(MARKER)).toBe('1');
    pageGone();

    await expectNextPagePurges();
  });

  /** After the throw: handed to the root, the hold gone, the store still previewing, and the marker kept on the way out. */
  async function expectMarkerOutlivesTheWayOut(page: Page) {
    expect(screen.getByTestId('root-fallback')).toBeInTheDocument();
    expect(page.snap.previewRenderedCleanly()).toBe(false);
    expect(page.usePlannerStore.getState().isPreview).toBe(true); // nothing ended it

    pagehide();
    hide();
    expect(sessionStorage.getItem(MARKER)).toBe('1');
    pageGone();

    await expectNextPagePurges();
  }

  it('a throw above AppShell on the preview’s first render, so it never commits', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    aboveThrows = (s) => s.isPreview;
    mount(page);

    await expectMarkerOutlivesTheWayOut(page);
  });

  it('a throw above AppShell after the preview committed: the unmount lets go of the hold', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    aboveThrows = (s) => s.isPreview && s.compactMode;
    mount(page);
    expect(page.snap.previewRenderedCleanly()).toBe(true);

    act(() => page.usePlannerStore.setState({ compactMode: true })); // a later render of the cached rows
    await expectMarkerOutlivesTheWayOut(page);
  });

  it('a throw the crash boundary catches: the preview and the snapshot are dropped at once, and the way out restores neither', async () => {
    await lastSessionWrote(cached([task('t-1', 'Cached title'), task('t-bad', null)]));
    const page = await bootPage();
    await preview(page);
    mount(page);

    // Dropped on this page: the skeleton's state, the marker gone with the preview, the disk emptied.
    const s = page.usePlannerStore.getState();
    expect(s.isPreview).toBe(false);
    expect(s.isLoading).toBe(true);
    expect(s.items).toEqual([]);
    expect(screen.queryByTestId('root-fallback')).toBeNull();
    expect(sessionStorage.getItem(MARKER)).toBeNull();
    expect(page.snap.previewRenderedCleanly()).toBe(false);
    await vi.waitFor(async () => expect(await rawKeys(page.snap)).toEqual([]));

    pagehide();
    pageGone();

    const next = await nextPageSnapshot();
    expect(await next.readPlannerSnapshot(A)).toBeNull();
    expect(await rawKeys(next)).toEqual([]);
  });

  it('a throw the crash boundary catches but cannot drop: handed on, and the marker outlives pagehide', async () => {
    await lastSessionWrote();
    const page = await bootPage();
    await preview(page);
    page.usePlannerStore.setState({
      dropPreview: () => {
        throw new Error('a store that cannot drop');
      },
    });
    const { PreviewCrashBoundary, SettleHost } = page;
    function Throws(): ReactNode {
      throw new Error('a bug of our own');
    }
    render(
      <Root>
        <PreviewCrashBoundary>
          <SettleHost />
          <Throws />
        </PreviewCrashBoundary>
      </Root>
    );
    expect(screen.getByTestId('root-fallback')).toBeInTheDocument();
    expect(page.usePlannerStore.getState().isPreview).toBe(true);
    expect(page.snap.previewRenderedCleanly()).toBe(false);

    pagehide();
    expect(sessionStorage.getItem(MARKER)).toBe('1');
    pageGone();

    await expectNextPagePurges();
  });
});

describe("SettleHost's hold", () => {
  it('runs from the preview’s commit until it ends or SettleHost unmounts', async () => {
    const page = await bootPage();
    current = page;
    const { SettleHost } = page;
    const view = render(<SettleHost />);
    const set = (isPreview: boolean) => act(() => page.usePlannerStore.setState({ isPreview }));

    expect(page.snap.previewRenderedCleanly()).toBe(false);
    set(true);
    expect(page.snap.previewRenderedCleanly()).toBe(true);
    set(false);
    expect(page.snap.previewRenderedCleanly()).toBe(false);
    set(true);
    expect(page.snap.previewRenderedCleanly()).toBe(true);
    view.unmount();
    expect(page.snap.previewRenderedCleanly()).toBe(false);
  });
});
