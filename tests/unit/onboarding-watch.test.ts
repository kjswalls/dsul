import { describe, it, expect, vi } from 'vitest';
import { watchOnboardingAfterLoad } from '@/lib/onboarding-watch';
import { useUIStore } from '@/lib/ui-store';

type S = { userId: string | null; isLoading: boolean };

/** A minimal zustand-shaped store: getState + subscribe + set. */
function fakeStore(initial: S) {
  let state = initial;
  const subs = new Set<(s: S) => void>();
  return {
    getState: () => state,
    subscribe: (fn: (s: S) => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    set: (patch: Partial<S>) => {
      state = { ...state, ...patch };
      subs.forEach((fn) => fn(state));
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(initial: S, isComplete: (uid: string) => Promise<boolean>) {
  const store = fakeStore(initial);
  const check = vi.fn(isComplete);
  const onResult = vi.fn();
  const dispose = watchOnboardingAfterLoad({
    getState: store.getState,
    subscribe: store.subscribe,
    isComplete: check,
    onResult,
  });
  return { store, check, onResult, dispose };
}

describe('watchOnboardingAfterLoad', () => {
  it('does not read while there is no account or the load is in flight', async () => {
    const { store, check } = setup({ userId: null, isLoading: false }, async () => false);
    store.set({ userId: 'A', isLoading: true });
    await flush();
    expect(check).not.toHaveBeenCalled();
  });

  it('reads exactly once after the load settles', async () => {
    const { store, check, onResult } = setup({ userId: null, isLoading: false }, async () => false);
    store.set({ userId: 'A', isLoading: true });
    store.set({ isLoading: false });
    store.set({ isLoading: false });
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('A');
    expect(onResult).toHaveBeenCalledWith('A', true);
  });

  it('does not re-read on a same-account retry cycle', async () => {
    const { store, check } = setup({ userId: 'A', isLoading: true }, async () => true);
    store.set({ isLoading: false });
    await flush();
    store.set({ isLoading: true });
    store.set({ isLoading: false });
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('re-reads for a new account and reports "not needed" so A’s tour can be cleared', async () => {
    const done: Record<string, boolean> = { A: false, B: true };
    const { store, check, onResult } = setup(
      { userId: 'A', isLoading: false },
      async (uid) => done[uid]
    );
    await flush();
    store.set({ userId: 'B', isLoading: true });
    store.set({ isLoading: false });
    await flush();
    expect(check.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
    expect(onResult.mock.calls).toEqual([
      ['A', true],
      ['B', false],
    ]);
  });

  it('drops a result that arrives after the account changed', async () => {
    let resolveA!: (v: boolean) => void;
    const { store, onResult } = setup(
      { userId: 'A', isLoading: false },
      (uid) => (uid === 'A' ? new Promise((r) => (resolveA = r)) : new Promise(() => {}))
    );
    store.set({ userId: 'B', isLoading: true });
    resolveA(false);
    await flush();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('drops a result that arrives after dispose', async () => {
    let resolve!: (v: boolean) => void;
    const { onResult, dispose } = setup(
      { userId: 'A', isLoading: false },
      () => new Promise((r) => (resolve = r))
    );
    dispose();
    resolve(false);
    await flush();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('treats a rejecting read as done, with no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { onResult } = setup({ userId: 'A', isLoading: false }, async () => {
        throw new TypeError('fetch failed');
      });
      await flush();
      await flush();
      expect(onResult).toHaveBeenCalledWith('A', false);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('fires immediately when the load had already settled at subscribe time', async () => {
    const { check, onResult } = setup({ userId: 'A', isLoading: false }, async () => false);
    expect(check).toHaveBeenCalledWith('A');
    await flush();
    expect(onResult).toHaveBeenCalledWith('A', true);
  });

  it('re-reads for the SAME account after a sign-out and sign-in in one mount', async () => {
    const { store, check, onResult } = setup({ userId: 'A', isLoading: false }, async () => false);
    await flush();
    store.set({ userId: null, isLoading: false });
    store.set({ userId: 'A', isLoading: true });
    store.set({ isLoading: false });
    await flush();
    expect(check.mock.calls.map((c) => c[0])).toEqual(['A', 'A']);
    expect(onResult.mock.calls).toEqual([
      ['A', true],
      ['A', true],
    ]);
  });
});

/**
 * AppShell's onResult routes the chat half through ui-store's
 * applyChatOnboardingAnswer. AppShell remounts on / → /settings → /, and a
 * fresh watcher reads "done" for an account whose tour already wrote
 * completion while Beacon's Q&A is still unanswered.
 */
describe('Beacon first-run flag across an AppShell remount', () => {
  const mountShell = (store: ReturnType<typeof fakeStore>, done: Record<string, boolean>) =>
    watchOnboardingAfterLoad({
      getState: store.getState,
      subscribe: store.subscribe,
      isComplete: async (uid) => done[uid],
      onResult: (uid, needed) => useUIStore.getState().applyChatOnboardingAnswer(uid, needed),
    });

  it('keeps the same account’s unanswered Q&A up when a remount reads "done"', async () => {
    useUIStore.getState().setChatOnboardingActive(false);
    const done: Record<string, boolean> = { A: false };
    const store = fakeStore({ userId: 'A', isLoading: false });
    const first = mountShell(store, done);
    await flush();
    expect(useUIStore.getState().chatOnboardingActive).toBe(true);

    // The tour finishes (onboarding_completed = true), the Q&A is not answered,
    // and the user navigates away and back.
    done.A = true;
    first();
    const second = mountShell(store, done);
    await flush();
    expect(useUIStore.getState().chatOnboardingActive).toBe(true);
    second();
  });

  it('still clears a flag another account left up', async () => {
    useUIStore.getState().setChatOnboardingActive(true, 'A');
    const store = fakeStore({ userId: 'B', isLoading: false });
    const dispose = mountShell(store, { B: true });
    await flush();
    expect(useUIStore.getState().chatOnboardingActive).toBe(false);
    dispose();
  });
});
