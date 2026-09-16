import { describe, it, expect, beforeEach } from 'vitest';

import { usePlannerStore } from '@/lib/planner-store';
import type { Item, Project } from '@/lib/planner-types';

/**
 * `identifyUser` — the split of "who is signed in" from "the items have been
 * asked for".
 *
 * Before it, `userId` had one writer (`initializeStore`) and therefore one
 * meaning for both facts. Every property asserted here is one the routes that
 * skip the item load depend on, and none of them is visible from the planner,
 * where the load always runs.
 */

const ITEM = (id: string): Item =>
  ({
    id,
    title: id,
    type: 'task',
    status: 'pending',
    completedDates: [],
  }) as unknown as Item;

const A = 'user-a';
const B = 'user-b';

describe('identifyUser', () => {
  beforeEach(() => {
    usePlannerStore.getState().clearStore();
  });

  it('stamps the account without fetching, and reads as UNSETTLED', () => {
    usePlannerStore.getState().identifyUser(A);

    const s = usePlannerStore.getState();
    expect(s.userId).toBe(A);
    // The load has not been asked for. Every `!isLoading` gate in the app —
    // the overdue sweep, the auto-age sweep, AppShell's readiness check,
    // /item and /goal's not-found guards — must keep reading this store as
    // incomplete, because it is.
    expect(s.isLoading).toBe(true);
    expect(s.items).toEqual([]);
  });

  it('is a no-op for the account it already names', () => {
    usePlannerStore.getState().identifyUser(A);
    // Stand in for a finished load.
    usePlannerStore.setState({ items: [ITEM('one')], isLoading: false });

    // Supabase re-emits SIGNED_IN on every hidden→visible transition; this is
    // the tab switch.
    usePlannerStore.getState().identifyUser(A);

    const s = usePlannerStore.getState();
    expect(s.isLoading).toBe(false);
    expect(s.items.map((i) => i.id)).toEqual(['one']);
  });

  it("drops the previous account's rows when the user changes", () => {
    usePlannerStore.getState().identifyUser(A);
    usePlannerStore.setState({
      items: [ITEM('a-only')],
      projects: [{ id: 'p', name: 'A project' } as Project],
      isLoading: false,
    });

    usePlannerStore.getState().identifyUser(B);

    const s = usePlannerStore.getState();
    expect(s.userId).toBe(B);
    expect(s.items).toEqual([]);
    expect(s.projects).toEqual([]);
    expect(s.goals).toEqual([]);
    // And B must not be able to undo into A's session.
    expect(s.canUndo).toBe(false);
    expect(s.actionLog).toEqual([]);
  });

  it('leaves initializeStore free to run afterwards', async () => {
    // The trap this guards: initializeStore early-returns when the account is
    // already named AND nothing is loading. If the identity stamp looked like
    // a finished load, the route that later asks for items would be refused
    // and the planner would stay empty forever.
    usePlannerStore.getState().identifyUser(A);

    const before = usePlannerStore.getState();
    expect(before.userId).toBe(A);
    expect(before.isLoading).toBe(true);

    // The real guard, read directly: `userId === userId && !isLoading`.
    const wouldEarlyReturn = before.userId === A && !before.isLoading;
    expect(wouldEarlyReturn).toBe(false);
  });
});

/**
 * The three properties the adversarial review of this action turned up. Each
 * is invisible from the planner — where `initializeStore` always follows and
 * repairs the state by hand — and each becomes reachable the moment a route
 * holds an identity without loading items.
 */
describe('identifyUser: the state initializeStore would otherwise have fixed', () => {
  beforeEach(() => {
    usePlannerStore.getState().clearStore();
  });

  it('re-opens the history baseline for the new session', async () => {
    // Drive the subscriber's lazy-baseline branch once, the way a session with
    // no initializeStore does, so `hasInitializedHistory` is left true.
    usePlannerStore.getState().identifyUser(A);
    usePlannerStore.setState({ items: [ITEM('a-only')], isLoading: false });
    await Promise.resolve();
    expect(usePlannerStore.getState().actionLog.length).toBeGreaterThan(0);

    usePlannerStore.getState().identifyUser(B);
    // A fresh account gets a fresh baseline: the first change B makes has to
    // be undoable, which means the subscriber must still be willing to record
    // a 'Session start' for it.
    usePlannerStore.setState({ items: [ITEM('b-only')], isLoading: false });
    await Promise.resolve();

    const s = usePlannerStore.getState();
    expect(s.actionLog.some((e) => e.label === 'Session start')).toBe(true);
    expect(s.historyIndex).toBeGreaterThanOrEqual(0);
  });

  it('restores availability flags so the next account is not gated by the last', () => {
    usePlannerStore.getState().identifyUser(A);
    // A's item_types table was unreachable.
    usePlannerStore.setState({ itemTypesAvailable: false, isLoading: false });

    usePlannerStore.getState().identifyUser(B);

    const s = usePlannerStore.getState();
    // Otherwise addItemType's opening guard drops B's custom types outright.
    expect(s.itemTypesAvailable).toBe(true);
    expect(s.collectionsAvailable).toBe(true);
    expect(s.goalsAvailable).toBe(true);
  });
});
