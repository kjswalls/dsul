import { describe, it, expect } from 'vitest';
import { farthestCorner, traceAt, revealRadius, tilePhase, waveFront } from '@/lib/zen-transition';

describe('Relay Lift geometry', () => {
  it('reaches the farthest corner, not the nearest edge', () => {
    expect(farthestCorner(0, 0, 300, 400)).toBe(500);
    expect(farthestCorner(150, 200, 300, 400)).toBe(250);
  });

  it('runs one wave: the front starts at the focal and its trailing edge clears the corner at the end', () => {
    const reach = 1000;
    const band = 200;
    expect(waveFront(0, reach, band)).toBe(0);
    const end = waveFront(1, reach, band);
    // Every tile — the farthest included — has left the ring by the last frame…
    expect(tilePhase(end, reach, band)).toBeNull();
    // …and the reveal covers the corner.
    expect(revealRadius(end, band)).toBeGreaterThanOrEqual(reach);
  });

  it('keeps the reveal edge under lit tiles, half a band behind the front', () => {
    const band = 100;
    const front = 400;
    const seam = revealRadius(front, band);
    const u = tilePhase(front, seam, band);
    // A tile sitting exactly on the seam is at the ring's brightest point.
    expect(u).toBeCloseTo(0.5);
    expect(revealRadius(20, band)).toBe(0);
  });

  it('carries the outline, not the words, and thins it away at the end', () => {
    const start = traceAt(0);
    expect(start).toMatchObject({ travel: 0, out: 0, in: 0, stroke: 1 });
    // The leaving title is gone well before the outline lands…
    expect(traceAt(0.3).out).toBe(1);
    expect(traceAt(0.3).in).toBe(0);
    // …and the arriving one is fully up, with the outline landed and gone.
    const end = traceAt(1);
    expect(end).toMatchObject({ travel: 1, out: 1, in: 1, stroke: 0 });
  });
});
