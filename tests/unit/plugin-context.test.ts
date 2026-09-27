import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The OpenClaw plugin's context rendering (plan Phase 4d).
 *
 * Worth testing from the app repo even though the plugin ships separately: its
 * dist is gitignored and built at publish time, so CI gates nothing here, and
 * the one piece with real logic — deciding which items are set aside — depends
 * on a property of the SERVER's response (tasks[] is filtered, items[] is not).
 * A change on this side is exactly what would break it, silently, in a package
 * nobody rebuilds until release.
 */

import { getCache } from '@/openclaw-plugin/src/cache';
import { buildFullContext } from '@/openclaw-plugin/src/context';

vi.mock('@/openclaw-plugin/src/cache', () => ({ getCache: vi.fn() }));

const TODAY = '2026-08-10';

const task = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  type: 'task',
  id,
  title,
  status: 'pending',
  isScheduled: false,
  order: 0,
  ...over,
});

function seed(over: Record<string, unknown> = {}) {
  const items = (over.items as Record<string, unknown>[]) ?? [];
  const visibleIds = new Set((over.visible as string[]) ?? items.map((i) => i.id as string));
  vi.mocked(getCache).mockReturnValue({
    userId: 'u1',
    userTimezone: 'UTC',
    // The server's own filter, reproduced: tasks[] is items[] minus suppressed.
    tasks: items.filter((i) => i.type === 'task' && visibleIds.has(i.id as string)),
    habits: [],
    projects: [],
    // The context response's habitGroups[] is a projection of projects[] since
    // 039, and the plugin still caches it under its own name.
    habitGroups: [],
    items,
    routines: [],
    seasons: [],
    goals: [],
    fetchedAt: Date.now(),
    ...over,
  } as never);
}

describe('plugin buildFullContext — set aside', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('says nothing when every item is visible', () => {
    seed({ items: [task('t1', 'Write report')] });
    expect(buildFullContext()).not.toContain('## Set aside');
  });

  it('reports an item present in items[] but absent from tasks[]', () => {
    // The whole mechanism: the server already decided, and this reads its
    // answer rather than recomputing suppression out here.
    seed({
      items: [task('t1', 'Write report'), task('t2', 'Gym', { pausedAt: '2026-08-01T00:00:00Z' })],
      visible: ['t1'],
    });
    const out = buildFullContext();
    expect(out).toContain('## Set aside');
    expect(out).toContain('Gym');
    expect(out).toContain('paused');
    expect(out).toMatch(/do not recreate them/i);
  });

  it('names the resume date from the item’s own pause', () => {
    seed({
      items: [task('t1', 'Gym', { pausedAt: '2026-08-01T00:00:00Z', pausedUntil: '2026-09-01' })],
      visible: [],
    });
    expect(buildFullContext()).toContain('paused until 2026-09-01');
  });

  it('does NOT claim an expired pause as the cause', () => {
    // A resume normalizes to pausedUntil = today rather than clearing the pair,
    // so both columns survive on a live row. Reading pausedAt alone would
    // report a comeback date already in the past for an item that is actually
    // hidden by something else.
    seed({
      items: [task('t1', 'Gym', { pausedAt: '2026-07-01T00:00:00Z', pausedUntil: '2026-07-15' })],
      visible: [],
      seasons: [
        { id: 'p1', name: 'Summer', state: 'paused', itemIds: ['t1'], routineIds: [] },
      ],
    });
    const out = buildFullContext();
    expect(out).not.toContain('2026-07-15');
    expect(out).toContain('set aside with the Summer season');
  });

  it('blames the season when the path runs item → routine → season', () => {
    seed({
      items: [task('t1', 'Swim')],
      visible: [],
      routines: [{ id: 'r1', name: 'Morning', itemIds: ['t1'] }],
      seasons: [{ id: 'p1', name: 'Summer', state: 'paused', itemIds: [], routineIds: ['r1'] }],
    });
    // The outer container is the one that has to change for the item to return.
    expect(buildFullContext()).toContain('set aside with the Summer season');
  });

  it('falls back to a bare "set aside" rather than guessing', () => {
    // Suppressed with no cause the plugin can see — a container the server
    // declined to send, for instance. Naming something would be a guess.
    seed({ items: [task('t1', 'Gym')], visible: [] });
    expect(buildFullContext()).toContain('Gym [id: t1] — set aside');
  });

  it('does not mistake a custom type for suppressed work', () => {
    // Custom types travel in items[] and in NEITHER projection, by design. A
    // naive difference would announce every one of them as paused.
    seed({
      items: [{ ...task('t1', 'Learn Welsh'), type: 'custom', customType: 'goal' }],
      visible: [],
    });
    expect(buildFullContext()).not.toContain('## Set aside');
  });
});

