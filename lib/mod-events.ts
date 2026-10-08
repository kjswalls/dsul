/**
 * The in-app event bus recipes and mods listen on (memory/plans/mods.md, "Recipes").
 *
 * Events are raised ONLY from the user's own store actions: toggleTaskStatus,
 * toggleHabitStatus, setItemsCompleted, setItemSkipped, addItem, addTask,
 * addHabit, addTasksBulk (planner-store, through its `emit`) and
 * saveLastReviewDate (eod-store). Undo (applyHistoryState) and agent merges
 * (mergeAgentStates) never pass those sites, so they raise nothing. Each site
 * raises once per real transition, after its set(); a write that changed
 * nothing says nothing.
 *
 * Four rules hold the design together:
 *
 * - Suppression is checked when an event is RAISED, never when it is
 *   dispatched. Dispatch is asynchronous, so by then the depth is back to 0
 *   and a recipe's own tick would get through. Recipes, mods and AI apply run
 *   inside `withSuppressed`, and every listener runs inside it too, so a
 *   listener's own SYNCHRONOUS writes can never cascade. The depth cannot be
 *   held across an await (it would swallow the user's own ticks meanwhile),
 *   so an async listener must wrap every write after an await in
 *   `withSuppressed` again, or that write raises like the user's.
 * - Dispatch is a task (setTimeout 0) queued after the user's action returns:
 *   the action's history entry already exists (history is saved synchronously
 *   on every set()), so whatever a listener writes is its own entry and ⌘Z
 *   takes it back before the user's tick. batchHistory is synchronous, so no
 *   dispatch can ever run inside an open (quiet) batch.
 * - Listeners are isolated: one that throws, or whose Promise rejects, is
 *   logged and the rest still run.
 * - A quiet batch that throws still delivers the events of the writes it
 *   applied: those writes are in its history entry and on their way to the
 *   database, so they happened (the cosmetic effects are dropped, these not).
 *
 * An undo can land between a tick and its dispatch, so the event is still
 * delivered; a consumer must re-check eligibility against live state.
 *
 * This module imports no store: planner-store imports it.
 */

export type ModEvent =
  | {
      /**
       * One per real transition. `item.skipped` also covers a skip that took
       * back the day's completion (done → skipped): no `item.uncompleted` is
       * raised for it, so a skip means "and no longer completed".
       */
      kind: 'item.completed' | 'item.uncompleted' | 'item.skipped';
      itemId: string;
      /**
       * The occurrence date the action acted on, yyyy-MM-dd. A one-off has
       * one occurrence: its startDate, or the day acted on when it has none.
       */
      date: string;
      /** itemTypeName(): 'task', 'habit' or a custom slug. */
      type: string;
    }
  | {
      kind: 'item.created';
      itemId: string;
      type: string;
      /** The item's startDate, when it has one. */
      date?: string;
    }
  | { kind: 'review.saved'; date: string };

/**
 * May be async (a returned thenable's rejection is logged); see the
 * suppression rule above for writes after an await.
 */
export type ModEventListener = (e: ModEvent) => unknown;

const listeners = new Set<ModEventListener>();
let queue: ModEvent[] = [];
let scheduled = false;
let suppressDepth = 0;

export function subscribeModEvents(fn: ModEventListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Run `fn` with raising switched off. Nests; a throw still restores the depth. */
export function withSuppressed<T>(fn: () => T): T {
  suppressDepth++;
  try {
    return fn();
  } finally {
    suppressDepth--;
  }
}

export function isModEventsSuppressed(): boolean {
  return suppressDepth > 0;
}

export function raiseModEvents(events: readonly ModEvent[]): void {
  if (suppressDepth > 0 || events.length === 0) return;
  queue.push(...events);
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 0);
  }
}

export function raiseModEvent(e: ModEvent): void {
  raiseModEvents([e]);
}

function flush(): void {
  const events = queue;
  queue = [];
  scheduled = false;
  for (const e of events) {
    for (const listener of [...listeners]) {
      // A listener unsubscribed earlier in this flush is skipped.
      if (!listeners.has(listener)) continue;
      try {
        const r = withSuppressed(() => listener(e));
        if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
          (r as PromiseLike<unknown>).then(undefined, (err: unknown) => console.error('[mod-events]', err));
        }
      } catch (err) {
        console.error('[mod-events]', err);
      }
    }
  }
}

/** Test-only: drop listeners, queue and depth. */
export function __resetModEventsForTests(): void {
  listeners.clear();
  queue = [];
  scheduled = false;
  suppressDepth = 0;
}
