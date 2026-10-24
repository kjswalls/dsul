import { describe, it, expect } from 'vitest';
import {
  DAY_END_MIN,
  RESIZE_MIN_DURATION,
  RESIZE_SNAP_MIN,
  minutesToTime,
  resizeDeltaMin,
  resizePreview,
  resizeWrite,
  snapToQuarter,
  type ResizeEdge,
} from '@/lib/schedule-resize';
import { getBucketForTime } from '@/lib/time-bucket';
import { ItemWriteSchema } from '@/lib/app-api';

/**
 * lib/schedule-resize.ts: where a dragged edge puts a block, and what it
 * writes. The web's handles (components/views/day-schedule.tsx) and the
 * iPhone's grips (DsulCore ScheduleMath.swift resizePreview, against
 * tests/fixtures/day/resize.json) both ask it. What the block itself writes
 * through the store is in schedule-resize-pointer.test.tsx.
 */

/**
 * The web's inline maths before the extraction (day-schedule.tsx at
 * ac917b2f), kept as the oracle for "every block inside the day lands where
 * it did".
 */
function before(edge: ResizeEdge, startMin: number, duration: number, delta: number) {
  const snap = (m: number) => Math.round(m / 15) * 15;
  if (edge === 'bottom') return { startMin, duration: Math.max(15, snap(duration + delta)) };
  const end = startMin + duration;
  const ns = Math.min(Math.max(0, snap(startMin + delta)), end - 15);
  return { startMin: ns, duration: end - ns };
}
const bucketBefore = (m: number) => {
  const h = Math.floor(m / 60);
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
};

describe('snapToQuarter', () => {
  it('rounds to the nearest quarter hour, halves up as Math.round does', () => {
    expect([0, 7.4, 7.5, 14, 22.5, 52.5, 60].map(snapToQuarter)).toEqual([0, 0, 15, 15, 30, 60, 60]);
    // A negative half rounds toward zero (-7.5 is -0.5 quarters, Math.round says
    // -0): no answer of resizePreview depends on it, since a negative start is
    // clamped to 0 and a negative length to the floor.
    expect(snapToQuarter(-7.5) === 0).toBe(true);
    expect(snapToQuarter(-22.5)).toBe(-15);
    expect(snapToQuarter(-22.6)).toBe(-30);
  });

  it('uses the constants the phone reads', () => {
    expect({ RESIZE_SNAP_MIN, RESIZE_MIN_DURATION, DAY_END_MIN }).toEqual({
      RESIZE_SNAP_MIN: 15,
      RESIZE_MIN_DURATION: 15,
      DAY_END_MIN: 1440,
    });
  });
});

describe('resizeDeltaMin', () => {
  it('turns pixels into minutes at the hour height', () => {
    expect(resizeDeltaMin(75, 75)).toBe(60);
    expect(resizeDeltaMin(-18.75, 75)).toBe(-15);
    expect(resizeDeltaMin(26, 52)).toBe(30);
    expect(resizeDeltaMin(0, 40)).toBe(0);
  });
});

