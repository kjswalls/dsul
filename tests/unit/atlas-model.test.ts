import { describe, expect, it } from 'vitest';
import {
  ATLAS_TILE_CAP,
  buildAtlasCards,
  memberStateOn,
  type AtlasModelInput,
} from '@/lib/atlas-model';
import { projectColorToken } from '@/lib/accent-colors';
import { milestoneItemIds } from '@/lib/goals';
import type { Goal, HabitItem, Item, Project, Routine, Season, Task } from '@/lib/planner-types';

/** A Tuesday. */
const TODAY = '2026-03-10';
const TZ = 'UTC';

const task = (over: Partial<Item> & { id: string; title?: string }) =>
  ({
    type: 'task',
    title: over.id,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    ...over,
  }) as Item;

const habit = (over: Partial<Item> & { id: string; title?: string }) =>
  ({
    type: 'habit',
    title: over.id,
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    timeBucket: 'anytime',
    ...over,
  }) as Item;

const project = (name: string, over: Partial<Project> = {}) =>
  ({ id: `p-${name}`, name, emoji: '', ...over }) as Project;

const routine = (id: string, itemIds: string[], over: Partial<Routine> = {}) =>
  ({ id, name: id, itemIds, ...over }) as Routine;

const season = (id: string, over: Partial<Season> = {}) =>
  ({ id, name: id, state: 'active', itemIds: [], routineIds: [], ...over }) as Season;

const goal = (id: string, over: Partial<Goal> = {}) =>
  ({ id, name: id, state: 'active', memberIds: [], milestoneIds: [], checkinIds: [], ...over }) as Goal;

function input(over: Partial<AtlasModelInput> & { items: Item[] }): AtlasModelInput {
  const items = over.items;
  const goals = over.goals ?? [];
  return {
    tasks: items.filter((i) => i.type !== 'habit') as unknown as Task[],
    habits: items.filter((i) => i.type === 'habit') as unknown as HabitItem[],
    projects: [],
    routines: [],
    seasons: [],
    goals,
    away: [],
    tz: TZ,
    todayStr: TODAY,
    collectionsAvailable: true,
    goalsAvailable: true,
    milestoneIds: milestoneItemIds(goals),
    ...over,
  };
}

const cardOf = (cards: ReturnType<typeof buildAtlasCards>, key: string) => {
  const c = cards.find((x) => x.key === key);
  if (!c) throw new Error(`no card ${key}`);
  return c;
};

describe('memberStateOn (rule 17)', () => {
  const none = new Set<string>();

  it('lights a done one-off and a recurring item done today', () => {
    expect(memberStateOn(task({ id: 'a', status: 'completed' }), TODAY, none, TZ)).toBe('lit');
    expect(memberStateOn(habit({ id: 'h', completedDates: [TODAY] }), TODAY, none, TZ)).toBe('lit');
  });

  it('reads an open one-off and a due habit as open', () => {
    expect(memberStateOn(task({ id: 'a' }), TODAY, none, TZ)).toBe('open');
    expect(memberStateOn(habit({ id: 'h' }), TODAY, none, TZ)).toBe('open');
  });

  it('gives a cancelled one-off no tile at all', () => {
    expect(memberStateOn(task({ id: 'a', status: 'cancelled' }), TODAY, none, TZ)).toBeNull();
  });

  it('reads an off-day weekly habit as quiet', () => {
    // Mondays only; today is a Tuesday.
    const h = habit({ id: 'h', repeatFrequency: 'custom', repeatDays: [1] } as Partial<Item> & { id: string });
    expect(memberStateOn(h, TODAY, none, TZ)).toBe('quiet');
  });

  it('reads a habit skipped today as quiet', () => {
    expect(memberStateOn(habit({ id: 'h', skippedDates: [TODAY] }), TODAY, none, TZ)).toBe('quiet');
  });

  it('reads a held-off member as quiet', () => {
    expect(memberStateOn(habit({ id: 'h' }), TODAY, new Set(['h']), TZ)).toBe('quiet');
  });
});

