import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What a drop means per layout (design 2.3, lib/atlas-drop.ts), against the
 * REAL planner store with its history subscriber (the history-batch harness):
 * a Momentum drop pins and Unpin clears; By goal links with non-subtask ids,
 * unlinks without touching milestones (never setItemsGoal(..., false)), a
 * card feeding two goals unlinks from both, and a move is one undo; Timeline
 * writes a goal's target and springs a project back.
 */

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    fetchRoutines: vi.fn(async () => []),
    fetchSeasons: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
    createItem: vi.fn(async () => {}),
    updateItem: vi.fn(async () => {}),
    updateGoal: vi.fn(async () => {}),
    recordCheckin: vi.fn(),
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/completion-confetti', () => ({ celebrateCompletion: vi.fn() }));

import { getActionLog, usePlannerStore } from '@/lib/planner-store';
import { useAtlasStore } from '@/lib/atlas-store';
import * as db from '@/lib/db';
import { dropCard } from '@/lib/atlas-drop';
import { filterCards, layoutPositions, type AtlasFilters, type AtlasLayoutResult } from '@/lib/atlas-layouts';
import { momentumBand } from '@/lib/atlas-momentum';
import { laneFor } from '@/lib/atlas-by-goal';
import { TIMELINE_DAY_PX, xForDate } from '@/lib/atlas-timeline';
import { ATLAS_CARD_W } from '@/lib/atlas-seed';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import type { AtlasCard } from '@/lib/atlas-model';
import type { AtlasLayout } from '@/lib/view-store';
import type { Goal, Item, Project } from '@/lib/planner-types';
import { TODAY, build, goal, task } from './helpers/atlas-fixtures';

const USER = 'user-1';
const store = () => usePlannerStore.getState();

async function load(items: Item[], projects: Project[], goals: Goal[] = []) {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(items);
  vi.mocked(db.fetchProjects).mockResolvedValue(projects);
  vi.mocked(db.fetchGoals).mockResolvedValue(goals);
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
  useAtlasStore.getState().reset();
}

/** The cards as Atlas builds them from what the store holds now. */
const cardsNow = () =>
  build({ items: store().items as Item[], projects: store().projects, goals: store().goals });

const NO_FILTERS: AtlasFilters = { hideFinished: false, hideResting: false };
const bandsOf = (cards: AtlasCard[]) =>
  new Map(cards.map((c) => [c.key, momentumBand(c, undefined, TODAY, useAtlasStore.getState().places[c.key]?.band ?? null)]));

/** As AtlasView lays out: filter first, then lay out the visible cards. */
function lay(layout: AtlasLayout, cards: AtlasCard[], filters: AtlasFilters = NO_FILTERS): AtlasLayoutResult {
  const goals = store().goals;
  const bands = bandsOf(cards);
  return layoutPositions(layout, filterCards(cards, filters, bands), {
    places: {},
    bands,
    lanes: new Map(cards.map((c) => [c.key, laneFor(c, goals)])),
    goalCards: cards.filter((c) => c.kind === 'goal'),
    todayStr: TODAY,
  });
}

/** As AtlasView's onMove: the lane and the start point are the ones DRAWN. */
function drop(layout: AtlasLayout, key: string, to: { x: number; y: number }, filters: AtlasFilters = NO_FILTERS) {
  const cards = cardsNow();
  const card = cards.find((c) => c.key === key)!;
  const result = lay(layout, cards, filters);
  const goals = store().goals;
  const drawn = result.cardLane.get(key);
  return dropCard({
    layout,
    card,
    to,
    from: result.positions.get(key),
    result,
    band: momentumBand(card, undefined, TODAY, useAtlasStore.getState().places[key]?.band ?? null),
    lane: drawn && drawn !== 'none' ? drawn : null,
    goals,
    goalsShown: true,
  });
}

const laneRect = (layout: AtlasLayout, id: string) => lay(layout, cardsNow()).lanes.find((l) => l.id === id)!.rect;
const nudge = (layout: AtlasLayout, key: string, filters: AtlasFilters = NO_FILTERS, dx = 10) => {
  const p = lay(layout, cardsNow(), filters).positions.get(key)!;
  return { x: p.x + dx, y: p.y };
};
const inColumn = (id: string) => ({ x: laneRect('momentum', id).x + 20, y: 100 });
const inLane = (id: string) => ({ x: 40, y: laneRect('goal', id).y + 10 });