describe('resizePreview: the bottom edge', () => {
  it('changes the length in quarter hours and keeps the start', () => {
    expect(resizePreview('bottom', 600, 60, 30)).toEqual({ startMin: 600, duration: 90 });
    expect(resizePreview('bottom', 600, 60, -30)).toEqual({ startMin: 600, duration: 30 });
    expect(resizePreview('bottom', 600, 60, 7.4)).toEqual({ startMin: 600, duration: 60 });
    expect(resizePreview('bottom', 600, 60, 7.5)).toEqual({ startMin: 600, duration: 75 });
  });

  it('snaps the length, not the end: an odd start keeps an odd end', () => {
    expect(resizePreview('bottom', 550, 30, 20)).toEqual({ startMin: 550, duration: 45 });
  });

  it('never goes under 15 minutes', () => {
    expect(resizePreview('bottom', 600, 60, -500)).toEqual({ startMin: 600, duration: 15 });
    expect(resizePreview('bottom', 600, 10, 0)).toEqual({ startMin: 600, duration: 15 });
  });

  it('stops at midnight', () => {
    expect(resizePreview('bottom', 1380, 30, 120)).toEqual({ startMin: 1380, duration: 60 });
    expect(resizePreview('bottom', 1380, 30, 30)).toEqual({ startMin: 1380, duration: 60 });
    expect(resizePreview('bottom', 0, 60, 5000)).toEqual({ startMin: 0, duration: 1440 });
    // A block stored past midnight comes back inside the day at its first move.
    expect(resizePreview('bottom', 1380, 120, 0)).toEqual({ startMin: 1380, duration: 60 });
  });

  it('lets the day win over the floor for a block starting after 23:45', () => {
    expect(resizePreview('bottom', 1430, 10, 60)).toEqual({ startMin: 1430, duration: 10 });
    expect(resizePreview('bottom', 1430, 10, -60)).toEqual({ startMin: 1430, duration: 10 });
    expect(resizePreview('bottom', 1439, 30, 0)).toEqual({ startMin: 1439, duration: 1 });
    expect(resizePreview('bottom', 1425, 15, 60)).toEqual({ startMin: 1425, duration: 15 });
  });
});

describe('resizePreview: the top edge', () => {
  it('moves the start in quarter hours and keeps the end', () => {
    expect(resizePreview('top', 600, 60, -30)).toEqual({ startMin: 570, duration: 90 });
    expect(resizePreview('top', 600, 60, 30)).toEqual({ startMin: 630, duration: 30 });
    expect(resizePreview('top', 660, 120, 90)).toEqual({ startMin: 750, duration: 30 });
  });

  it('snaps the start, so an odd start lands on a quarter', () => {
    expect(resizePreview('top', 550, 60, 0)).toEqual({ startMin: 555, duration: 55 });
  });

  it('stops 15 minutes before the end', () => {
    expect(resizePreview('top', 600, 60, 500)).toEqual({ startMin: 645, duration: 15 });
    // An odd end: the start stops 15 before it, off the quarter.
    expect(resizePreview('top', 600, 50, 500)).toEqual({ startMin: 635, duration: 15 });
  });

  it('stops at 0:00', () => {
    expect(resizePreview('top', 30, 60, -120)).toEqual({ startMin: 0, duration: 90 });
  });

  it('holds the end of a block stored past midnight at 24:00, so its start stops at 23:45', () => {
    // 23:30 for 60 ends at 0:30 tomorrow; its top edge brings the end back to midnight.
    expect(resizePreview('top', 1410, 60, 0)).toEqual({ startMin: 1410, duration: 30 });
    expect(resizePreview('top', 1410, 60, 120)).toEqual({ startMin: 1425, duration: 15 });
    expect(resizePreview('top', 1410, 60, -30)).toEqual({ startMin: 1380, duration: 60 });
    // Never longer than a day, the route's cap: once 0:00 for 1,470.
    expect(resizePreview('top', 1410, 60, -1500)).toEqual({ startMin: 0, duration: 1440 });
  });

  it('lets the day win over the floor for a block ending before 0:15', () => {
    expect(resizePreview('top', 0, 10, 15)).toEqual({ startMin: 0, duration: 10 });
    expect(resizePreview('top', 0, 10, -15)).toEqual({ startMin: 0, duration: 10 });
    // Starting after 0:00, it can only start at 0:00, so even no travel moves it there.
    expect(resizePreview('top', 5, 5, 0)).toEqual({ startMin: 0, duration: 10 });
    expect(resizePreview('top', 5, 5, 30)).toEqual({ startMin: 0, duration: 10 });
  });
});

