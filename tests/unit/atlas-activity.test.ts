import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ACTIVITY_BATCH,
  cachedTouches,
  cardActivity,
  clearAtlasActivity,
  readItemTouches,
  rememberTouches,
  type ActivityDeps,
} from '@/lib/atlas-activity';
import { momentumBand } from '@/lib/atlas-momentum';
import { TODAY, TZ, build, cardOf, habit, project, routine, task } from './helpers/atlas-fixtures';

/**
 * Momentum's side channel (design PR2): events read 25 ids at a time, merged
 * with the store's lastDoneOn; fetchCompletedAt throwing is quiet; a failed
 * or unavailable events read is unknown, never a resting card.
 */

const deps = (over: Partial<ActivityDeps> = {}): ActivityDeps => ({
  fetchEvents: vi.fn(async () => []),
  fetchCompletedAt: vi.fn(async () => new Map()),
  eventsAvailable: () => true,
  now: () => Date.parse(`${TODAY}T12:00:00Z`),
  ...over,
});

beforeEach(() => clearAtlasActivity());

describe('readItemTouches', () => {
  it('asks about 25 ids at a time', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `i${i}`);
    const d = deps();
    await readItemTouches(ids, d);
    const calls = (d.fetchEvents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => (c[0] as string[]).length)).toEqual([ACTIVITY_BATCH, ACTIVITY_BATCH, 10]);
  });

  it('keeps the newest stamp per item, from events and completed_at', async () => {
    const d = deps({
      fetchEvents: vi.fn(async () => [
        { id: '1', itemId: 'a', itemType: 'task', action: 'create', payload: {}, createdAt: '2026-02-01T10:00:00Z' },
        { id: '2', itemId: 'a', itemType: 'task', action: 'update', payload: { status: 'completed' }, createdAt: '2026-03-01T10:00:00Z' },
      ]),
      fetchCompletedAt: vi.fn(async () => new Map([['b', '2026-03-05T10:00:00Z']])),
    });
    const r = await readItemTouches(['a', 'b'], d);
    expect(r.eventsOk).toBe(true);
    expect(r.touches.get('a')).toBe('2026-03-01T10:00:00Z');
    expect(r.touches.get('b')).toBe('2026-03-05T10:00:00Z');
  });

  it('is quiet when fetchCompletedAt throws', async () => {
    const d = deps({ fetchCompletedAt: vi.fn(async () => Promise.reject(new Error('boom'))) });
    await expect(readItemTouches(['a'], d)).resolves.toMatchObject({ eventsOk: true });
  });

  it('marks the read untrusted when the events table is unavailable or a read throws', async () => {
    expect((await readItemTouches(['a'], deps({ eventsAvailable: () => false }))).eventsOk).toBe(false);
    expect(
      (await readItemTouches(['a'], deps({ fetchEvents: vi.fn(async () => Promise.reject(new Error('x'))) }))).eventsOk
    ).toBe(false);
  });
});

describe('cardActivity', () => {
  const cards = () =>
    build({
      items: [
        task({ id: 'a', project: 'Work' }),
        habit({ id: 'h', completedDates: ['2026-03-08'] }),
      ],
      projects: [project('Work')],
      routines: [routine('r1', ['h'])],
    });

  it("merges the server's touch with the store's lastDoneOn", () => {
    const c = cards();
    const map = cardActivity(c, { touches: new Map([['a', '2026-03-04T23:30:00Z']]), eventsOk: true }, TODAY, TZ);
    expect(map.get('project:p-Work')).toBe('2026-03-04');
    expect(map.get('routine:r1')).toBe('2026-03-08');
  });

  it('nothing known is unknown, and unknown is never a resting card', () => {
    const c = cards();
    const map = cardActivity(c, { touches: new Map(), eventsOk: true }, TODAY, TZ);
    expect(map.get('project:p-Work')).toBe('unknown');
    expect(momentumBand(cardOf(c, 'project:p-Work'), map.get('project:p-Work'), TODAY).band).not.toBe('resting');
  });

  it('an old server touch from a failed read is dropped, so no card rests on it', () => {
    const c = cards();
    const old = { touches: new Map([['a', '2025-12-01T10:00:00Z']]), eventsOk: false };
    const map = cardActivity(c, old, TODAY, TZ);
    expect(map.get('project:p-Work')).toBe('unknown');
    expect(momentumBand(cardOf(c, 'project:p-Work'), map.get('project:p-Work'), TODAY).band).toBe('soon');
    // A recent one still counts.
    const recent = cardActivity(c, { touches: new Map([['a', '2026-03-09T10:00:00Z']]), eventsOk: false }, TODAY, TZ);
    expect(recent.get('project:p-Work')).toBe('2026-03-09');
  });

  it('with no read at all, the store touch stands', () => {
    const map = cardActivity(cards(), null, TODAY, TZ);
    expect(map.get('routine:r1')).toBe('2026-03-08');
    expect(map.get('project:p-Work')).toBe('unknown');
  });
});

describe('the cache', () => {
  it('answers the same ids for a minute, then forgets', () => {
    const v = { touches: new Map([['a', 'x']]), eventsOk: true };
    rememberTouches(['b', 'a'], v, 1000);
    expect(cachedTouches(['a', 'b'], 30_000)).toBe(v);
    expect(cachedTouches(['a'], 30_000)).toBeNull();
    expect(cachedTouches(['a', 'b'], 62_000)).toBeNull();
    rememberTouches(['a'], v, 1000);
    clearAtlasActivity();
    expect(cachedTouches(['a'], 1000)).toBeNull();
  });
});
