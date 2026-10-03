import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EASE_SETTLE,
  SETTLE,
  SETTLE_LIMITS,
  createKeyDeduper,
  planScope,
  type Rect,
  type SettleLimits,
  type SettleNode,
  type SettleSide,
} from '@/lib/settle-plan';
import { bumpSettleEpoch, settleEpoch } from '@/lib/settle-epoch';

/**
 * The settle conductor's pure half (lib/settle-plan.ts): what each participant
 * does when the fresh planner lands over the look-only preview. Plain rects,
 * no DOM — lib/settle.ts's capture and measure produce exactly these sides.
 *
 * FIRST − LAST is the convention throughout: a node that moved UP by 32px has
 * dy = +32, because it starts 32px lower than where it rests.
 */

const MON = '2026-10-05';
const TUE = '2026-10-06';
const WED = '2026-10-07';
const THU = '2026-10-08';

const box = (left: number, top: number, width = 200, height = 32): Rect => ({ left, top, width, height });

function row(key: string, rect: Rect, extra: Partial<SettleNode> = {}): SettleNode {
  return {
    key,
    id: key.split('|')[1]?.split('#')[0],
    role: 'row',
    rect,
    visible: true,
    // Visible rows carry a sig; same key, same content unless a test says otherwise.
    sig: `content of ${key}`,
    topLevel: extra.parent === undefined,
    ...extra,
  };
}

function frame(key: string, rect: Rect, extra: Partial<SettleNode> = {}): SettleNode {
  return { key, role: 'frame', rect, visible: true, topLevel: extra.parent === undefined, ...extra };
}

const side = (...nodes: SettleNode[]): SettleSide => ({ nodes: new Map(nodes.map((n) => [n.key, n])) });

const plan = (first: SettleSide, last: SettleSide, limits: SettleLimits = SETTLE_LIMITS) =>
  planScope(first, last, limits);

/** `n` rows stacked 32px apart from `top`, keyed `${date}|${prefix}${i}`. */
const stack = (n: number, prefix: string, top = 0, extra: Partial<SettleNode> = {}, date = MON) =>
  Array.from({ length: n }, (_, i) => row(`${date}|${prefix}${i}`, box(0, top + i * 32), extra));

describe('SETTLE constants', () => {
  it('pins every timing, hold and cap', () => {
    expect(SETTLE).toEqual({
      moveMs: 420,
      appearMs: 340,
      retypeMs: 300,
      riseMs: 320,
      riseOffsetPx: 6,
      appearLead: 100,
      frameAppearLead: 80,
      appearStagger: 24,
      appearMaxRank: 6,
      riseStagger: 24,
      riseMaxRank: 8,
      holdMinFrames: 2,
      quietFrames: 2,
      holdMaxFrames: 8,
      holdTimeoutMs: 400,
      retargetMinMs: 220,
      maxRetargets: 2,
      runTimeoutMs: 1400,
      maxNodesPerScope: 2000,
      maxAnimationsPerScope: 300,
      maxRetypes: 12,
      largeRows: 48,
      largeStructural: 24,
      shieldMs: 250,
      clipBleedPx: 8,
    });
  });

  it('keeps the worst case inside the completed-sinks hold (700ms)', () => {
    const worstAppear = SETTLE.appearLead + SETTLE.appearMaxRank * SETTLE.appearStagger + SETTLE.appearMs;
    expect(worstAppear).toBe(584);
    expect(worstAppear).toBeLessThan(700);
  });

  it('EASE_SETTLE is --ease-out-soft from app/globals.css, read as text', () => {
    expect(EASE_SETTLE).toBe('cubic-bezier(0.22, 1, 0.36, 1)');
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    const token = /--ease-out-soft:\s*([^;]+);/.exec(css);
    expect(token).not.toBeNull();
    expect(token![1].trim()).toBe(EASE_SETTLE);
  });

  it('SETTLE_LIMITS are the plan caps from SETTLE', () => {
    expect(SETTLE_LIMITS).toEqual({
      maxAnimations: SETTLE.maxAnimationsPerScope,
      maxRetypes: SETTLE.maxRetypes,
      largeRows: SETTLE.largeRows,
      largeStructural: SETTLE.largeStructural,
    });
  });
});

