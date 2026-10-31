import { describe, expect, it, beforeEach } from 'vitest';
import {
  atlasReadingOrder,
  atlasWalkOrder,
  lerpRect,
  reconcileWalkRoute,
  walkCamera,
  walkHoleRect,
  WALK_HOVERBAR_ROOM,
  walkFlightFlourishes,
  walkScrimPath,
  walkStopOf,
  WALK_MAX_ZOOM,
  WALK_MIN_ZOOM,
} from '@/lib/atlas-walk';
import { ATLAS_HANDOFF_ZOOM } from '@/lib/atlas-camera';
import { ATLAS_COPY, atlasCopyStrings } from '@/lib/atlas-copy';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { usePlannerStore } from '@/lib/planner-store';
import type { AtlasCard, AtlasMember, AtlasTouch } from '@/lib/atlas-model';
import type { Item } from '@/lib/planner-types';

/**
 * Walk Atlas, the pure half (lib/atlas-walk.ts): the order the walk visits
 * the cards in, the one question per card state, which verbs each stop
 * offers (gated as the focus sheet gates them), and where the camera stands.
 * The view half is tests/unit/atlas-walk-view.test.tsx.
 */

const TODAY = '2026-07-16';

beforeEach(() => {
  usePlannerStore.setState({ userTimezone: 'UTC' });
  useAtlasUiStore.getState().reset();
});