describe('resizePreview: a block stored outside the day', () => {
  // The old maths could write a start of "24:15" or "-1:-5" (read back as -65),
  // and the agent API takes any HH:MM-shaped text.
  it('the bottom edge keeps a start outside the day, so it stays where it is', () => {
    for (const [startMin, duration] of [
      [1440, 30],
      [1455, 30],
      [-65, 15],
      [-65, 120],
    ]) {
      for (const delta of [0, 15, -15, 600, -600]) {
        expect(resizePreview('bottom', startMin, duration, delta), `${startMin}+${duration} by ${delta}`).toEqual({
          startMin,
          duration,
        });
      }
    }
  });

  it('the top edge brings a start at or after 24:00 back to 23:45 or earlier, the end at 24:00', () => {
    expect(resizePreview('top', 1440, 30, 0)).toEqual({ startMin: 1425, duration: 15 });
    expect(resizePreview('top', 1455, 30, -60)).toEqual({ startMin: 1395, duration: 45 });
  });

  it('the top edge brings a start before 0:00 to 0:00, and keeps a block that ends by 0:00', () => {
    expect(resizePreview('top', -65, 120, 0)).toEqual({ startMin: 0, duration: 55 });
    expect(resizePreview('top', -65, 15, 0)).toEqual({ startMin: -65, duration: 15 });
    expect(resizePreview('top', -65, 15, 600)).toEqual({ startMin: -65, duration: 15 });
  });
});