describe('plugin buildFullContext — collections', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('is absent when there are none', () => {
    seed({ items: [task('t1', 'A')] });
    expect(buildFullContext()).not.toContain('## Collections');
  });

  it('reports season state as STORED, not resolved to on/off', () => {
    // Flattening 'auto' + a range to "on" would invite the repair that destroys
    // it: writing 'active' onto an auto season short-circuits the dates for
    // good. The model has to see the difference to preserve it.
    seed({
      items: [task('t1', 'A')],
      seasons: [
        {
          id: 'p1',
          name: 'Summer',
          state: 'auto',
          startsOn: '2026-06-01',
          endsOn: '2026-08-31',
          itemIds: [],
          routineIds: [],
        },
      ],
    });
    expect(buildFullContext()).toContain('Season: Summer [id: p1] (auto 2026-06-01 → 2026-08-31)');
  });

  it('marks a paused routine and leaves a live one plain', () => {
    seed({
      items: [task('t1', 'A')],
      routines: [
        { id: 'r1', name: 'Morning', itemIds: [], pausedAt: '2026-08-01T00:00:00Z' },
        { id: 'r2', name: 'Evening', itemIds: [] },
      ],
    });
    const out = buildFullContext();
    expect(out).toContain('Routine: Morning [id: r1] (paused)');
    // Anchored to end-of-line: a live routine carries no state suffix at all.
    expect(out).toMatch(/Routine: Evening \[id: r2\]$/m);
  });
});

/**
 * Goals in the plugin's context (plan Phase 4).
 *
 * The section is deliberately fact-only — no derived fraction — because
 * lib/goals.ts owns progress and lives on the other side of the package
 * boundary. These tests pin that contract: what is listed, in what order, and
 * what is left out.
 */
describe('plugin buildFullContext — goals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const goal = (over: Record<string, unknown> = {}) => ({
    id: 'g1',
    name: 'Learn Chinese',
    state: 'active',
    memberIds: [],
    milestoneIds: [],
    checkinIds: [],
    ...over,
  });

  it('says nothing at all when there are no goals', () => {
    seed({ items: [task('t1', 'A')] });
    expect(buildFullContext()).not.toContain('## Goals');
  });

  it('omits the section when every goal has ended', () => {
    seed({
      items: [task('t1', 'A')],
      goals: [goal({ state: 'achieved' }), goal({ id: 'g2', state: 'abandoned' })],
    });
    // A header over nothing is worse than no header: it invites the model to
    // answer "you have goals" and then find none to name.
    expect(buildFullContext()).not.toContain('## Goals');
  });

  it('renders the window, the why, and each role', () => {
    seed({
      items: [
        task('m1', 'HSK 3 exam', { startDate: '2026-12-01' }),
        task('c1', 'Weekly review', { repeatFrequency: 'weekly' }),
        task('w1', 'Order textbook'),
      ],
      goals: [
        goal({
          why: 'so I can talk to my in-laws',
          startsOn: '2026-01-01',
          targetOn: '2027-01-01',
          milestoneIds: ['m1'],
          checkinIds: ['c1'],
          memberIds: ['w1'],
        }),
      ],
    });
    const out = buildFullContext();
    expect(out).toContain('- Learn Chinese [id: g1] (2026-01-01 → 2027-01-01)');
    expect(out).toContain('why: so I can talk to my in-laws');
    expect(out).toContain('- milestone: HSK 3 exam [id: m1] [pending] (2026-12-01)');
    expect(out).toContain('- check-in: Weekly review [id: c1]');
    expect(out).toContain('- also holds: Order textbook');
  });

  it('marks a past-target milestone overdue and orders undated ones last', () => {
    seed({
      items: [
        task('m1', 'Someday', {}),
        task('m2', 'Missed', { startDate: '2026-07-01' }),
        task('m3', 'Soon', { startDate: '2026-09-01' }),
      ],
      goals: [goal({ milestoneIds: ['m1', 'm2', 'm3'] })],
    });
    const out = buildFullContext();
    expect(out).toContain('- milestone: Missed [id: m2] [pending] (2026-07-01, overdue)');
    // Future date carries no overdue marker.
    expect(out).toContain('- milestone: Soon [id: m3] [pending] (2026-09-01)');
    const lines = out.split('\n').filter((l) => l.includes('milestone:'));
    expect(lines.map((l) => l.match(/milestone: (\w+)/)![1])).toEqual([
      'Missed',
      'Soon',
      'Someday',
    ]);
  });

  it('skips ids whose item is not in items[]', () => {
    // The dangling-id rule: membership survives a member's soft delete, so the
    // arrays legitimately name ids the wire no longer carries. Rendering them
    // as bare uuids would invite the model to act on a trashed item.
    seed({ items: [task('t1', 'A')], goals: [goal({ milestoneIds: ['gone'], memberIds: ['gone'] })] });
    const out = buildFullContext();
    expect(out).toContain('- Learn Chinese [id: g1]');
    expect(out).not.toContain('gone');
    expect(out).not.toContain('also holds:');
  });
});