const WORK: Project = { id: 'p1', name: 'Work', emoji: '' } as Project;

describe('Momentum', () => {
  beforeEach(() => load([task({ id: 'a', project: 'Work' })], [WORK]));

  it('a drop into another column pins it there, and Unpin hands it back', () => {
    // Undated, unknown: the app says Soon.
    const out = drop('momentum', 'project:p1', inColumn('now'));
    expect(out).toEqual({ wrote: true, message: ATLAS_COPY.pinned('Work', 'Now') });
    expect(useAtlasStore.getState().places['project:p1']?.band).toBe('now');

    useAtlasStore.getState().pin('project', 'p1', null);
    expect(useAtlasStore.getState().places['project:p1']?.band ?? null).toBeNull();
  });

  it("a drop into the app's own column unpins", () => {
    useAtlasStore.getState().pin('project', 'p1', 'resting', { x: 0, y: 0 });
    const out = drop('momentum', 'project:p1', inColumn('soon'));
    expect(out.message).toBe(ATLAS_COPY.unpinned('Work'));
    expect(useAtlasStore.getState().places['project:p1']?.band).toBeNull();
  });

  it('a pin on a card with no stored place keeps the place it is drawn at', () => {
    const cards = cardsNow();
    const card = cards[0];
    dropCard({
      layout: 'momentum',
      card,
      to: inColumn('resting'),
      result: lay('momentum', cards),
      band: momentumBand(card, undefined, TODAY),
      mapAt: { x: 120, y: 80 },
      goals: [],
      goalsShown: false,
    });
    expect(useAtlasStore.getState().places['project:p1']).toMatchObject({ x: 120, y: 80, band: 'resting' });
  });

  it('a drop in its own column says the app orders it; a nudge is silent', () => {
    const at = lay('momentum', cardsNow()).positions.get('project:p1')!;
    expect(drop('momentum', 'project:p1', { x: at.x + 5, y: at.y + 6 })).toEqual({ wrote: false });
    expect(drop('momentum', 'project:p1', { x: at.x, y: at.y + 200 })).toEqual({
      wrote: false,
      message: ATLAS_COPY.orderIsTheApps,
    });
    expect(useAtlasStore.getState().places['project:p1']).toBeUndefined();
  });

  it('springs back outside every column, with a reason', () => {
    expect(drop('momentum', 'project:p1', { x: -2000, y: 0 })).toEqual({ wrote: false, message: ATLAS_COPY.dropInColumn });
    expect(useAtlasStore.getState().places['project:p1']).toBeUndefined();
  });
});