const task = (id: string, over: Partial<Item> = {}) =>
  ({
    type: 'task',
    id,
    title: `Step ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    skippedDates: [],
    ...over,
  }) as unknown as Item;

const member = (item: Item, over: Partial<AtlasMember> = {}): AtlasMember => ({
  item,
  state: 'open',
  todayState: undefined,
  ...over,
});

function card(over: Partial<AtlasCard> = {}): AtlasCard {
  const next = 'next' in over ? over.next! : member(task('a'));
  return {
    key: 'project:p1',
    kind: 'project',
    id: 'p1',
    name: 'Work',
    kindLabel: 'Project',
    color: 'var(--accent-1)',
    members: next ? [next] : [],
    tiles: [],
    moreTiles: 0,
    lit: 0,
    total: 1,
    next,
    openRows: next ? [next] : [],
    allDone: false,
    nextOffersToday: true,
    touch: { kind: 'unknown' } as AtlasTouch,
    resting: false,
    ...over,
  } as AtlasCard;
}

const NO_MILESTONES: ReadonlySet<string> = new Set();
const ids = (s: ReturnType<typeof walkStopOf>) => s.actions.map((a) => a.id);

describe('walk order', () => {
  const at = (entries: [string, number, number][]) => new Map(entries.map(([k, x, y]) => [k, { x, y }]));

  it('follows Momentum column by column and the other computed layouts row by row', () => {
    const cards = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
    const pos = at([
      ['a', 300, 0],
      ['b', 0, 200],
      ['c', 0, 0],
    ]);
    expect(atlasWalkOrder('momentum', cards, pos)).toEqual(['c', 'b', 'a']);
    expect(atlasWalkOrder('timeline', cards, pos)).toEqual(['c', 'a', 'b']);
    expect(atlasWalkOrder('goal', cards, pos)).toEqual(['c', 'a', 'b']);
    // The same order Tab follows.
    expect(atlasWalkOrder('momentum', cards, pos)).toEqual(atlasReadingOrder('momentum', cards, pos));
    expect(atlasWalkOrder('timeline', cards, pos)).toEqual(atlasReadingOrder('timeline', cards, pos));
  });

  it('reads Your map as drawn: rows from the top, each left to right, with a little slack', () => {
    const cards = [{ key: 'far-right' }, { key: 'low' }, { key: 'left' }, { key: 'nudged' }];
    const pos = at([
      ['far-right', 900, 0],
      ['left', 0, 10],
      // A card nudged a little lower still reads in the top row.
      ['nudged', 400, 60],
      ['low', 0, 400],
    ]);
    expect(atlasWalkOrder('map', cards, pos)).toEqual(['left', 'nudged', 'far-right', 'low']);
    // Tab on Your map keeps the cards' own order; only the walk reads it spatially.
    expect(atlasReadingOrder('map', cards, pos)).toEqual(['far-right', 'low', 'left', 'nudged']);
  });

  it('skips a card that is not drawn (a filter hid it)', () => {
    const cards = [{ key: 'a' }, { key: 'hidden' }, { key: 'b' }];
    const pos = at([
      ['a', 0, 0],
      ['b', 300, 0],
    ]);
    for (const layout of ['map', 'momentum', 'goal', 'timeline'] as const) {
      expect(atlasWalkOrder(layout, cards, pos)).not.toContain('hidden');
    }
  });
});

describe('the question per card', () => {
  it('asks whether the next step is still right, naming it, with Put on Today and Mark done', () => {
    const s = walkStopOf(card(), TODAY, NO_MILESTONES);
    expect(s.kind).toBe('next');
    expect(s.question).toBe(ATLAS_COPY.walkNextQuestion);
    expect(s.detail).toBe('Next up: Step a');
    expect(ids(s)).toEqual(['today', 'complete']);
  });

  it("asks what's next when nothing is open", () => {
    const done = walkStopOf(card({ next: null, allDone: true, members: [member(task('x'), { state: 'lit' })] }), TODAY, NO_MILESTONES);
    expect(done.kind).toBe('empty');
    expect(done.question).toBe("What's the next step?");
    expect(done.detail).toBe(ATLAS_COPY.walkEmptyAllDone);
    expect(ids(done)).toEqual(['organize']);
    const empty = walkStopOf(card({ next: null, members: [] }), TODAY, NO_MILESTONES);
    expect(empty.detail).toBe(ATLAS_COPY.walkEmptyNothing);
  });

  it('asks "Still want this?" of a resting card, says resting is fine, and never tallies days', () => {
    const s = walkStopOf(
      card({ resting: true, touch: { kind: 'resting', since: '2026-05-30' } }),
      TODAY,
      NO_MILESTONES
    );
    expect(s.kind).toBe('resting');
    expect(s.question).toBe('Still want this?');
    expect(s.detail).toMatch(/^Resting since .+\. Letting it rest is fine too\.$/);
    expect(s.detail).not.toMatch(/\d+ days?/);
    // Waking it is the same verb: its next step onto Today.
    expect(s.actions).toEqual([{ id: 'today', label: ATLAS_COPY.walkWake }]);

    const paused = walkStopOf(card({ resting: true, next: null, touch: { kind: 'paused' } }), TODAY, NO_MILESTONES);
    expect(paused.detail).toBe(ATLAS_COPY.walkPaused);
    expect(ids(paused)).toEqual(['organize']);
  });

  it('asks about a goal by its target day', () => {
    const s = walkStopOf(card({ kind: 'goal', key: 'goal:g', targetOn: '2026-11-04' }), TODAY, NO_MILESTONES);
    expect(s.kind).toBe('goal');
    expect(s.question).toMatch(/^Still aiming for .+\?$/);
    expect(s.detail).toBe('Next on the way: Step a');
  });

  it('asks nothing of a finished container', () => {
    const s = walkStopOf(
      card({ kind: 'goal', resting: true, touch: { kind: 'ended', reason: 'achieved' } }),
      TODAY,
      NO_MILESTONES
    );
    expect(s.kind).toBe('ended');
    expect(s.actions).toEqual([]);
  });

  it('has calm, dash-free words that the copy scan sees', () => {
    const strings = atlasCopyStrings();
    for (const w of [ATLAS_COPY.walk, ATLAS_COPY.walkCalm, ATLAS_COPY.walkNextQuestion, ATLAS_COPY.walkRestingQuestion]) {
      expect(strings).toContain(w);
    }
    const sample = [
      ATLAS_COPY.walkAnnounce(2, 9, 'Work', 'Project', ATLAS_COPY.walkNextQuestion),
      ATLAS_COPY.walkRestingSince('Sep 30'),
      ATLAS_COPY.walkGoalQuestion('Nov 4'),
    ];
    for (const s of sample) expect(s).not.toMatch(/[—–]|overdue|stalled/i);
  });
});

describe('verbs gated as the focus sheet gates them', () => {
  it('offers no Put on Today for a milestone', () => {
    const m = member(task('m'));
    const s = walkStopOf(card({ kind: 'goal', key: 'goal:g', next: m, nextOffersToday: false }), TODAY, new Set(['m']));
    expect(ids(s)).not.toContain('today');
    // Even if a card said it might: the milestone set wins.
    const forced = walkStopOf(card({ next: m, nextOffersToday: true }), TODAY, new Set(['m']));
    expect(ids(forced)).not.toContain('today');
  });

  it('offers no Put on Today for a recurring step, and names its done "for today"', () => {
    const r = member(task('r', { repeatFrequency: 'daily', startDate: '2026-07-01' } as Partial<Item>), {
      todayState: 'pending' as never,
    });
    const s = walkStopOf(card({ next: r, nextOffersToday: true }), TODAY, NO_MILESTONES);
    expect(ids(s)).not.toContain('today');
    expect(s.actions.find((a) => a.id === 'complete')?.label).toBe(ATLAS_COPY.walkCompleteToday);
  });

  it('offers no Mark done on a day a recurring step does not fall on', () => {
    const r = member(task('r', { repeatFrequency: 'weekdays' } as Partial<Item>), { todayState: 'absent' });
    expect(ids(walkStopOf(card({ next: r, nextOffersToday: false }), TODAY, NO_MILESTONES))).toEqual([]);
  });

  it('offers no Put on Today for a step already on today', () => {
    const t = member(task('t', { startDate: `${TODAY}T00:00:00` } as Partial<Item>));
    expect(ids(walkStopOf(card({ next: t }), TODAY, NO_MILESTONES))).toEqual(['complete']);
  });
});

describe('the camera', () => {
  const rect = { x: 1000, y: 500, w: 260, h: 190 };

  it('centres the card above the panel at a readable zoom', () => {
    const vp = { w: 1200, h: 800 };
    const cam = walkCamera(rect, vp, { x: 0, y: 0, z: 0.3 });
    expect(cam.z).toBeLessThanOrEqual(WALK_MAX_ZOOM);
    expect(cam.z).toBeGreaterThanOrEqual(WALK_MIN_ZOOM);
    // Above the handoff band, so the stop shows a card, not its tiles.
    expect(cam.z).toBeGreaterThan(ATLAS_HANDOFF_ZOOM);
    const cx = (rect.x + rect.w / 2) * cam.z + cam.x;
    expect(cx).toBeCloseTo(vp.w / 2);
    const bottom = (rect.y + rect.h) * cam.z + cam.y;
    expect(bottom).toBeLessThan(vp.h - 200);
  });

  it('stays finite on a zero-size viewport', () => {
    const fallback = { x: 3, y: 4, z: 1 };
    expect(walkCamera(rect, { w: 0, h: 0 }, fallback)).toBe(fallback);
  });

  it('plays the handoff only when a flight starts zoomed out', () => {
    expect(walkFlightFlourishes({ x: 0, y: 0, z: 0.3 })).toBe(true);
    expect(walkFlightFlourishes({ x: 0, y: 0, z: 1 })).toBe(false);
  });

  it('cuts a rounded hole in the veil, and none without a card', () => {
    const outer = walkScrimPath(null, 10);
    expect(outer.match(/M/g)).toHaveLength(1);
    const holed = walkScrimPath({ x: 10, y: 20, w: 100, h: 50 }, 12);
    expect(holed.match(/M/g)).toHaveLength(2);
    expect(holed).toContain('A12 12');
    expect(lerpRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 20, w: 30, h: 10 }, 0.5)).toEqual({ x: 5, y: 10, w: 20, h: 10 });
  });
});

describe('the walk route', () => {
  /** Walks `route` from its start, applying `change` after the first stop; the keys visited. */
  const walkThrough = (route: readonly string[], change: (r: readonly string[], at: string) => readonly string[]) => {
    const seen: string[] = [];
    let r = route;
    let i = 0;
    while (i < r.length) {
      const at = r[i];
      seen.push(at);
      if (seen.length === 1) {
        r = change(r, at);
        i = r.indexOf(at);
      }
      i += 1;
    }
    return seen;
  };

  it('starts as the reading order and hands itself back when nothing changed', () => {
    expect(reconcileWalkRoute([], ['a', 'b'], null)).toEqual(['a', 'b']);
    const r = ['a', 'b', 'c'];
    expect(reconcileWalkRoute(r, ['c', 'a', 'b'], 'a')).toBe(r);
  });

  it('never skips or repeats a card when the reading order re-sorts under it', () => {
    // Momentum: waking the first card moves it; Your map: dragging it far right.
    const live = ['b', 'c', 'a'];
    expect(walkThrough(['a', 'b', 'c'], (r, at) => reconcileWalkRoute(r, live, at))).toEqual(['a', 'b', 'c']);
  });

  it('drops a card that has gone and adds a new one at the end', () => {
    expect(reconcileWalkRoute(['a', 'b', 'c'], ['d', 'a', 'c'], 'a')).toEqual(['a', 'c', 'd']);
  });

  it('on a layout switch, keeps what was seen in front and re-reads what is to come', () => {
    expect(reconcileWalkRoute(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'], 'b', true)).toEqual(['a', 'b', 'd', 'c']);
    // On the closing stop (no card), a switch changes nothing.
    const r = ['a', 'b'];
    expect(reconcileWalkRoute(r, ['b', 'a'], null, true)).toBe(r);
  });
});

describe('the cut-out', () => {
  it("leaves room above the card for its hover bar, so Focus and Open stay reachable", () => {
    const cam = { x: 40, y: 30, z: 0.8 };
    const card = { x: 100, y: 200, w: 300, h: 150 };
    const hole = walkHoleRect(card, cam, 10);
    // The hover bar is drawn 32 world pixels above the card (atlas-card.tsx: -top-8).
    expect(hole.y).toBeLessThanOrEqual(card.y * cam.z + cam.y - 32 * cam.z);
    expect(hole.y + hole.h).toBeCloseTo((card.y + card.h) * cam.z + cam.y + 10);
    expect(hole.x).toBe(card.x * cam.z + cam.x - 10);
    expect(WALK_HOVERBAR_ROOM).toBeGreaterThanOrEqual(32);
  });
});

describe('the walk state', () => {
  it('starts from the camera as it is, closes the sheet, and Escape asks to go back there', () => {
    const ui = useAtlasUiStore.getState();
    ui.setCamera({ x: 12, y: 34, z: 0.8 });
    ui.openSheet('project', 'p1', { x: 0, y: 0, width: 1, height: 1 });
    ui.startWalk();
    expect(useAtlasUiStore.getState().sheet).toBeNull();
    expect(useAtlasUiStore.getState().walk).toMatchObject({ step: 0, key: null, returnTo: { x: 12, y: 34, z: 0.8 } });
    ui.walkTo(1, 'project:p2');
    ui.setCamera({ x: 900, y: 900, z: 1 });
    useAtlasUiStore.getState().endWalk(true);
    expect(useAtlasUiStore.getState().walk).toBeNull();
    expect(useAtlasUiStore.getState().walkHome).toEqual({ x: 12, y: 34, z: 0.8 });
    useAtlasUiStore.getState().clearWalkHome();
    useAtlasUiStore.getState().startWalk();
    useAtlasUiStore.getState().endWalk(false);
    expect(useAtlasUiStore.getState().walkHome).toBeNull();
  });

  it('takes a new return camera mid-walk (a layout switch) and goes back there', () => {
    const ui = useAtlasUiStore.getState();
    ui.setCamera({ x: 1, y: 1, z: 1 });
    ui.startWalk();
    useAtlasUiStore.getState().setWalkReturn({ x: 5, y: 6, z: 0.7 });
    useAtlasUiStore.getState().endWalk(true);
    expect(useAtlasUiStore.getState().walkHome).toEqual({ x: 5, y: 6, z: 0.7 });
    // No walk on: nothing to set.
    useAtlasUiStore.getState().setWalkReturn({ x: 9, y: 9, z: 1 });
    expect(useAtlasUiStore.getState().walk).toBeNull();
  });
});
