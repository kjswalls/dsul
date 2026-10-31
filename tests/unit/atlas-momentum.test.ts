import { describe, expect, it } from 'vitest';
import { momentumBand, momentumCardSignals, bandLabel } from '@/lib/atlas-momentum';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { TODAY, build, cardOf, goal, habit, project, routine, season, task } from './helpers/atlas-fixtures';

/**
 * Momentum's sort (design PR2): Now, Soon, Resting from what the app can see,
 * with a reason. A pin wins and names the app's band. Unknown activity is
 * never Resting (rule 13), paused is Resting, and no reason says "overdue".
 */

const work = (items: ReturnType<typeof task>[]) =>
  cardOf(build({ items, projects: [project('Work')] }), 'project:p-Work');

describe('momentumBand', () => {
  it('puts something on today in Now', () => {
    const c = work([task({ id: 'a', project: 'Work', startDate: TODAY })]);
    const r = momentumBand(c, 'unknown', TODAY);
    expect(r.band).toBe('now');
    expect(r.reason).toBe(ATLAS_COPY.dueToday);
  });

  it('never counts an undated open task as on today', () => {
    const c = work([task({ id: 'a', project: 'Work' })]);
    expect(momentumCardSignals(c, TODAY).dueToday).toBe(false);
  });

  it('a task dated in the past is a leftover, not "on today", and never pins a card in Now', () => {
    const c = work([task({ id: 'a', project: 'Work', startDate: '2025-09-01' })]);
    expect(momentumCardSignals(c, TODAY)).toMatchObject({ dueToday: false, nextDated: undefined });
    // With an old known touch it rests, from that date.
    expect(momentumBand(c, '2025-09-01', TODAY)).toMatchObject({ band: 'resting', why: 'resting' });
    // With nothing known it is neutral, never Now.
    expect(momentumBand(c, 'unknown', TODAY)).toMatchObject({ band: 'soon', reason: null });
  });

  it("a milestone's date is a target, never a day it is due or a next date", () => {
    const g = goal('g', { milestoneIds: ['m1', 'm2'] });
    const cards = build({
      items: [task({ id: 'm1', startDate: TODAY }), task({ id: 'm2', startDate: '2026-03-12' })],
      goals: [g],
    });
    const c = cardOf(cards, 'goal:g');
    const ms = new Set(['m1', 'm2']);
    expect(momentumCardSignals(c, TODAY, ms)).toMatchObject({ dueToday: false, nextDated: undefined });
    expect(momentumBand(c, 'unknown', TODAY, null, ms).why).not.toBe('dueToday');
  });

  it('a next date within a week is Now, within a month Soon', () => {
    expect(momentumBand(work([task({ id: 'a', project: 'Work', startDate: '2026-03-15' })]), undefined, TODAY)).toMatchObject({
      band: 'now',
      reason: ATLAS_COPY.nextDate('Mar 15'),
    });
    expect(momentumBand(work([task({ id: 'a', project: 'Work', startDate: '2026-03-30' })]), undefined, TODAY)).toMatchObject({
      band: 'soon',
      reason: ATLAS_COPY.nextDate('Mar 30'),
    });
  });

  it('reads a known touch: recent is Now or Soon, old is Resting since a date', () => {
    const c = work([task({ id: 'a', project: 'Work' })]);
    expect(momentumBand(c, '2026-03-07', TODAY)).toMatchObject({ band: 'now', reason: ATLAS_COPY.touchedOn('Mar 7') });
    expect(momentumBand(c, '2026-03-09', TODAY)).toMatchObject({ band: 'now', reason: ATLAS_COPY.touchedYesterday });
    expect(momentumBand(c, '2026-02-28', TODAY)).toMatchObject({ band: 'soon', reason: ATLAS_COPY.touchedOn('Feb 28') });
    expect(momentumBand(c, '2026-01-29', TODAY)).toMatchObject({
      band: 'resting',
      reason: ATLAS_COPY.restingSince('Jan 29'),
    });
  });

  it('unknown activity with nothing dated is Soon with no reason, never Resting', () => {
    const c = work([task({ id: 'a', project: 'Work' })]);
    for (const t of ['unknown', undefined] as const) {
      const r = momentumBand(c, t, TODAY);
      expect(r.band).toBe('soon');
      expect(r.reason).toBeNull();
    }
  });

  it('a tick today is Now, "ticked today"', () => {
    const cards = build({
      items: [habit({ id: 'h', completedDates: [TODAY] }), habit({ id: 'h2' })],
      routines: [routine('r1', ['h', 'h2'])],
    });
    expect(momentumBand(cardOf(cards, 'routine:r1'), undefined, TODAY)).toMatchObject({
      band: 'now',
      reason: ATLAS_COPY.tickedToday,
    });
  });

  it('paused is Resting, and says till when', () => {
    const cards = build({
      items: [task({ id: 'a' })],
      seasons: [season('s1', { state: 'paused', itemIds: ['a'] })],
    });
    const r = momentumBand(cardOf(cards, 'season:s1'), '2026-03-09', TODAY);
    expect(r.band).toBe('resting');
    expect(r.why).toBe('paused');
  });

  it('an achieved goal rests, said as achieved', () => {
    const cards = build({ items: [], goals: [goal('g', { state: 'achieved', achievedAt: '2026-03-01T10:00:00Z' })] });
    expect(momentumBand(cardOf(cards, 'goal:g'), undefined, TODAY)).toMatchObject({
      band: 'resting',
      reason: ATLAS_COPY.achievedOn('Mar 1'),
    });
  });

  it('a pin wins, and its reason names the app band', () => {
    const c = work([task({ id: 'a', project: 'Work' })]);
    const r = momentumBand(c, 'unknown', TODAY, 'now');
    expect(r).toMatchObject({ band: 'now', appBand: 'soon', pinned: true });
    expect(r.reason).toBe(ATLAS_COPY.pinnedHere(bandLabel('soon')));
    expect(r.reason).toBe('pinned here · the app says Soon');
  });

  it('a pin to the app band draws as the app has it, with Unpin still offered', () => {
    const c = work([task({ id: 'a', project: 'Work', startDate: TODAY })]);
    const r = momentumBand(c, undefined, TODAY, 'now');
    expect(r).toMatchObject({ band: 'now', appBand: 'now', pinned: true, reason: ATLAS_COPY.dueToday });
  });

  it('no reason ever says overdue, stalled, or counts idle days', () => {
    const reasons: (string | null)[] = [];
    const items = [
      task({ id: 'a', project: 'Work', startDate: '2026-01-01' }),
      task({ id: 'b', project: 'Work', startDate: '2026-04-01' }),
    ];
    const c = work(items);
    for (const t of ['unknown', '2026-03-10', '2026-03-01', '2025-11-01', undefined] as const) {
      for (const pin of [null, 'now', 'soon', 'resting'] as const) reasons.push(momentumBand(c, t, TODAY, pin).reason);
    }
    for (const r of reasons) expect(r ?? '').not.toMatch(/overdue|stalled|days? (idle|quiet)|quiet for/i);
  });
});