describe('By goal', () => {
  const items = [
    task({ id: 'a', project: 'Work' }),
    task({ id: 'b', project: 'Work' }),
    task({ id: 'sub', project: 'Work', parentItemId: 'a' } as never),
  ];

  it('a link calls setItemsGoal with the non-subtask ids, one undo, with the caveat said once', async () => {
    await load(items, [WORK], [goal('g1', { name: 'Launch the channel' })]);
    const spy = vi.spyOn(store(), 'setItemsGoal');
    const before = getActionLog().length;
    drop('goal', 'project:p1', inLane('g1'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].slice().sort()).toEqual(['a', 'b']);
    expect(spy.mock.calls[0][2]).toBe(true);
    expect(getActionLog()).toHaveLength(before + 1);
    expect(getActionLog()[0].label).toBe(ATLAS_COPY.linked(2, 'Launch the channel'));
    expect(store().goals[0].memberIds.slice().sort()).toEqual(['a', 'b']);
    store().undo();
    expect(store().goals[0].memberIds).toEqual([]);
  });

  it('an unlink keeps milestones: updateGoal on feeders, never setItemsGoal(..., false)', async () => {
    await load(items, [WORK], [goal('g1', { memberIds: ['a'], milestoneIds: ['b'] })]);
    const setItemsGoal = vi.spyOn(store(), 'setItemsGoal');
    const updateGoal = vi.spyOn(store(), 'updateGoal');
    drop('goal', 'project:p1', inLane('none'));
    expect(setItemsGoal).not.toHaveBeenCalled();
    expect(updateGoal).toHaveBeenCalledWith('g1', { memberIds: [] });
    expect(store().goals[0]).toMatchObject({ memberIds: [], milestoneIds: ['b'] });
  });

  it('a card feeding two goals unlinks from both and lands in Not feeding a goal', async () => {
    await load(items, [WORK], [goal('g1', { memberIds: ['a'] }), goal('g2', { memberIds: ['b'] })]);
    const before = getActionLog().length;
    drop('goal', 'project:p1', inLane('none'));
    expect(store().goals.map((g) => g.memberIds)).toEqual([[], []]);
    expect(getActionLog()).toHaveLength(before + 1);
    const card = cardsNow().find((c) => c.key === 'project:p1')!;
    expect(laneFor(card, store().goals)).toBeNull();
  });

  it('lane to lane is one undo entry that moves the feeders', async () => {
    await load(items, [WORK], [goal('g1', { name: 'One', memberIds: ['a', 'b'] }), goal('g2', { name: 'Two' })]);
    const before = getActionLog().length;
    drop('goal', 'project:p1', inLane('g2'));
    expect(getActionLog()).toHaveLength(before + 1);
    expect(getActionLog()[0].label).toBe(ATLAS_COPY.moved('Work', 'Two'));
    expect(store().goals.find((g) => g.id === 'g1')!.memberIds).toEqual([]);
    expect(store().goals.find((g) => g.id === 'g2')!.memberIds.slice().sort()).toEqual(['a', 'b']);
    store().undo();
    expect(store().goals.find((g) => g.id === 'g1')!.memberIds).toEqual(['a', 'b']);
    expect(store().goals.find((g) => g.id === 'g2')!.memberIds).toEqual([]);
  });

  it('with Hide finished on, a card feeding an achieved goal keeps that lane, and a nudge writes nothing', async () => {
    await load(items, [WORK], [goal('g1', { name: 'Old', state: 'achieved', memberIds: ['a', 'b'] }), goal('g2', { name: 'New' })]);
    const filters = { hideFinished: true, hideResting: false };
    const r = lay('goal', cardsNow(), filters);
    // The goal's own card is hidden, but its lane stays, headed by its name.
    expect(r.positions.has('goal:g1')).toBe(false);
    expect(r.lanes.find((l) => l.id === 'g1')).toMatchObject({ label: 'Old', count: 1 });
    expect(r.cardLane.get('project:p1')).toBe('g1');
    const updateGoal = vi.spyOn(store(), 'updateGoal');
    const before = getActionLog().length;
    expect(drop('goal', 'project:p1', nudge('goal', 'project:p1', filters), filters)).toEqual({ wrote: false });
    expect(updateGoal).not.toHaveBeenCalled();
    expect(getActionLog()).toHaveLength(before);
    expect(store().goals.find((g) => g.id === 'g1')!.memberIds).toEqual(['a', 'b']);
  });

  it('a drop in its own lane says so after a real move', async () => {
    await load(items, [WORK], [goal('g1', { memberIds: ['a'] })]);
    expect(drop('goal', 'project:p1', nudge('goal', 'project:p1', NO_FILTERS, 260))).toEqual({
      wrote: false,
      message: ATLAS_COPY.alreadyInLane,
    });
  });

  it('a link that adds nothing springs back with a reason; a partial link counts only what it adds', async () => {
    // Both items are already the goal's milestones: nothing to add.
    await load(items, [WORK], [goal('g1', { name: 'Ship', milestoneIds: ['a', 'b'] })]);
    const before = getActionLog().length;
    expect(drop('goal', 'project:p1', inLane('g1'))).toEqual({ wrote: false, message: ATLAS_COPY.alreadyPartOf('Ship') });
    expect(getActionLog()).toHaveLength(before);

    await load(items, [WORK], [goal('g1', { name: 'Ship', milestoneIds: ['a'] })]);
    drop('goal', 'project:p1', inLane('g1'));
    expect(getActionLog()[0].label).toBe(ATLAS_COPY.linked(1, 'Ship'));
    expect(store().goals[0].memberIds).toEqual(['b']);
  });

  it('a goal card springs back; so does a card with nothing to link', async () => {
    await load([], [WORK], [goal('g1'), goal('g2')]);
    expect(drop('goal', 'goal:g1', inLane('g2')).message).toBe(ATLAS_COPY.goalsStay);
    expect(drop('goal', 'project:p1', inLane('g2')).message).toBe(ATLAS_COPY.nothingToLink);
  });
});