describe('resizePreview against the web’s maths before PR 9', () => {
  // Every 5 minutes of the day, lengths from a sliver to most of it, and travel
  // in half-quarter steps (each one a snapping boundary) a day either way.
  const STARTS = Array.from({ length: DAY_END_MIN / 5 }, (_, i) => i * 5);
  const LENGTHS = [1, 5, 10, 14, 15, 16, 20, 30, 45, 50, 60, 90, 120, 240, 600];
  const DELTAS = Array.from({ length: 401 }, (_, i) => -1500 + i * 7.5);
  const EDGES = ['top', 'bottom'] as const;

  it('lands every block that starts and ends inside the day, ending at 0:15 or later, where it did', () => {
    let compared = 0;
    const moved: string[] = [];
    for (const startMin of STARTS) {
      for (const duration of LENGTHS) {
        if (startMin + duration > DAY_END_MIN || startMin + duration < 15) continue;
        for (const edge of EDGES) {
          for (const delta of DELTAS) {
            const was = before(edge, startMin, duration, delta);
            // The bottom edge's new stop: where the old maths ran past midnight.
            if (edge === 'bottom' && was.startMin + was.duration > DAY_END_MIN) continue;
            const now = resizePreview(edge, startMin, duration, delta);
            if (now.startMin !== was.startMin || now.duration !== was.duration) {
              moved.push(`${edge} ${startMin}+${duration} by ${delta}`);
            }
            compared++;
          }
        }
      }
    }
    expect(moved).toEqual([]);
    expect(compared).toBeGreaterThan(2_000_000);
  });

  it('differs only by stopping an edge at midnight or 0:00', () => {
    const wrong: string[] = [];
    let differed = 0;
    for (const startMin of STARTS) {
      for (const duration of LENGTHS) {
        for (const edge of EDGES) {
          for (const delta of DELTAS) {
            const now = resizePreview(edge, startMin, duration, delta);
            const was = before(edge, startMin, duration, delta);
            if (now.startMin === was.startMin && now.duration === was.duration) continue;
            differed++;
            // The bottom edge: the end stops at 24:00 where it ran past. The top
            // edge of a block stored past midnight: the end comes back to 24:00
            // and the start stops at 23:45 where it ran past. Of any other block:
            // the start stops at 0:00 where it ran before.
            const ok =
              edge === 'bottom'
                ? now.startMin + now.duration === DAY_END_MIN && was.startMin + was.duration > DAY_END_MIN
                : startMin + duration > DAY_END_MIN
                  ? now.startMin + now.duration === DAY_END_MIN && now.startMin === Math.min(was.startMin, DAY_END_MIN - 15)
                  : now.startMin === 0 && was.startMin < 0;
            if (!ok) wrong.push(`${edge} ${startMin}+${duration} by ${delta}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(differed).toBeGreaterThan(0);
  });

  it('answers a block inside the day and at most a day long, or the block as pressed, and every write is the route’s', () => {
    const wrong: string[] = [];
    const sent = new Set<string>();
    // Starts from before 0:00 to past 24:00, lengths from none to over a day.
    for (let startMin = -130; startMin < DAY_END_MIN + 130; startMin += 7) {
      for (const duration of [0, 1, 15, 37, 60, 200, 1440, 1500]) {
        const end = startMin + duration;
        for (let delta = -2000; delta <= 2000; delta += 13.3) {
          for (const edge of EDGES) {
            const p = resizePreview(edge, startMin, duration, delta);
            const held = p.startMin === startMin && p.duration === duration;
            const inDay =
              p.startMin >= 0 && p.duration >= 1 && p.duration <= DAY_END_MIN && p.startMin + p.duration <= DAY_END_MIN;
            // The edge that stays: the start, or the end held to 24:00.
            const kept = edge === 'bottom' ? p.startMin === startMin : p.startMin + p.duration === Math.min(end, DAY_END_MIN);
            // Only an edge with nothing inside the day to hold to stays put.
            const holds = edge === 'bottom' ? startMin < 0 || startMin >= DAY_END_MIN : end <= 0;
            if (!(holds ? held : inDay && kept)) wrong.push(`${edge} ${startMin}+${duration} by ${delta}`);
            const write = resizeWrite(edge, { startMin, duration }, p);
            if (write) sent.add(JSON.stringify(write));
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    const refused = [...sent].filter((w) => !ItemWriteSchema.safeParse({ action: 'time', ...JSON.parse(w) }).success);
    expect(refused).toEqual([]);
    expect(sent.size).toBeGreaterThan(1000);
  });
});

describe('minutesToTime', () => {
  it('writes the stored HH:MM', () => {
    expect([0, 5, 59, 60, 570, 765, 1425, 1439].map(minutesToTime)).toEqual([
      '00:00',
      '00:05',
      '00:59',
      '01:00',
      '09:30',
      '12:45',
      '23:45',
      '23:59',
    ]);
  });
});

describe('resizeWrite', () => {
  const span = (startMin: number, duration: number) => ({ startMin, duration });

  it('the bottom edge sends the length alone, and nothing when it is unchanged', () => {
    expect(resizeWrite('bottom', span(600, 60), span(600, 90))).toEqual({ duration: 90 });
    expect(resizeWrite('bottom', span(600, 60), span(600, 60))).toBeNull();
  });

  it('the top edge sends the start, the length and the start’s part of day', () => {
    expect(resizeWrite('top', span(600, 60), span(570, 90))).toEqual({
      startTime: '09:30',
      duration: 90,
      timeBucket: 'morning',
    });
    expect(resizeWrite('top', span(660, 120), span(750, 30))).toEqual({
      startTime: '12:30',
      duration: 30,
      timeBucket: 'afternoon',
    });
    expect(resizeWrite('top', span(1080, 60), span(1020, 120))).toEqual({
      startTime: '17:00',
      duration: 120,
      timeBucket: 'evening',
    });
    expect(resizeWrite('top', span(600, 60), span(600, 60))).toBeNull();
  });

  it('an odd start let go on its own quarter still writes, since the start moved', () => {
    // 9:10 for 50, the top edge pressed and released with no travel worth a quarter.
    expect(resizeWrite('top', span(550, 50), span(555, 45))).toEqual({
      startTime: '09:15',
      duration: 45,
      timeBucket: 'morning',
    });
  });

  it('files the start as lib/time-bucket.ts does, which is the web’s old inline rule at every minute', () => {
    for (let m = 0; m < DAY_END_MIN; m++) {
      const w = resizeWrite('top', span(m === 0 ? 15 : 0, 60), span(m, 60)) as { timeBucket: string; startTime: string };
      expect(w.timeBucket, String(m)).toBe(getBucketForTime(minutesToTime(m)));
      expect(w.timeBucket, String(m)).toBe(bucketBefore(m));
    }
  });
});
