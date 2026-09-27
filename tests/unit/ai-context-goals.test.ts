import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildDsulContext } from '@/lib/ai-context';
import type { Goal, Item, Season } from '@/lib/planner-types';

/**
 * Beacon's account of what the work is FOR (plan Phase 4).
 *
 * The plan names this file's absence as a gate: without a goals fixture the
 * byte-pinned context tests verify the section only by never reaching it, which
 * is a true but empty check. Two things are load-bearing here — the section
 * must stay OFF for every input that had it off before, and when it is on it
 * must not recommend the exact item the Paused section forbids three lines
 * later.
 */

const TZ = 'UTC';

const task = (id: string, title: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'task',
    id,
    title,
    status: 'pending',
    isScheduled: true,
    order: 0,
    startDate: '2026-07-15',
    ...over,
  }) as Item;

const goal = (over: Partial<Goal> = {}): Goal =>
  ({
    id: 'g1',
    name: 'Learn Chinese',
    state: 'active',
    memberIds: [],
    milestoneIds: [],
    checkinIds: [],
    ...over,
  }) as Goal;

const build = (over: { items: Item[]; goals?: Goal[]; seasons?: Season[]; focusItemId?: string }) =>
  buildDsulContext({ projects: [], userTimezone: TZ, ...over });

describe('the Long-term goals section', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 15, 12, 0, 0)));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is absent when no goals are passed', () => {
    expect(build({ items: [task('t1', 'A')] })).not.toContain('Long-term goals');
  });

  it('is absent when every goal has ended — double-guarded, not just "goals exist"', () => {
    const out = build({
      items: [task('t1', 'A')],
      goals: [goal({ state: 'achieved' }), goal({ id: 'g2', state: 'abandoned' })],
    });
    // A header over nothing invites the model to answer "you have goals" and
    // then find none to name.
    expect(out).not.toContain('Long-term goals');
  });

  it('names the goal, its progress, its why and its target', () => {
    const out = build({
      items: [
        task('m1', 'HSK 3 exam', { startDate: '2026-09-01' }),
        task('m2', 'HSK 2 exam', { startDate: '2026-05-01', status: 'completed' }),
      ],
      goals: [
        goal({
          why: 'so I can talk to my in-laws',
          targetOn: '2027-01-01',
          milestoneIds: ['m1', 'm2'],
        }),
      ],
    });
    expect(out).toContain('### Long-term goals');
    expect(out).toContain('- Learn Chinese — 1/2 milestones · next: HSK 3 exam by 2026-09-01 · target 2027-01-01');
    expect(out).toContain('  why: so I can talk to my in-laws');
  });

  it('says "no milestones yet" rather than 0/0', () => {
    const out = build({ items: [task('t1', 'A')], goals: [goal({ memberIds: ['t1'] })] });
    // 0/0 reads as "nothing done" about a goal that has nothing to do yet.
    expect(out).toContain('- Learn Chinese — no milestones yet');
  });

  it('ADVANCES past a suppressed milestone instead of losing the line', () => {
    // The review's finding. Naming a suppressed item as "next" recommends the
    // work ### Paused forbids; dropping the line left a goal with a milestone
    // count and no milestone — and a future-dated second milestone appears in
    // no other section, so Beacon had nothing to say at all.
    const out = build({
      items: [
        task('m1', 'HSK 3 exam', { startDate: '2026-08-01' }),
        task('m2', 'HSK 4 exam', { startDate: '2026-10-01' }),
      ],
      goals: [goal({ milestoneIds: ['m1', 'm2'] })],
      seasons: [
        {
          id: 'p1',
          name: 'Summer',
          state: 'paused',
          itemIds: ['m1'],
          routineIds: [],
        } as Season,
      ],
    });
    expect(out).toContain('next: HSK 4 exam by 2026-10-01');
    // And the suppressed one is never offered as next…
    expect(out).not.toContain('next: HSK 3 exam');
    // …while still being accounted for, so the model does not read its absence
    // as "deleted" and recreate it.
    expect(out).toContain('### Paused');
    expect(out).toContain('HSK 3 exam');
  });

  it('drops the next-milestone clause when every milestone is suppressed', () => {
    const out = build({
      items: [task('m1', 'HSK 3 exam', { startDate: '2026-08-01' })],
      goals: [goal({ milestoneIds: ['m1'] })],
      seasons: [
        { id: 'p1', name: 'Summer', state: 'paused', itemIds: ['m1'], routineIds: [] } as Season,
      ],
    });
    expect(out).toContain('- Learn Chinese — 0/1 milestones');
    expect(out).not.toContain('next:');
  });

  it('uses a heading a custom item type cannot collide with', () => {
    // The registry renders one section per hydrated custom type as
    // `### ${labelPlural}`, and a user may well have a type called "Goals".
    // Two identical headings in one prompt — one listing items, one listing
    // containers — is worse than a longer name.
    const out = build({ items: [task('t1', 'A')], goals: [goal()] });
    expect(out).toContain('### Long-term goals');
    expect(out).not.toMatch(/^### Goals$/m);
  });
});

describe('the focused item names what it serves', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 15, 12, 0, 0)));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says which goal, and in what role', () => {
    // The single most relevant fact about "HSK 3 exam" in a thread about it.
    const out = build({
      items: [task('m1', 'HSK 3 exam', { startDate: '2026-09-01' })],
      goals: [goal({ milestoneIds: ['m1'] })],
      focusItemId: 'm1',
    });
    expect(out).toContain('### Focused item');
    expect(out).toMatch(/- Serves:.*Learn Chinese/);
    expect(out).toMatch(/- Serves:.*milestone/);
  });

  it('says nothing when the focused item serves no goal', () => {
    const out = build({
      items: [task('t1', 'Buy milk')],
      goals: [goal()],
      focusItemId: 't1',
    });
    expect(out).toContain('### Focused item');
    expect(out).not.toContain('- Serves:');
  });

  it('adds nothing at all when no goals are passed — the pinned tests stay exact', () => {
    const out = build({ items: [task('t1', 'Buy milk')], focusItemId: 't1' });
    expect(out).not.toContain('- Serves:');
    expect(out).not.toContain('Long-term goals');
  });
});
