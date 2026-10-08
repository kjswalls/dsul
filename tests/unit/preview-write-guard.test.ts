import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The look-only preview's write barrier (lib/preview-write-guard.ts), around
 * the REAL planner store.
 *
 * Deny by default is the whole point: an action added to the store tomorrow is
 * refused during a preview without anyone remembering the allowlist. So the
 * refused set is never written down here — it is every function member of the
 * live store minus the allowlist, enumerated at runtime — and the allowlist IS
 * written down, as a literal, so widening it is a visible decision in review.
 */

// Every db function is a spy that does nothing. Writers are never meant to be
// reached while previewing, and `vi.mocked` lets the refusal loop assert that
// NONE of them was, rather than a hand-picked few.
vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/db');
  const mocked: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    // itemDbType is the one pure helper the store calls for an answer.
    if (typeof value !== 'function' || name === 'itemDbType') continue;
    mocked[name] = vi.fn(async () => (name.startsWith('fetch') ? [] : undefined));
  }
  mocked.loadPlannerData = vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable());
  return mocked;
});
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import * as db from '@/lib/db';
import { saveSettings } from '@/lib/settings-service';
import { usePlannerStore } from '@/lib/planner-store';
import {
  guardPreviewWrites,
  PREVIEW_ALLOWED_ACTIONS,
  PREVIEW_REFUSALS,
} from '@/lib/preview-write-guard';
import type { Item } from '@/lib/planner-types';

const USER = 'user-1';

const store = () => usePlannerStore.getState();

const functionMembers = () =>
  Object.entries(store())
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
    .sort();

const dbSpies = () =>
  Object.entries(db)
    .filter(([name, value]) => typeof value === 'function' && vi.isMockFunction(value) && name !== 'loadPlannerData')
    .map(([name, value]) => [name, value as ReturnType<typeof vi.fn>] as const);

const fixtures = (): Item[] => [
  {
    type: 'task',
    id: 'task-1',
    title: 'Write tests',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
  },
];

describe('PREVIEW_ALLOWED_ACTIONS', () => {
  it('is exactly the 27 lifecycle, reader, view and preference names', () => {
    // A literal on purpose: adding a name here is a decision that a cached
    // planner may drive that action, and review should see it as one.
    expect([...PREVIEW_ALLOWED_ACTIONS].sort()).toEqual(
      [
        // lifecycle
        'identifyUser', 'initializeStore', 'clearStore', 'clearUserScopedState', 'refreshActionLog', 'dropPreview',
        // readers
        'getProject', 'getProjectColor', 'getProjectEmoji',
        // view state
        'setSelectedDate', 'setViewMode', 'setGroupBy', 'setFilters', 'clearFilters',
        'setTimelineItemFilter', 'setNavDirection', 'setHoveredItem',
        // preferences
        'setCompactMode', 'setChillMode', 'setShowCurrentTimeIndicator', 'setShowCompletedTasks',
        'setShowPausedOnGrid', 'setDefaultView', 'setDefaultTimeBucket', 'setAnimationsEnabled',
        'setWeekStartDay', 'setTimeFormat',
      ].sort()
    );
    expect(PREVIEW_ALLOWED_ACTIONS.size).toBe(27);
  });

  it('names only actions the real store has', () => {
    const members = new Set(functionMembers());
    for (const name of PREVIEW_ALLOWED_ACTIONS) expect(members, name).toContain(name);
  });

  it('gives every non-void refusal a value its callers read as "nothing was made"', () => {
    // The creates' callers test the id for truthiness (container-dialog,
    // container-create-form, the item dialog's inline creates); the seed's and
    // the proposal's callers read their own refusal vocabulary.
    expect(PREVIEW_REFUSALS).toEqual({
      addTask: '', addHabit: '', addRoutine: '', addSeason: '', addGoal: '',
      addProject: null, seedStarterContainers: 'refused', applyProposal: 0,
    });
    // addItem returns the new id since #432 (the canvas add opens what it made),
    // and undefined for "nothing made" (an unknown slug): the barrier's default
    // refusal is that same undefined, so it needs no entry.
    expect('addItem' in PREVIEW_REFUSALS).toBe(false);
    const members = new Set(functionMembers());
    for (const name of Object.keys(PREVIEW_REFUSALS)) {
      expect(members, name).toContain(name);
      expect(PREVIEW_ALLOWED_ACTIONS.has(name), name).toBe(false);
    }
  });
});