describe('Timeline', () => {
  it("writes a goal's target, snapped to a day, as one undo", async () => {
    await load([], [WORK], [goal('g1', { name: 'Run', targetOn: '2026-05-01' })]);
    const r = lay('timeline', cardsNow());
    const at = r.positions.get('goal:g1')!;
    const x = xForDate(r.timeline!.window, '2026-05-20') + TIMELINE_DAY_PX / 2 - ATLAS_CARD_W / 2 + 2;
    const before = getActionLog().length;
    drop('timeline', 'goal:g1', { x, y: at.y });
    expect(store().goals[0].targetOn).toBe('2026-05-20');
    expect(getActionLog()).toHaveLength(before + 1);
    expect(getActionLog()[0].label).toBe(ATLAS_COPY.targetMoved('Run', 'May 20'));
    store().undo();
    expect(store().goals[0].targetOn).toBe('2026-05-01');
  });

  it('refuses a target before the goal starts', async () => {
    await load([], [WORK], [goal('g1', { startsOn: '2026-04-10', targetOn: '2026-05-01' })]);
    const r = lay('timeline', cardsNow());
    const at = r.positions.get('goal:g1')!;
    const x = xForDate(r.timeline!.window, '2026-04-02') + TIMELINE_DAY_PX / 2 - ATLAS_CARD_W / 2;
    expect(drop('timeline', 'goal:g1', { x, y: at.y })).toEqual({
      wrote: false,
      message: ATLAS_COPY.cantEndBeforeStart('Apr 10'),
    });
    expect(store().goals[0].targetOn).toBe('2026-05-01');
  });

  it('a goal whose target is outside the default window is drawn inside it, and a nudge keeps its day', async () => {
    await load([], [WORK], [goal('far', { targetOn: '2028-06-01' }), goal('past', { targetOn: '2025-11-01' })]);
    const r = lay('timeline', cardsNow());
    expect(r.timeline!.window.start <= '2025-11-01').toBe(true);
    expect(r.timeline!.window.end >= '2028-06-01').toBe(true);
    for (const key of ['goal:far', 'goal:past']) {
      const at = r.positions.get(key)!;
      expect(at.x).toBeGreaterThan(-ATLAS_CARD_W);
      expect(at.x).toBeLessThan(r.timeline!.width);
      // A one-pixel jitter is under half a day: nothing is written.
      expect(drop('timeline', key, { x: at.x + 1, y: at.y })).toEqual({ wrote: false });
    }
    // A one-day move writes exactly one day later, never a window edge.
    const at = r.positions.get('goal:far')!;
    drop('timeline', 'goal:far', { x: at.x + TIMELINE_DAY_PX, y: at.y });
    expect(store().goals.find((g) => g.id === 'far')!.targetOn).toBe('2028-06-02');
  });

  it('a drop past the drawn months springs back with a reason', async () => {
    await load([], [WORK], [goal('g1', { targetOn: '2026-05-01' })]);
    const r = lay('timeline', cardsNow());
    const at = r.positions.get('goal:g1')!;
    expect(drop('timeline', 'goal:g1', { x: r.timeline!.width + 400, y: at.y })).toEqual({
      wrote: false,
      message: ATLAS_COPY.dropInsideTimeline,
    });
    expect(store().goals[0].targetOn).toBe('2026-05-01');
  });

  it("a finished goal's target never moves", async () => {
    await load([], [WORK], [goal('g1', { state: 'achieved', targetOn: '2026-05-01' })]);
    const r = lay('timeline', cardsNow());
    const at = r.positions.get('goal:g1')!;
    expect(drop('timeline', 'goal:g1', { x: at.x + 60, y: at.y })).toEqual({
      wrote: false,
      message: ATLAS_COPY.finishedGoalKeepsDate,
    });
    expect(store().goals[0].targetOn).toBe('2026-05-01');
  });

  it('a project springs back with a reason and writes nothing', async () => {
    await load([task({ id: 'a', project: 'Work', startDate: '2026-04-01' })], [WORK]);
    const updateGoal = vi.spyOn(store(), 'updateGoal');
    expect(drop('timeline', 'project:p1', { x: 900, y: 300 })).toEqual({
      wrote: false,
      message: ATLAS_COPY.projectsFollowDates,
    });
    expect(updateGoal).not.toHaveBeenCalled();
  });
});
