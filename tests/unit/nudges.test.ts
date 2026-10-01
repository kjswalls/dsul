import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store's persistence layer is fully mocked (the extensions-store.test.ts
// pattern): drive the real zustand store and assert both the state transitions
// and the writes it emits.
vi.mock('@/lib/nudges/service', () => ({
  loadDismissedNudges: vi.fn(async () => []),
  saveDismissedNudges: vi.fn(async () => {}),
  resetDismissedNudges: vi.fn(async () => {}),
}));

import { loadDismissedNudges, saveDismissedNudges } from '@/lib/nudges/service';
import { useNudgeStore } from '@/lib/nudge-store';
import { NUDGES, NUDGE_STREAKS_ON, nudgeDef } from '@/lib/nudges/registry';

const mockLoad = vi.mocked(loadDismissedNudges);
const mockSave = vi.mocked(saveDismissedNudges);

beforeEach(() => {
  vi.clearAllMocks();
  useNudgeStore.getState().reset();
});

describe('nudge registry', () => {
  it('ids are unique and slug-shaped', () => {
    const ids = NUDGES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  });

  it('nudgeDef finds a def and returns undefined for unknown ids', () => {
    expect(nudgeDef(NUDGE_STREAKS_ON)?.id).toBe(NUDGE_STREAKS_ON);
    expect(nudgeDef('not-a-real-nudge')).toBeUndefined();
  });

  it('the streak nudge deep-links to its own settings row', () => {
    expect(nudgeDef(NUDGE_STREAKS_ON)?.settingsFocusId).toBe('extensions.streaks');
  });
});

describe('nudge store', () => {
  it('hydrates the dismissed set and stamps the owner in one move', async () => {
    mockLoad.mockResolvedValueOnce(['streaks-on']);
    await useNudgeStore.getState().hydrate('user-1');
    expect(useNudgeStore.getState().dismissed).toEqual(['streaks-on']);
    expect(useNudgeStore.getState().hydratedUserId).toBe('user-1');
  });

  it('stays unhydrated when the set cannot be read (null), so nudges stay inert', async () => {
    mockLoad.mockResolvedValueOnce(null);
    await useNudgeStore.getState().hydrate('user-1');
    expect(useNudgeStore.getState().hydratedUserId).toBeNull();
    expect(useNudgeStore.getState().dismissed).toEqual([]);
  });

  it('does not refetch for an already-hydrated user', async () => {
    mockLoad.mockResolvedValueOnce([]);
    await useNudgeStore.getState().hydrate('user-1');
    await useNudgeStore.getState().hydrate('user-1');
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('dismiss appends, persists the whole set, and never duplicates', async () => {
    mockLoad.mockResolvedValueOnce([]);
    await useNudgeStore.getState().hydrate('user-1');

    useNudgeStore.getState().dismiss('user-1', 'streaks-on');
    expect(useNudgeStore.getState().dismissed).toEqual(['streaks-on']);
    expect(mockSave).toHaveBeenCalledWith('user-1', ['streaks-on']);

    useNudgeStore.getState().dismiss('user-1', 'streaks-on');
    expect(useNudgeStore.getState().dismissed).toEqual(['streaks-on']);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('reset clears the set and the owner stamp', async () => {
    mockLoad.mockResolvedValueOnce(['streaks-on']);
    await useNudgeStore.getState().hydrate('user-1');
    useNudgeStore.getState().reset();
    expect(useNudgeStore.getState().dismissed).toEqual([]);
    expect(useNudgeStore.getState().hydratedUserId).toBeNull();
  });
});

describe('nudge store in-flight claim', () => {
  /** A load the test resolves by hand. */
  const deferred = () => {
    let resolve!: (v: string[] | null) => void;
    const promise = new Promise<string[] | null>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('two concurrent hydrates for one account read once', async () => {
    const d = deferred();
    mockLoad.mockReturnValueOnce(d.promise);
    const a = useNudgeStore.getState().hydrate('user-1');
    const b = useNudgeStore.getState().hydrate('user-1');
    d.resolve(['streaks-on']);
    await Promise.all([a, b]);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(useNudgeStore.getState().hydratedUserId).toBe('user-1');
  });

  it('a null read releases the claim, so the next hydrate re-reads', async () => {
    mockLoad.mockResolvedValueOnce(null);
    await useNudgeStore.getState().hydrate('user-1');
    mockLoad.mockResolvedValueOnce(['streaks-on']);
    await useNudgeStore.getState().hydrate('user-1');
    expect(mockLoad).toHaveBeenCalledTimes(2);
    expect(useNudgeStore.getState().dismissed).toEqual(['streaks-on']);
  });

  it("drops a switched-away account's late answer", async () => {
    const dA = deferred();
    const dB = deferred();
    mockLoad.mockReturnValueOnce(dA.promise).mockReturnValueOnce(dB.promise);
    const a = useNudgeStore.getState().hydrate('user-a');
    const b = useNudgeStore.getState().hydrate('user-b');
    dB.resolve([]);
    await b;
    dA.resolve(['streaks-on']);
    await a;
    expect(useNudgeStore.getState().hydratedUserId).toBe('user-b');
    expect(useNudgeStore.getState().dismissed).toEqual([]);
  });

  it('a superseded null cannot release the newer account\'s claim', async () => {
    const dA = deferred();
    const dB = deferred();
    mockLoad.mockReturnValueOnce(dA.promise).mockReturnValueOnce(dB.promise);
    const a = useNudgeStore.getState().hydrate('user-a');
    const b = useNudgeStore.getState().hydrate('user-b');
    dA.resolve(null);
    await a;
    // B is still in flight: a second ask for it must not read again.
    void useNudgeStore.getState().hydrate('user-b');
    expect(mockLoad).toHaveBeenCalledTimes(2);
    dB.resolve([]);
    await b;
    expect(useNudgeStore.getState().hydratedUserId).toBe('user-b');
  });
});