describe('guardPreviewWrites', () => {
  it('asks isPreview at CALL time and passes everything else through untouched', () => {
    let previewing = false;
    const write = vi.fn(() => 'made');
    const guarded = guardPreviewWrites(
      { count: 3, addTask: write, getProject: vi.fn(() => 'read') },
      () => previewing
    );
    expect(guarded.count).toBe(3);
    expect(guarded.addTask()).toBe('made');

    previewing = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(guarded.addTask()).toBe('');
    expect(guarded.getProject()).toBe('read');
    warn.mockRestore();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('the real store while previewing', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    store().clearStore();
    vi.mocked(db.fetchItems).mockResolvedValueOnce(fixtures());
    store().identifyUser(USER);
    await store().initializeStore(USER);
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    usePlannerStore.setState({ isPreview: false });
  });

  it('refuses every other function member: the refusal value, no db call, no state change', () => {
    const refused = functionMembers().filter((name) => !PREVIEW_ALLOWED_ACTIONS.has(name));
    // 88 members today plus dropPreview, 27 of them allowed.
    expect(refused.length).toBeGreaterThanOrEqual(62);

    usePlannerStore.setState({ isPreview: true });
    const before = store();
    for (const name of refused) {
      const action = (store() as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
      // No arguments: a call that reached the real action would throw or write,
      // and either one fails below.
      expect(action(), name).toBe(PREVIEW_REFUSALS[name]);
      expect(warn, name).toHaveBeenLastCalledWith(`[preview] ${name} refused while previewing`);
    }
    // Not one set(): the state object is the very same reference.
    expect(store()).toBe(before);
    for (const [name, spy] of dbSpies()) expect(spy, name).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('refuses undo and redo, which would replay history against cached rows', () => {
    usePlannerStore.setState({ isPreview: false });
    store().updateTask('task-1', { title: 'Edited' });
    store().undo();
    expect(store().items[0].title).toBe('Write tests');
    vi.clearAllMocks();

    usePlannerStore.setState({ isPreview: true });
    store().redo();
    expect(store().items[0].title).toBe('Write tests');
    usePlannerStore.setState({ isPreview: false });
    store().redo();
    expect(store().items[0].title).toBe('Edited');

    usePlannerStore.setState({ isPreview: true });
    vi.clearAllMocks();
    store().undo();
    expect(store().items[0].title).toBe('Edited');
    for (const [name, spy] of dbSpies()) expect(spy, name).not.toHaveBeenCalled();
  });

  it('still runs the allowed members', () => {
    usePlannerStore.setState({
      isPreview: true,
      projects: [{ id: 'p1', name: 'Work', emoji: '💼' }],
    });
    const day = new Date(2026, 9, 3);
    store().setSelectedDate(day);
    store().setViewMode('week');
    store().setHoveredItem('task-1', 'task');
    store().setNavDirection('left');
    store().setCompactMode(true);
    expect(store().selectedDate).toBe(day);
    expect(store().viewMode).toBe('week');
    expect(store().hoveredItemId).toBe('task-1');
    expect(store().navDirection).toBe('left');
    expect(store().compactMode).toBe(true);
    // A preference is the user's, not the cache's: it still saves.
    expect(saveSettings).toHaveBeenCalledWith(USER, { compact_mode: true });
    expect(store().getProject('Work')?.id).toBe('p1');
    expect(warn).not.toHaveBeenCalled();
    store().setCompactMode(false);
  });

  it('refuses nothing when not previewing', () => {
    usePlannerStore.setState({ isPreview: false });
    const id = store().addTask({ title: 'Fresh', timeBucket: 'anytime' });
    expect(id).toBeTruthy();
    expect(store().items.map((i) => i.id)).toContain(id);
    expect(db.createItem).toHaveBeenCalledTimes(1);
    expect(store().addProject('Home', '🏠')).toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
  });
});
