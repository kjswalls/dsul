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
import { NUDGES, NUDGE_RITUALS_INTRO, NUDGE_STREAKS_ON, nudgeDef, ritualsNudgeReady } from '@/lib/nudges/registry';
import { streakNudgeEnabled } from '@/lib/nudges/streak-gate';

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

describe('the rituals nudge (#86)', () => {
  const READY = {
    settingsHydrated: true,
    tourAnswered: true,
    tourShowing: false,
    hasTasks: true,
    morningCheckEnabled: false,
    eodReviewEnabled: false,
  };

  it('deep-links to the Rituals pane, which turns nothing on by itself', () => {
    expect(nudgeDef(NUDGE_RITUALS_INTRO)?.settingsFocusId).toBe('rituals.morningCheck');
  });

  it('fires once there is something planned and both rituals are still off', () => {
    expect(ritualsNudgeReady(READY)).toBe(true);
  });

  it.each([
    ['settings are not this account’s yet', { settingsHydrated: false }],
    ['the onboarding answer has not come back', { tourAnswered: false }],
    ['the tour is up', { tourShowing: true }],
    ['nothing is planned yet', { hasTasks: false }],
    ['the morning check is already on', { morningCheckEnabled: true }],
    ['the review is already on', { eodReviewEnabled: true }],
  ])('waits while %s', (_why, patch) => {
    expect(ritualsNudgeReady({ ...READY, ...patch })).toBe(false);
  });
});

describe('when the streak nudge may show', () => {
  // A returning account with a habit, the tour answered and not showing.
  const READY = {
    extReady: true,
    streaksOn: true,
    userId: 'user-1',
    tourAnsweredFor: 'user-1',
    tourShowing: false,
    hasHabit: true,
  };

  it('shows once everything has answered and there is a habit', () => {
    expect(streakNudgeEnabled(READY)).toBe(true);
  });

  it('waits for streaks to be provably on', () => {
    expect(streakNudgeEnabled({ ...READY, extReady: false })).toBe(false);
    expect(streakNudgeEnabled({ ...READY, streaksOn: false })).toBe(false);
  });

  it('never covers the first-run tour', () => {
    expect(streakNudgeEnabled({ ...READY, tourShowing: true })).toBe(false);
  });

  it("waits for the tour's answer, for this account", () => {
    // The onboarding read lands after the planner load: no tour showing yet
    // is not an answer, and nor is the last account's.
    expect(streakNudgeEnabled({ ...READY, tourAnsweredFor: null })).toBe(false);
    expect(streakNudgeEnabled({ ...READY, tourAnsweredFor: 'user-0' })).toBe(false);
    expect(streakNudgeEnabled({ ...READY, userId: null, tourAnsweredFor: null })).toBe(false);
  });

  it('says nothing about flames to an account with no habit', () => {
    expect(streakNudgeEnabled({ ...READY, hasHabit: false })).toBe(false);
  });
});