describe('settle epoch', () => {
  it('holds still between landings and advances on each bump', () => {
    const before = settleEpoch();
    expect(settleEpoch()).toBe(before);
    bumpSettleEpoch();
    const after = settleEpoch();
    expect(after).not.toBe(before);
    bumpSettleEpoch();
    expect(settleEpoch()).not.toBe(after);
  });
});

describe('planScope', () => {
  describe('classification', () => {
    it('sorts a landing into moves, appears and retypes; exits are counted, never animated', () => {
      const first = side(
        row(`${MON}|a`, box(0, 0)),
        row(`${MON}|b`, box(0, 32)), // removed
        row(`${MON}|c`, box(0, 64)),
        row(`${MON}|d`, box(0, 96))
      );
      const last = side(
        row(`${MON}|a`, box(0, 0), { sig: 'renamed' }), // changed in place
        row(`${MON}|c`, box(0, 32)), // closes b's gap
        row(`${MON}|d`, box(0, 64)),
        row(`${MON}|e`, box(0, 96)) // new
      );
      const p = plan(first, last);

      expect(p.mode).toBe('fine');
      expect(p.changed).toBe(true);
      expect(p.moves).toEqual([
        { key: `${MON}|c`, fromKey: `${MON}|c`, dx: 0, dy: 32 },
        { key: `${MON}|d`, fromKey: `${MON}|d`, dx: 0, dy: 32 },
      ]);
      expect(p.appears).toEqual([{ key: `${MON}|e`, role: 'row', rank: 0 }]);
      expect(p.retypes).toEqual([`${MON}|a`]);
      expect(p.rises).toEqual([]);
      // b exits: nothing names it.
      const named = [...p.moves.map((m) => m.key), ...p.appears.map((a) => a.key), ...p.retypes];
      expect(named).not.toContain(`${MON}|b`);
    });

    it('an exit alone still counts as a change (it drives the shield) with nothing to animate', () => {
      const first = side(row(`${MON}|a`, box(0, 0)), row(`${MON}|b`, box(0, 32)));
      const last = side(row(`${MON}|a`, box(0, 0)));
      expect(plan(first, last)).toEqual({
        mode: 'fine',
        moves: [],
        appears: [],
        retypes: [],
        rises: [],
        changed: true,
      });
    });

    it('a matched node needs a pixel of travel to move; sub-pixel jitter is rounding', () => {
      const first = side(row(`${MON}|a`, box(0, 10)), frame('grid', box(0, 0, 400, 400)));
      const last = side(row(`${MON}|a`, box(0.4, 10.6)), frame('grid', box(0, 0.9, 400, 400)));
      expect(plan(first, last).mode).toBe('none');

      const moved = side(row(`${MON}|a`, box(0, 11)), frame('grid', box(0, 0, 400, 400)));
      expect(plan(first, moved).moves).toEqual([{ key: `${MON}|a`, fromKey: `${MON}|a`, dx: 0, dy: -1 }]);
    });
  });

  describe('own deltas', () => {
    it('compensate the nearest moving ancestor, so nested glides compose to the true travel', () => {
      const first = side(
        frame('group:Work', box(0, 100, 300, 200)),
        row(`${MON}|r`, box(0, 140), { parent: 'group:Work' }),
        row(`${MON}|s`, box(0, 120), { parent: 'group:Work' })
      );
      const last = side(
        frame('group:Work', box(0, 60, 300, 200)), // the group rose 40
        row(`${MON}|r`, box(0, 120), { parent: 'group:Work' }), // rose 20 overall: 20 down within it
        row(`${MON}|s`, box(0, 80), { parent: 'group:Work' }) // carried exactly
      );
      const p = plan(first, last);
      expect(p.moves).toEqual([
        { key: 'group:Work', fromKey: 'group:Work', dx: 0, dy: 40 },
        { key: `${MON}|r`, fromKey: `${MON}|r`, dx: 0, dy: -20 },
      ]);
      // Composed: the row's own glide plus its group's is its whole journey.
      const r = p.moves[1];
      expect(r.dy + p.moves[0].dy).toBe(140 - 120);
    });

    it('skip an ancestor that will not animate (unseen on both sides), measuring from the next one up', () => {
      const first = side(
        frame('grid', box(0, 100, 400, 600)),
        frame('grid/wrap', box(0, 5000, 400, 10), { parent: 'grid', visible: false }),
        row(`${MON}|r`, box(0, 180), { parent: 'grid/wrap' })
      );
      const last = side(
        frame('grid', box(0, 60, 400, 600)), // total 40
        frame('grid/wrap', box(0, 4930, 400, 10), { parent: 'grid', visible: false }), // total 70, never drawn
        row(`${MON}|r`, box(0, 100), { parent: 'grid/wrap' }) // total 80
      );
      const p = plan(first, last);
      expect(p.moves.map((m) => m.key)).toEqual(['grid', `${MON}|r`]);
      // Relative to grid (the one that animates), not to the wrapper that doesn't.
      expect(p.moves[1].dy).toBe(80 - 40);
    });

    it('count an unmatched ancestor that draws nothing as zero', () => {
      const first = side(
        frame('day:a', box(0, 0, 300, 400)),
        row(`${MON}|r`, box(0, 300), { parent: 'day:a' })
      );
      const last = side(
        frame('day:a', box(0, 50, 300, 400)), // total -50
        frame('day:a/wrap', box(0, 0, 0, 0), { parent: 'day:a', visible: false }), // new, unseen
        row(`${MON}|r`, box(0, 70), { parent: 'day:a/wrap' }) // total 230
      );
      const p = plan(first, last);
      expect(p.moves).toContainEqual({ key: `${MON}|r`, fromKey: `${MON}|r`, dx: 0, dy: 230 - -50 });
      expect(p.appears).toEqual([]);
    });

    it('a matched row inside an appearing frame rides its unfold: a glide would only show through the clip', () => {
      // A task's project changed elsewhere to one with no group on screen in the preview.
      const first = side(
        frame('group:Work', box(0, 0, 300, 100)),
        row(`${MON}|r`, box(0, 40), { parent: 'group:Work', sig: 'r' }),
        row(`${MON}|s`, box(0, 72), { parent: 'group:Work' })
      );
      const last = side(
        frame('group:Work', box(0, 0, 300, 68)),
        row(`${MON}|s`, box(0, 40), { parent: 'group:Work' }),
        frame('group:Home', box(0, 68, 300, 72)), // appears
        row(`${MON}|r`, box(0, 108), { parent: 'group:Home', sig: 'r renamed' })
      );
      const p = plan(first, last);
      expect(p.appears).toEqual([{ key: 'group:Home', role: 'frame', rank: 0 }]);
      // No move and no retype for r: the unfold reveals it. s closes the gap r left.
      expect(p.moves).toEqual([{ key: `${MON}|s`, fromKey: `${MON}|s`, dx: 0, dy: 32 }]);
      expect(p.retypes).toEqual([]);
      expect(p.mode).toBe('fine');
    });
  });

  it('a row moving between groups is a move (rows keep their raw key across frames)', () => {
    const first = side(
      frame('group:Work', box(0, 0, 300, 100)),
      row(`${MON}|t1`, box(0, 40), { parent: 'group:Work' }),
      frame('group:Home', box(0, 100, 300, 100)),
      row(`${MON}|t2`, box(0, 140), { parent: 'group:Home' })
    );
    const last = side(
      frame('group:Work', box(0, 0, 300, 68)),
      frame('group:Home', box(0, 68, 300, 132)), // rose 32 as Work shrank
      row(`${MON}|t2`, box(0, 108), { parent: 'group:Home' }),
      row(`${MON}|t1`, box(0, 140), { parent: 'group:Home' })
    );
    const p = plan(first, last);
    expect(p.appears).toEqual([]);
    // Home grew a row: it uncovers that height as t1 glides into it (see reveal).
    expect(p.moves).toContainEqual({ key: 'group:Home', fromKey: 'group:Home', dx: 0, dy: 32, reveal: 32 });
    // t1: 40 → 140 overall (-100), of which Home carries +32.
    expect(p.moves).toContainEqual({ key: `${MON}|t1`, fromKey: `${MON}|t1`, dx: 0, dy: -132 });
    // t2 rode its group exactly.
    expect(p.moves.find((m) => m.key === `${MON}|t2`)).toBeUndefined();
  });

  describe('pairing by item id', () => {
    const grids = (top = 0) => [
      frame(`${MON}/grid`, box(0, top, 180, 1200)),
      frame(`${TUE}/grid`, box(200, top, 180, 1200)),
      frame(`${WED}/grid`, box(400, top, 180, 1200)),
      frame(`${THU}/grid`, box(600, top, 180, 1200)),
    ];
    // A zero structural cap turns any appear or exit into a large plan, so a fine
    // plan under it proves the pairing left none of either behind.
    const strict: SettleLimits = { ...SETTLE_LIMITS, largeStructural: 0 };

    it("a week task moved from Monday's column to Wednesday's is ONE move", () => {
      const first = side(...grids(), row(`${MON}|t1`, box(8, 300), { parent: `${MON}/grid` }));
      const last = side(...grids(), row(`${WED}|t1`, box(408, 360), { parent: `${WED}/grid` }));
      const p = plan(first, last, strict);
      expect(p.mode).toBe('fine');
      expect(p.moves).toEqual([{ key: `${WED}|t1`, fromKey: `${MON}|t1`, dx: -400, dy: -60 }]);
      expect(p.appears).toEqual([]);
    });

    it('a recurring habit drawn on several days stays unpaired', () => {
      const first = side(
        ...grids(),
        row(`${MON}|h`, box(8, 300), { parent: `${MON}/grid` }),
        row(`${TUE}|h`, box(208, 300), { parent: `${TUE}/grid` })
      );
      const last = side(
        ...grids(),
        row(`${WED}|h`, box(408, 300), { parent: `${WED}/grid` }),
        row(`${THU}|h`, box(608, 300), { parent: `${THU}/grid` })
      );
      const p = plan(first, last);
      expect(p.moves).toEqual([]);
      expect(p.appears.map((a) => a.key)).toEqual([`${WED}|h`, `${THU}|h`]);
    });

    it('an id unmatched twice on one side and once on the other stays unpaired', () => {
      const first = side(row(`${MON}|h`, box(8, 300)), row(`${TUE}|h`, box(208, 300)));
      const last = side(row(`${WED}|h`, box(408, 300)));
      const p = plan(first, last);
      expect(p.moves).toEqual([]);
      expect(p.appears).toEqual([{ key: `${WED}|h`, role: 'row', rank: 0 }]);
    });

    it('never re-pairs a row its key already matched, and never pairs frames', () => {
      const first = side(
        row(`${MON}|h`, box(8, 300)),
        row(`${TUE}|h`, box(208, 300)),
        frame('hour:9', box(0, 0, 50, 60), { id: 'x' })
      );
      const last = side(
        row(`${MON}|h`, box(8, 300)), // matched by key
        row(`${WED}|h`, box(408, 300)), // Tue's lone twin by id, so paired
        frame('hour:10', box(0, 0, 50, 60), { id: 'x' })
      );
      const p = plan(first, last);
      expect(p.moves).toEqual([{ key: `${WED}|h`, fromKey: `${TUE}|h`, dx: -200, dy: 0 }]);
      expect(p.appears).toEqual([{ key: 'hour:10', role: 'frame', rank: 0 }]);
    });
  });

  describe('appears', () => {
    it('an appearing frame suppresses its rows’ reveals — they ride its unfold', () => {
      const first = side(frame('group:Work', box(0, 0, 300, 100)));
      const last = side(
        frame('group:Work', box(0, 0, 300, 100)),
        frame('group:New', box(0, 100, 300, 100)),
        row(`${MON}|n1`, box(0, 140), { parent: 'group:New' }),
        frame('group:New/day:x', box(0, 172, 300, 28), { parent: 'group:New' }),
        row(`${MON}|n2`, box(0, 172), { parent: 'group:New/day:x' })
      );
      expect(plan(first, last).appears).toEqual([{ key: 'group:New', role: 'frame', rank: 0 }]);
    });

    it('an appearing frame that is off screen suppresses nothing', () => {
      const first = side(frame('grid', box(0, 0, 300, 600)));
      const last = side(
        frame('grid', box(0, 0, 300, 600)),
        frame('grid/hidden', box(0, 0, 0, 0), { parent: 'grid', visible: false }),
        row(`${MON}|n`, box(0, 40), { parent: 'grid/hidden' })
      );
      expect(plan(first, last).appears).toEqual([{ key: `${MON}|n`, role: 'row', rank: 0 }]);
    });

    it('rank by (top, left), counted within each role, so blocks fill top to bottom', () => {
      const first = side(frame('grid', box(0, 0, 800, 1200)));
      const last = side(
        frame('grid', box(0, 0, 800, 1200)),
        row(`${WED}|late`, box(400, 600)),
        row(`${WED}|early`, box(400, 120)),
        row(`${MON}|early`, box(0, 120)),
        frame('hour:6', box(0, 0, 800, 60))
      );
      expect(plan(first, last).appears).toEqual([
        { key: 'hour:6', role: 'frame', rank: 0 },
        { key: `${MON}|early`, role: 'row', rank: 0 },
        { key: `${WED}|early`, role: 'row', rank: 1 },
        { key: `${WED}|late`, role: 'row', rank: 2 },
      ]);
    });
  });

  describe('duplicate keys', () => {
    it('get #n in the order they are offered', () => {
      const unique = createKeyDeduper();
      expect([`${MON}|a`, `${MON}|b`, `${MON}|a`, `${MON}|a`].map(unique)).toEqual([
        `${MON}|a`,
        `${MON}|b`,
        `${MON}|a#2`,
        `${MON}|a#3`,
      ]);
    });

    it('never collide with a raw key that already ends in #n, and start over per deduper', () => {
      const unique = createKeyDeduper();
      expect(['k#2', 'k', 'k'].map(unique)).toEqual(['k#2', 'k', 'k#3']);
      expect(createKeyDeduper()('k')).toBe('k');
    });

    it('make each copy its own participant: the nth pairs with the nth', () => {
      const first = side(row(`${MON}|a`, box(0, 0)), row(`${MON}|a#2`, box(0, 100)));
      const last = side(row(`${MON}|a`, box(0, 0)), row(`${MON}|a#2`, box(0, 132)));
      expect(plan(first, last).moves).toEqual([{ key: `${MON}|a#2`, fromKey: `${MON}|a#2`, dx: 0, dy: -32 }]);
    });
  });

  describe('grow', () => {
    it('is computed for rows, even in place, and suppresses the retype', () => {
      // A block stretched 30 → 60 minutes: same start, longer, and its sig (duration) changed.
      const first = side(row(`${MON}|b`, box(0, 120, 180, 30), { sig: 'dur 30' }));
      const last = side(row(`${MON}|b`, box(0, 120, 180, 60), { sig: 'dur 60' }));
      const p = plan(first, last);
      expect(p.moves).toEqual([{ key: `${MON}|b`, fromKey: `${MON}|b`, dx: 0, dy: 0, grow: { dw: 0, dh: 30 } }]);
      expect(p.retypes).toEqual([]);
    });

    it('rides along on a move', () => {
      const first = side(row(`${MON}|b`, box(0, 120, 180, 30)));
      const last = side(row(`${MON}|b`, box(0, 180, 200, 60)));
      expect(plan(first, last).moves).toEqual([
        { key: `${MON}|b`, fromKey: `${MON}|b`, dx: 0, dy: -60, grow: { dw: 20, dh: 30 } },
      ]);
    });

    it('is never computed for frames', () => {
      const first = side(frame('group:Work', box(0, 0, 300, 100)));
      const last = side(frame('group:Work', box(0, 0, 300, 164)));
      expect(plan(first, last).mode).toBe('none');

      const moved = side(frame('group:Work', box(0, 20, 300, 164)));
      expect(plan(first, moved).moves).toEqual([{ key: 'group:Work', fromKey: 'group:Work', dx: 0, dy: -20 }]);
    });

    it('needs more than a pixel of growth; a shrink is not a grow', () => {
      const first = side(row(`${MON}|b`, box(0, 120, 180, 60), { sig: 'dur 60' }));
      expect(plan(first, side(row(`${MON}|b`, box(0, 120, 181, 61), { sig: 'dur 60' }))).mode).toBe('none');

      // Shortened in place with new content: a retype, not a grow.
      const shrunk = side(row(`${MON}|b`, box(0, 120, 180, 30), { sig: 'dur 30' }));
      const p = plan(first, shrunk);
      expect(p.moves).toEqual([]);
      expect(p.retypes).toEqual([`${MON}|b`]);
    });
  });

  describe('reveal (frames)', () => {
    const work = (height: number, top = 0) => frame('group:Work', box(0, top, 300, height));
    const inWork = (key: string, top: number) => row(`${MON}|${key}`, box(0, top), { parent: 'group:Work' });

    it('a frame of rows that grew keeps its new height hidden below its old extent', () => {
      const first = side(work(64), inWork('a', 0), inWork('b', 32));
      const last = side(work(96), inWork('n', 0), inWork('a', 32), inWork('b', 64));
      const move = plan(first, last).moves.find((m) => m.key === 'group:Work');
      expect(move).toEqual({ key: 'group:Work', fromKey: 'group:Work', dx: 0, dy: 0, reveal: 32 });
    });

    it('starts no higher than where anything inside starts, so a row gliding in from below is never cut', () => {
      // b arrives from 40px below Work's old bottom: only what lies past it starts hidden.
      const first = side(work(64), inWork('a', 0), row(`${MON}|b`, box(0, 72)));
      const last = side(work(128), inWork('a', 0), inWork('b', 32), inWork('c', 64), inWork('d', 96));
      expect(plan(first, last).moves.find((m) => m.key === 'group:Work')?.reveal).toBe(128 - 104);

      const fromFarBelow = side(work(64), inWork('a', 0), row(`${MON}|b`, box(0, 300)));
      expect(plan(fromFarBelow, last).moves.find((m) => m.key === 'group:Work')).toBeUndefined();
    });

    it('never for a frame with no rows inside (an hour cell growing is a scale change), nor for a shrink', () => {
      const hour = (h: number) => side(frame('hour:9', box(0, 0, 300, h)), frame('hour:9/x', box(0, 0, 300, 4), { parent: 'hour:9' }));
      expect(plan(hour(60), hour(75)).mode).toBe('none');

      const shrunk = plan(side(work(96), inWork('a', 0), inWork('b', 32)), side(work(64), inWork('a', 0), inWork('b', 32)));
      expect(shrunk.moves.find((m) => m.key === 'group:Work')).toBeUndefined();
    });

    it('never when something inside ends hanging out past the bleed: the clip would cut it until the run ends', () => {
      const first = side(work(64), inWork('a', 0));
      const last = side(work(96), inWork('a', 0), inWork('n', 32), row(`${MON}|tip`, box(0, 100, 200, 20), { parent: 'group:Work' }));
      expect(plan(first, last).moves.find((m) => m.key === 'group:Work')).toBeUndefined();
    });
  });

  describe('retype', () => {
    it('only when the row stayed within a pixel and its sig differs', () => {
      const first = side(
        row(`${MON}|a`, box(0, 0), { sig: 'a1' }),
        row(`${MON}|b`, box(0, 32), { sig: 'b1' }),
        row(`${MON}|c`, box(0, 64), { sig: 'c1' })
      );
      const last = side(
        row(`${MON}|a`, box(0, 0.5), { sig: 'a2' }), // stayed, changed → retype
        row(`${MON}|b`, box(0, 34), { sig: 'b2' }), // moved and changed → a move only
        row(`${MON}|c`, box(0, 64), { sig: 'c1' }) // stayed, unchanged
      );
      const p = plan(first, last);
      expect(p.retypes).toEqual([`${MON}|a`]);
      expect(p.moves.map((m) => m.key)).toEqual([`${MON}|b`]);
    });

    it('measures "stayed" by its own delta, so a row carried by its group can retype', () => {
      const first = side(
        frame('group:Work', box(0, 100, 300, 100)),
        row(`${MON}|a`, box(0, 140), { parent: 'group:Work', sig: 'old' })
      );
      const last = side(
        frame('group:Work', box(0, 60, 300, 100)),
        row(`${MON}|a`, box(0, 100), { parent: 'group:Work', sig: 'new' })
      );
      const p = plan(first, last);
      expect(p.moves.map((m) => m.key)).toEqual(['group:Work']);
      expect(p.retypes).toEqual([`${MON}|a`]);
    });

    it('never on a missing sig (the row was off screen at capture) or for a frame', () => {
      const first = side(
        row(`${MON}|a`, box(0, 0), { sig: undefined }),
        frame('group:Work', box(0, 100, 300, 100))
      );
      const last = side(
        row(`${MON}|a`, box(0, 0), { sig: 'now visible' }),
        frame('group:Work', box(0, 100, 300, 100), { sig: 'whatever' })
      );
      expect(plan(first, last).mode).toBe('none');
    });

    it('keeps the first 12 by top', () => {
      const tops = Array.from({ length: 20 }, (_, i) => (i * 7) % 20); // a shuffled 0..19
      const first = side(...tops.map((t) => row(`${MON}|r${t}`, box(0, t * 32), { sig: 'old' })));
      const last = side(...tops.map((t) => row(`${MON}|r${t}`, box(0, t * 32), { sig: 'new' })));
      const p = plan(first, last);
      expect(p.mode).toBe('fine');
      expect(p.retypes).toEqual(Array.from({ length: 12 }, (_, t) => `${MON}|r${t}`));
    });
  });

  describe('mode', () => {
    it('130 hour-cell frame moves alone are not large — the row thresholds count rows only', () => {
      // A range change in a week: 7 columns × ~19 hour cells all slide down an hour.
      const cells = (top: number) =>
        Array.from({ length: 130 }, (_, i) => {
          const col = i % 7;
          const hour = Math.floor(i / 7);
          return frame(`col${col}/hour:${hour}`, box(col * 100, top + hour * 60, 100, 60));
        });
      const p = plan(side(...cells(0)), side(...cells(60)));
      expect(p.mode).toBe('fine');
      expect(p.moves).toHaveLength(130);
    });

    it('rows: more than 48 moved, appeared or exited is large; 48 is not', () => {
      const moved = (n: number) => plan(side(...stack(n, 'r', 0)), side(...stack(n, 'r', 32)));
      expect(moved(48).mode).toBe('fine');
      expect(moved(49).mode).toBe('large');

      // Mixed: 30 moves + 10 appears + 9 exits = 49 rows. Structural is 19, under its cap.
      const first = side(...stack(30, 'm', 0), ...stack(9, 'x', 2000));
      const last = side(...stack(30, 'm', 32), ...stack(10, 'n', 4000));
      expect(plan(first, last).mode).toBe('large');
    });

    it('structural: more than 24 appears plus exits is large, whatever their role', () => {
      const base = frame('grid', box(0, 0, 400, 4000));
      expect(plan(side(base), side(base, ...stack(24, 'n', 100))).mode).toBe('fine');
      expect(plan(side(base), side(base, ...stack(25, 'n', 100))).mode).toBe('large');
      expect(plan(side(base, ...stack(25, 'x', 100)), side(base)).mode).toBe('large');

      const hours = Array.from({ length: 25 }, (_, h) => frame(`hour:${h}`, box(0, h * 60, 400, 60)));
      expect(plan(side(base), side(base, ...hours)).mode).toBe('large');
    });

    it('more animations than maxAnimations is large, even with no rows at all', () => {
      const cells = (top: number) =>
        Array.from({ length: 301 }, (_, i) => frame(`hour:${i}`, box(0, top + i * 10, 400, 10)));
      expect(plan(side(...cells(0)), side(...cells(10))).mode).toBe('large');
      const fewer = (top: number) => cells(top).slice(0, 300);
      expect(plan(side(...fewer(0)), side(...fewer(10))).mode).toBe('fine');
    });

    it('large empties the lists and rises the visible top-level nodes of LAST, by (top, left)', () => {
      const group = (top: number) => frame('group:Work', box(0, top, 300, 2000));
      const first = side(group(0), ...stack(49, 'r', 0, { parent: 'group:Work' }), frame('gone', box(0, 0, 10, 10)));
      const last = side(
        frame('aside', box(400, 0, 200, 200)),
        group(40),
        ...stack(49, 'r', 80, { parent: 'group:Work', sig: 'new' }),
        frame('header', box(0, 0, 300, 40)),
        frame('below', box(0, 9000, 300, 40), { visible: false }),
        row(`${MON}|loose`, box(0, 3000))
      );
      expect(plan(first, last)).toEqual({
        mode: 'large',
        moves: [],
        appears: [],
        retypes: [],
        rises: [
          { key: 'header', rank: 0 },
          { key: 'aside', rank: 1 },
          { key: 'group:Work', rank: 2 },
          { key: `${MON}|loose`, rank: 3 },
        ],
        changed: true,
      });
    });
  });

  describe('invisible nodes neither animate nor count', () => {
    it('a node unseen on both sides never moves, appears, exits or retypes', () => {
      const first = side(
        row(`${MON}|moved`, box(0, 5000), { visible: false }),
        row(`${MON}|gone`, box(0, 5100), { visible: false }),
        row(`${MON}|edited`, box(0, 5200), { visible: false, sig: undefined })
      );
      const last = side(
        row(`${MON}|moved`, box(0, 6000), { visible: false }),
        row(`${MON}|new`, box(0, 6100), { visible: false }),
        row(`${MON}|edited`, box(0, 5200), { visible: false, sig: undefined })
      );
      expect(plan(first, last)).toEqual({
        mode: 'none',
        moves: [],
        appears: [],
        retypes: [],
        rises: [],
        changed: false,
      });
    });

    it('an 800-row scope with 25 on screen moves those 25 and stays fine', () => {
      // A row added at the top of a long braindump: every row shifts down 32px.
      const onScreen = (i: number, top: number) => top + i * 32 < 800;
      const rows = (top: number) =>
        Array.from({ length: 800 }, (_, i) => {
          const visible = onScreen(i, top);
          return row(`|r${i}`, box(0, top + i * 32), { visible, sig: visible ? `r${i}` : undefined });
        });
      const p = plan(side(...rows(0)), side(row('|new', box(0, 0)), ...rows(32)));
      expect(p.mode).toBe('fine');
      // Rows 0..24 were on screen in FIRST; row 24 still moves as it glides below the fold.
      expect(p.moves).toHaveLength(25);
      expect(p.appears).toEqual([{ key: '|new', role: 'row', rank: 0 }]);
    });

    it('hidden churn cannot tip a scope into large', () => {
      const first = side(...stack(100, 'x', 5000, { visible: false }), row(`${MON}|a`, box(0, 0)));
      const last = side(...stack(100, 'n', 9000, { visible: false }), row(`${MON}|a`, box(0, 32)));
      const p = plan(first, last);
      expect(p.mode).toBe('fine');
      expect(p.moves.map((m) => m.key)).toEqual([`${MON}|a`]);
    });

    it('a node visible on either side moves: one gliding into view does', () => {
      const first = side(row(`${MON}|a`, box(0, 5000), { visible: false, sig: undefined }));
      const last = side(row(`${MON}|a`, box(0, 200)));
      expect(plan(first, last).moves).toEqual([{ key: `${MON}|a`, fromKey: `${MON}|a`, dx: 0, dy: 4800 }]);
    });
  });

  describe('none', () => {
    it('when nothing changed', () => {
      const nodes = () => [
        frame('group:Work', box(0, 0, 300, 100)),
        row(`${MON}|a`, box(0, 40), { parent: 'group:Work' }),
      ];
      expect(plan(side(...nodes()), side(...nodes()))).toEqual({
        mode: 'none',
        moves: [],
        appears: [],
        retypes: [],
        rises: [],
        changed: false,
      });
      expect(plan(side(), side()).mode).toBe('none');
    });
  });

  it('is pure: the inputs are untouched and a re-plan gives the same answer', () => {
    const first = side(frame('g', box(0, 0, 300, 300)), row(`${MON}|a`, box(0, 40), { parent: 'g' }));
    const last = side(frame('g', box(0, 20, 300, 300)), row(`${MON}|b`, box(0, 40), { parent: 'g' }));
    const snapshot = JSON.stringify([[...first.nodes], [...last.nodes]]);
    const once = plan(first, last);
    expect(plan(first, last)).toEqual(once);
    expect(JSON.stringify([[...first.nodes], [...last.nodes]])).toBe(snapshot);
  });
});