describe('buildAtlasCards', () => {
  it('collects a project by name, skipping subtasks and cancelled items', () => {
    const items = [
      task({ id: 'a', project: 'Work' }),
      task({ id: 'sub', project: 'Work', parentItemId: 'a' } as Partial<Item> & { id: string }),
      task({ id: 'x', project: 'Work', status: 'cancelled' }),
      task({ id: 'b', project: 'work' }),
      task({ id: 'other', project: 'Home' }),
    ];
    const cards = buildAtlasCards(input({ items, projects: [project('Work')] }));
    const work = cardOf(cards, 'project:p-Work');
    expect(work.members.map((m) => m.item.id)).toEqual(['a', 'b']);
    expect(work.kindLabel).toBe('Project');
  });

  it('skips trashed ids named by a join array', () => {
    const items = [habit({ id: 'h1' })];
    const cards = buildAtlasCards(input({ items, routines: [routine('r', ['h1', 'gone'])] }));
    expect(cardOf(cards, 'routine:r').members.map((m) => m.item.id)).toEqual(['h1']);
  });

  it("counts a season's routine members as its own", () => {
    const items = [habit({ id: 'h1' }), task({ id: 't1' })];
    const cards = buildAtlasCards(
      input({
        items,
        routines: [routine('r', ['h1'])],
        seasons: [season('s', { itemIds: ['t1'], routineIds: ['r'] })],
      })
    );
    expect(cardOf(cards, 'season:s').members.map((m) => m.item.id).sort()).toEqual(['h1', 't1']);
  });

  it('counts lit out of lit and open, leaving quiet ones out', () => {
    const items = [
      habit({ id: 'done', completedDates: [TODAY] }),
      habit({ id: 'due' }),
      habit({ id: 'skipped', skippedDates: [TODAY] }),
    ];
    const card = cardOf(buildAtlasCards(input({ items, routines: [routine('r', ['done', 'due', 'skipped'])] })), 'routine:r');
    expect(card.lit).toBe(1);
    expect(card.total).toBe(2);
    expect(card.tiles).toEqual(['open', 'lit', 'quiet']);
  });

  it('reads a routine as All done on its off day', () => {
    const items = [habit({ id: 'mon', repeatFrequency: 'custom', repeatDays: [1] } as Partial<Item> & { id: string })];
    const card = cardOf(buildAtlasCards(input({ items, routines: [routine('r', ['mon'])] })), 'routine:r');
    expect(card.next).toBeNull();
    expect(card.allDone).toBe(true);
    expect(card.tiles).toEqual(['quiet']);
  });

  it("takes a routine's next step in its own order", () => {
    const items = [habit({ id: 'a' }), habit({ id: 'b' }), habit({ id: 'c', completedDates: [TODAY] })];
    const card = cardOf(buildAtlasCards(input({ items, routines: [routine('r', ['c', 'b', 'a'])] })), 'routine:r');
    expect(card.next?.item.id).toBe('b');
    expect(card.openRows.map((m) => m.item.id)).toEqual(['b', 'a']);
  });

  it("takes a project's next step dated first, then by order", () => {
    const items = [
      task({ id: 'undated-first', project: 'Work', order: 0 }),
      task({ id: 'later', project: 'Work', startDate: '2026-03-20', order: 5 }),
      task({ id: 'sooner', project: 'Work', startDate: '2026-03-12', order: 9 }),
    ];
    const card = cardOf(buildAtlasCards(input({ items, projects: [project('Work')] })), 'project:p-Work');
    expect(card.next?.item.id).toBe('sooner');
    expect(card.openRows.map((m) => m.item.id)).toEqual(['sooner', 'later', 'undated-first']);
  });

  it("gives a goal's next step from its non-milestone members, and never offers a milestone for Today", () => {
    const items = [task({ id: 'ms', startDate: '2026-04-01' }), task({ id: 'feed' })];
    const g = goal('g', { milestoneIds: ['ms'], memberIds: ['feed'] });
    const card = cardOf(buildAtlasCards(input({ items, goals: [g] })), 'goal:g');
    expect(card.next?.item.id).toBe('feed');
    expect(card.nextOffersToday).toBe(true);
    expect(card.milestones?.map((m) => [m.id, m.next])).toEqual([['ms', true]]);
    expect(card.feeds).toBe(1);
    expect(card.total).toBe(1);
    expect(card.lit).toBe(0);

    // Only the milestone is open: it is the track's "next", never the row.
    const onlyMs = cardOf(
      buildAtlasCards(input({ items: [task({ id: 'ms' })], goals: [goal('g', { milestoneIds: ['ms'] })] })),
      'goal:g'
    );
    expect(onlyMs.next).toBeNull();
    expect(onlyMs.milestones?.[0].next).toBe(true);
  });

  it('never offers a recurring next step for Today', () => {
    const card = cardOf(buildAtlasCards(input({ items: [habit({ id: 'h' })], routines: [routine('r', ['h'])] })), 'routine:r');
    expect(card.next?.item.id).toBe('h');
    expect(card.nextOffersToday).toBe(false);
  });

  it('shows the dashed All done state with nothing open', () => {
    const items = [task({ id: 'a', project: 'Work', status: 'completed' })];
    const card = cardOf(buildAtlasCards(input({ items, projects: [project('Work')] })), 'project:p-Work');
    expect(card.allDone).toBe(true);
    expect(card.next).toBeNull();
  });

  it('leaves a project of undated one-offs with no known touch neutral, never resting', () => {
    const items = [task({ id: 'a', project: 'Work' }), task({ id: 'b', project: 'Work' })];
    const card = cardOf(buildAtlasCards(input({ items, projects: [project('Work')] })), 'project:p-Work');
    expect(card.touch).toEqual({ kind: 'unknown' });
    expect(card.resting).toBe(false);
  });

  it('rests from a known old touch, and not from a recent one', () => {
    const old = cardOf(
      buildAtlasCards(input({ items: [habit({ id: 'h', completedDates: ['2026-02-01'] })], routines: [routine('r', ['h'])] })),
      'routine:r'
    );
    expect(old.touch).toEqual({ kind: 'resting', since: '2026-02-01' });
    expect(old.resting).toBe(true);
    const recent = cardOf(
      buildAtlasCards(input({ items: [habit({ id: 'h', completedDates: ['2026-03-08'] })], routines: [routine('r', ['h'])] })),
      'routine:r'
    );
    expect(recent.touch).toEqual({ kind: 'touched', on: '2026-03-08', days: 2 });
    expect(recent.resting).toBe(false);
  });

  it('rests while paused or switched off', () => {
    const paused = cardOf(
      buildAtlasCards(
        input({
          items: [habit({ id: 'h' })],
          routines: [routine('r', ['h'], { pausedAt: '2026-03-01T00:00:00Z', pausedUntil: '2026-04-04' })],
        })
      ),
      'routine:r'
    );
    expect(paused.touch).toEqual({ kind: 'paused', until: '2026-04-04' });
    expect(paused.resting).toBe(true);
    // A paused member is quiet, not open.
    expect(paused.tiles).toEqual(['quiet']);

    const off = cardOf(buildAtlasCards(input({ items: [], seasons: [season('s', { state: 'paused' })] })), 'season:s');
    expect(off.resting).toBe(true);
    expect(off.touch.kind).toBe('paused');
  });

  it('caps the strip at 30 tiles with the rest as +n', () => {
    const items = Array.from({ length: 42 }, (_, i) => task({ id: `t${i}`, project: 'Work', status: i < 20 ? 'completed' : 'pending' }));
    const card = cardOf(buildAtlasCards(input({ items, projects: [project('Work')] })), 'project:p-Work');
    expect(card.tiles).toHaveLength(ATLAS_TILE_CAP);
    expect(card.moreTiles).toBe(12);
    // Open first, then lit.
    expect(card.tiles.slice(0, 22).every((t) => t === 'open')).toBe(true);
    expect(card.lit).toBe(20);
    expect(card.total).toBe(42);
  });

  it("colours a project by projectColorToken, the others by their own colour or the name ramp", () => {
    const projects = [project('Work'), project('Garden', { color: 'var(--accent-3)' })];
    const cards = buildAtlasCards(
      input({ items: [], projects, routines: [routine('r', [], { color: 'var(--accent-5)' }), routine('plain', [])] })
    );
    expect(cardOf(cards, 'project:p-Work').color).toBe(projectColorToken('Work', projects));
    expect(cardOf(cards, 'project:p-Work').color).toBe('var(--habit-work)');
    expect(cardOf(cards, 'project:p-Garden').color).toBe('var(--accent-3)');
    expect(cardOf(cards, 'routine:r').color).toBe('var(--accent-5)');
    expect(cardOf(cards, 'routine:plain').color).toMatch(/^var\(--accent-\d\)$/);
  });

  it('shows no goals when the extension hands none, or the table is missing', () => {
    const g = goal('g');
    expect(buildAtlasCards(input({ items: [], goals: [] })).some((c) => c.kind === 'goal')).toBe(false);
    expect(
      buildAtlasCards(input({ items: [], goals: [g], goalsAvailable: false })).some((c) => c.kind === 'goal')
    ).toBe(false);
    expect(buildAtlasCards(input({ items: [], goals: [g] })).some((c) => c.kind === 'goal')).toBe(true);
  });

  it('hides routines and seasons while collections are unavailable', () => {
    const cards = buildAtlasCards(
      input({ items: [], routines: [routine('r', [])], seasons: [season('s')], collectionsAvailable: false })
    );
    expect(cards.filter((c) => c.kind === 'routine' || c.kind === 'season')).toEqual([]);
  });

  it('hands each recurring row its day state, and a one-off none', () => {
    const items = [habit({ id: 'h', skippedDates: [TODAY] }), task({ id: 't', project: 'Work' })];
    const cards = buildAtlasCards(input({ items, projects: [project('Work')], routines: [routine('r', ['h'])] }));
    expect(cardOf(cards, 'routine:r').members[0].todayState).toBe('skipped');
    expect(cardOf(cards, 'project:p-Work').members[0].todayState).toBeUndefined();
  });
});
