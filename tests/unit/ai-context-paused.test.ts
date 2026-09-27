import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildDsulContext } from '@/lib/ai-context';
import type { Item, Season, Routine } from '@/lib/planner-types';

/**
 * Beacon's account of the work it is NOT showing (plan Phase 4).
 *
 * Suppressed items are filtered out of the per-type sections, which is right —
 * Beacon must not plan around a habit the user put down for the summer. The
 * failure this section closes is the one silence creates: asked about a paused
 * item by name, a model answering from an absence will say it was finished,
 * dropped, or never existed, and the last two invite a recreate that duplicates
 * the row.
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

const build = (over: {
  items: Item[];
  routines?: Routine[];
  seasons?: Season[];
}) =>
  buildDsulContext({
    projects: [],
    userTimezone: TZ,
    ...over,
  });

describe('the Paused section', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 15, 12, 0, 0)));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is absent entirely when nothing is suppressed', () => {
    // The byte-pinned contract: every input that has no suppression produces
    // exactly the output it produced before this section existed.
    expect(build({ items: [task('t1', 'Write report')] })).not.toContain('### Paused');
  });

  it('names a self-paused item and its return date', () => {
    const out = build({
      items: [task('t1', 'Gym', { pausedAt: '2026-07-01T00:00:00Z', pausedUntil: '2026-09-01' })],
    });
    expect(out).toContain('### Paused');
    expect(out).toContain('Paused until Sep 1');
    expect(out).toContain('Gym');
  });

  it('keeps the paused item out of the live task section', () => {
    const out = build({
      items: [
        task('t1', 'Write report'),
        task('t2', 'Gym', { pausedAt: '2026-07-01T00:00:00Z' }),
      ],
    });
    const paused = out.indexOf('### Paused');
    // 'Gym' appears exactly once, and after the heading — i.e. it was dropped
    // from the Tasks section and re-surfaced here, not listed in both.
    expect(out.split('Gym').length - 1).toBe(1);
    expect(out.indexOf('Gym')).toBeGreaterThan(paused);
    expect(out.indexOf('Write report')).toBeLessThan(paused);
  });

  it('groups by cause and blames the container, not the item', () => {
    const season: Season = {
      id: 'p1',
      name: 'Summer',
      state: 'paused',
      itemIds: ['t1', 't2'],
      routineIds: [],
    };
    const out = build({
      items: [task('t1', 'Swim'), task('t2', 'Read'), task('t3', 'Write report')],
      seasons: [season],
    });
    // One line, both titles, the season named with the article-and-noun rule.
    expect(out).toContain('- Hidden with your Summer season (2): Swim, Read');
    expect(out).not.toContain('Write report (');
  });

  it('tells the model these are not a backlog', () => {
    // The section is useless — worse than useless — if the model reads it as a
    // list of things to catch up on.
    const out = build({ items: [task('t1', 'Gym', { pausedAt: '2026-07-01T00:00:00Z' })] });
    expect(out).toMatch(/NOT overdue/);
    expect(out).toMatch(/do not suggest these/i);
  });

  it('caps the titles per cause but keeps the true count', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const season: Season = {
      id: 'p1',
      name: 'Summer',
      state: 'paused',
      itemIds: ids,
      routineIds: [],
    };
    const out = build({
      items: ids.map((id) => task(id, `Item ${id}`)),
      seasons: [season],
    });
    expect(out).toContain('(7):');
    expect(out).toContain('+2 more');
    expect(out).not.toContain('Item g');
  });

  it('does not list an item that was already marked today', () => {
    // isOpenLoopSuppressedOn, not a blanket activity test: a paused item with a
    // mark today is history, not an open loop, so it stays in the live section
    // and must not also be announced as set aside.
    const out = build({
      items: [
        task('t1', 'Gym', {
          pausedAt: '2026-07-01T00:00:00Z',
          status: 'completed',
        }),
      ],
    });
    expect(out).not.toContain('### Paused');
  });

  it('still gives the focused-item section a paused subject', () => {
    // The focus lookup deliberately bypasses the suppression filter: opening a
    // thread ON a paused item is explicit intent, and an unresolvable focus id
    // omits the section SILENTLY — so filtering here would leave Beacon blind
    // to the very item the conversation is about, with no error to notice.
    const items = [task('t1', 'Gym', { pausedAt: '2026-07-01T00:00:00Z' })];
    const out = buildDsulContext({
      items,
      projects: [],
      userTimezone: TZ,
      focusItemId: 't1',
    });
    expect(out).toContain('### Focused item');
    // Named in the focus section (before the type sections)…
    expect(out.indexOf('Gym')).toBeLessThan(out.indexOf('### Paused'));
    // …AND still accounted for as set aside, so the model does not read the
    // focus section as evidence that it is live work.
    expect(out).toContain('### Paused');
  });
});
