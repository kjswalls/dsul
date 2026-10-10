import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  subscribeModEvents,
  raiseModEvent,
  raiseModEvents,
  withSuppressed,
  isModEventsSuppressed,
  __resetModEventsForTests,
  type ModEvent,
} from '@/lib/mod-events';

/**
 * The bus on its own (memory/plans/mods.md, "Recipes"): dispatch is a task
 * after the raise, suppression is decided at the raise, and listeners are
 * isolated from each other and from whoever raised.
 */

const done = (itemId: string): ModEvent => ({ kind: 'item.completed', itemId, date: '2026-03-10', type: 'task' });

beforeEach(() => {
  vi.useFakeTimers();
  __resetModEventsForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mod-events', () => {
  it('dispatches in a later task, in raise order', () => {
    const seen: string[] = [];
    subscribeModEvents((e) => seen.push((e as { itemId: string }).itemId));
    raiseModEvent(done('a'));
    raiseModEvents([done('b'), done('c')]);
    expect(seen).toEqual([]);
    vi.runAllTimers();
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('schedules one timer for a burst of raises', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    raiseModEvent(done('a'));
    raiseModEvent(done('b'));
    raiseModEvents([done('c')]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener is logged and never stops the others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    subscribeModEvents(() => {
      throw new Error('boom');
    });
    subscribeModEvents(after);
    raiseModEvent(done('a'));
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith('[mod-events]', expect.any(Error));
  });

  it('unsubscribes, including from inside a listener mid-flush', () => {
    const second = vi.fn();
    let unsubSecond = () => {};
    const unsubFirst = subscribeModEvents(() => unsubSecond());
    unsubSecond = subscribeModEvents(second);
    raiseModEvents([done('a'), done('b')]);
    vi.runAllTimers();
    expect(second).not.toHaveBeenCalled();

    unsubFirst();
    const third = vi.fn();
    subscribeModEvents(third);
    raiseModEvent(done('c'));
    vi.runAllTimers();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('drops a raise made while suppressed, and the suppression nests', () => {
    const seen = vi.fn();
    subscribeModEvents(seen);
    withSuppressed(() => {
      withSuppressed(() => raiseModEvent(done('inner')));
      expect(isModEventsSuppressed()).toBe(true);
      raiseModEvent(done('outer'));
    });
    expect(isModEventsSuppressed()).toBe(false);
    vi.runAllTimers();
    expect(seen).not.toHaveBeenCalled();
  });

  it('restores the depth after a throw', () => {
    expect(() =>
      withSuppressed(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(isModEventsSuppressed()).toBe(false);
  });

  it('a listener that raises raises nothing: listeners run suppressed', () => {
    const seen: ModEvent[] = [];
    subscribeModEvents((e) => {
      seen.push(e);
      raiseModEvent(done('cascade'));
    });
    raiseModEvent(done('a'));
    vi.runAllTimers();
    expect(seen.map((e) => (e as { itemId: string }).itemId)).toEqual(['a']);
  });

  it('an async listener: a rejection is logged, never unhandled', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    subscribeModEvents(async () => {
      await Promise.resolve();
      throw new Error('late');
    });
    subscribeModEvents(after);
    raiseModEvent(done('a'));
    vi.runAllTimers();
    expect(after).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith('[mod-events]', expect.any(Error)));
  });

  it('an async listener re-enters withSuppressed after an await, or its raise gets through', async () => {
    const seen: string[] = [];
    let settled!: Promise<void>;
    subscribeModEvents((e) => {
      seen.push((e as { itemId: string }).itemId);
      if ((e as { itemId: string }).itemId !== 'a') return;
      settled = (async () => {
        await Promise.resolve();
        withSuppressed(() => raiseModEvent(done('wrapped')));
        raiseModEvent(done('bare'));
      })();
    });
    raiseModEvent(done('a'));
    vi.runAllTimers();
    await settled;
    vi.runAllTimers();
    expect(seen).toEqual(['a', 'bare']);
  });
});
