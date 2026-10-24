import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * Live sync (lib/planner-live.ts, hooks/use-planner-catch-up.ts). The channel
 * hears this user's rows only, and a change heard becomes one catch-up a moment
 * later: never one per row, never while the tab is hidden, and never for this
 * tab's own save coming back.
 */

const hoisted = vi.hoisted(() => ({
  catchUp: vi.fn(async () => [] as string[]),
  holds: vi.fn(() => false),
  state: { userId: 'user-1' as string | null, isLoading: false },
  channel: null as null | FakeChannel,
}));

interface FakeChannel {
  name: string;
  bindings: { event: string; table: string; filter: string; cb: (p: unknown) => void }[];
  status: ((s: string) => void) | null;
  on: (type: string, opts: { event: string; table: string; filter: string }, cb: (p: unknown) => void) => FakeChannel;
  subscribe: (cb: (s: string) => void) => FakeChannel;
}

const fakeClient = () => ({
  channel: vi.fn((name: string) => {
    const ch: FakeChannel = {
      name,
      bindings: [],
      status: null,
      on(_type, opts, cb) {
        ch.bindings.push({ event: opts.event, table: opts.table, filter: opts.filter, cb });
        return ch;
      },
      subscribe(cb) {
        ch.status = cb;
        return ch;
      },
    };
    hoisted.channel = ch;
    return ch;
  }),
  removeChannel: vi.fn(async () => 'ok'),
});
const client = fakeClient();

vi.mock('@/lib/supabase', () => ({ createClient: () => client }));
vi.mock('@/lib/planner-store', () => ({
  catchUpPlanner: hoisted.catchUp,
  storeHoldsItem: hoisted.holds,
  usePlannerStore: <T,>(sel: (s: typeof hoisted.state) => T) => sel(hoisted.state),
}));
vi.mock('@/lib/db', () => ({
  itemFromChangeRow: (row: { id?: string }) => (row?.id ? ({ id: row.id, type: 'task' } as never) : null),
}));

import { subscribePlannerChanges, LIVE_TABLES, LIVE_JOIN_TABLES } from '@/lib/planner-live';
import { usePlannerCatchUp, LIVE_SETTLE_MS, CATCH_UP_GAP_MS } from '@/hooks/use-planner-catch-up';

const emit = (table: string, row: Record<string, unknown> = { id: 'x' }, event = 'UPDATE') => {
  for (const b of hoisted.channel!.bindings) {
    if (b.table === table && b.event === event) b.cb({ eventType: event, new: row });
  }
};

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  hoisted.holds.mockReturnValue(false);
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('subscribePlannerChanges', () => {
  it('hears inserts and updates on every planner table, filtered to the user, and no deletes', () => {
    const stop = subscribePlannerChanges(client as never, 'user-1', { onChange: vi.fn(), onJoined: vi.fn() });
    const ch = hoisted.channel!;
    for (const table of [...LIVE_TABLES, ...LIVE_JOIN_TABLES]) {
      expect(ch.bindings.filter((b) => b.table === table).map((b) => b.event).sort()).toEqual(['INSERT', 'UPDATE']);
    }
    expect(ch.bindings.every((b) => b.filter === 'user_id=eq.user-1')).toBe(true);
    expect(ch.bindings.some((b) => b.event === 'DELETE' || b.event === '*')).toBe(false);
    stop();
    expect(client.removeChannel).toHaveBeenCalledWith(ch);
  });

  it('says when the channel rejoins after a drop', () => {
    const onJoined = vi.fn();
    subscribePlannerChanges(client as never, 'user-1', { onChange: vi.fn(), onJoined });
    hoisted.channel!.status!('SUBSCRIBED');
    hoisted.channel!.status!('CHANNEL_ERROR');
    hoisted.channel!.status!('SUBSCRIBED');
    expect(onJoined.mock.calls).toEqual([[false], [true]]);
  });
});

describe('usePlannerCatchUp, live', () => {
  it('folds a burst of changes into one catch-up after they settle', async () => {
    renderHook(() => usePlannerCatchUp());
    emit('items', { id: 'a' });
    emit('items', { id: 'b' });
    emit('goal_items', { goal_id: 'g' }, 'INSERT');
    expect(hoisted.catchUp).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_SETTLE_MS);
    });
    expect(hoisted.catchUp).toHaveBeenCalledTimes(1);
  });

  it('skips this tab’s own save coming back', async () => {
    hoisted.holds.mockReturnValue(true);
    renderHook(() => usePlannerCatchUp());
    emit('items', { id: 'a' });
    await act(async () => {
      vi.advanceTimersByTime(LIVE_SETTLE_MS * 2);
    });
    expect(hoisted.catchUp).not.toHaveBeenCalled();
  });

  it('holds a change heard while hidden until the tab is shown, past the gap', async () => {
    renderHook(() => usePlannerCatchUp());
    visibility = 'hidden';
    emit('projects', { id: 'p' });
    await act(async () => {
      vi.advanceTimersByTime(LIVE_SETTLE_MS * 2);
    });
    expect(hoisted.catchUp).not.toHaveBeenCalled();

    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(LIVE_SETTLE_MS);
    });
    expect(hoisted.catchUp).toHaveBeenCalledTimes(1);
  });

  it('catches up on a rejoin, and on return only past the gap', async () => {
    renderHook(() => usePlannerCatchUp());
    hoisted.channel!.status!('SUBSCRIBED');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(hoisted.catchUp).not.toHaveBeenCalled();

    hoisted.channel!.status!('SUBSCRIBED');
    await act(async () => {
      vi.advanceTimersByTime(LIVE_SETTLE_MS);
    });
    expect(hoisted.catchUp).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(CATCH_UP_GAP_MS);
      window.dispatchEvent(new Event('focus'));
    });
    expect(hoisted.catchUp).toHaveBeenCalledTimes(2);
  });

  it('stops hearing when unmounted', () => {
    const { unmount } = renderHook(() => usePlannerCatchUp());
    const ch = hoisted.channel!;
    unmount();
    expect(client.removeChannel).toHaveBeenCalledWith(ch);
  });
});
