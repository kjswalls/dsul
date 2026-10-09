import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * db.plannerRequestsSent: what the preview waits for so the fresh load's
 * requests leave before its long render (lib/planner-store.ts offerPreview).
 *
 * supabase-js answers getSession in the order it was asked (a first come,
 * first served auth lock), and each request is sent in the microtasks after
 * its own getSession is answered. So "sent" is: a getSession asked AFTER the
 * load's, answered, and one more task. The client is a stub here, so every
 * assertion is about that order and the cap, not about supabase-js itself.
 */

const hoisted = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<unknown>>(),
  createClient: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ createClient: hoisted.createClient }));

import { REQUESTS_SENT_CAP_MS, plannerRequestsSent } from '@/lib/db';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Starts it and reports whether it has resolved yet. */
function track() {
  let done = false;
  void plannerRequestsSent().then(() => {
    done = true;
  });
  return () => done;
}

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.getSession.mockReset();
  hoisted.createClient.mockReset();
  hoisted.createClient.mockImplementation(() => ({ auth: { getSession: hoisted.getSession } }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('plannerRequestsSent', () => {
  it("asks for the session a task later, behind the load's own ask", async () => {
    hoisted.getSession.mockImplementation(() => new Promise(() => {}));
    track();
    // The load's request asks a few microtasks after loadPlannerData returns.
    const loadAsks = vi.fn(() => hoisted.getSession());
    queueMicrotask(() => queueMicrotask(loadAsks));
    await flush();
    expect(loadAsks).toHaveBeenCalledTimes(1);
    expect(hoisted.getSession).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(0);
    expect(hoisted.getSession).toHaveBeenCalledTimes(2);
    expect(loadAsks.mock.invocationCallOrder[0]).toBeLessThan(hoisted.getSession.mock.invocationCallOrder[1]);
  });

  it('resolves one task after its own getSession is answered, not before', async () => {
    const answer = deferred<unknown>();
    hoisted.getSession.mockImplementation(() => answer.promise);
    const done = track();
    vi.advanceTimersByTime(0);
    expect(hoisted.getSession).toHaveBeenCalledTimes(1);
    await flush();
    expect(done()).toBe(false);

    answer.resolve({ data: { session: null }, error: null });
    await flush();
    // The load's own continuation (its fetch) gets the microtasks first.
    expect(done()).toBe(false);
    vi.advanceTimersByTime(0);
    await flush();
    expect(done()).toBe(true);
  });

  it(`gives up after ${REQUESTS_SENT_CAP_MS}ms when the lock is held elsewhere`, async () => {
    hoisted.getSession.mockImplementation(() => new Promise(() => {}));
    const done = track();
    vi.advanceTimersByTime(REQUESTS_SENT_CAP_MS - 1);
    await flush();
    expect(done()).toBe(false);
    vi.advanceTimersByTime(1);
    await flush();
    expect(done()).toBe(true);
  });

  it('a rejected getSession still lets the caller go', async () => {
    hoisted.getSession.mockImplementation(() => Promise.reject(new Error('lock stolen')));
    const done = track();
    vi.advanceTimersByTime(0);
    await flush();
    vi.advanceTimersByTime(0);
    await flush();
    expect(done()).toBe(true);
  });

  it('a client that cannot be built still lets the caller go', async () => {
    hoisted.createClient.mockImplementation(() => {
      throw new Error('no env');
    });
    const done = track();
    vi.advanceTimersByTime(0);
    // Its last task was queued from inside a timer, which fake timers put 1ms on.
    vi.advanceTimersByTime(1);
    await flush();
    expect(done()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind once it has resolved', async () => {
    hoisted.getSession.mockImplementation(async () => ({ data: { session: null }, error: null }));
    const done = track();
    vi.advanceTimersByTime(0);
    await flush();
    vi.advanceTimersByTime(0);
    await flush();
    expect(done()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
