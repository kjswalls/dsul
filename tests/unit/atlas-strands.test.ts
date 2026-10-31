import { describe, expect, it } from 'vitest';
import {
  ATLAS_FRAME_PAD,
  ATLAS_FRAME_TAB,
  ATLAS_STRAND_REST_CAP,
  frameBox,
  isHotStrand,
  parseTranslate,
  strandPath,
  strandPolicy,
  strandsToDraw,
} from '@/lib/atlas-strands';

const rect = (x: number, y: number, w = 260, h = 190) => ({ x, y, w, h });
const nums = (d: string) => d.match(/-?[\d.]+/g)!.map(Number);

describe('strandPath', () => {
  it("runs from the goal's right edge to a card on its right, by its title", () => {
    const d = strandPath(rect(0, 0), rect(600, 100));
    const n = nums(d);
    expect(d.startsWith('M')).toBe(true);
    expect([n[0], n[1]]).toEqual([260, 60]);
    expect([n[6], n[7]]).toEqual([600, 128]);
  });

  it('mirrors for a card on the left', () => {
    const n = nums(strandPath(rect(600, 0), rect(0, 300)));
    expect([n[0], n[1]]).toEqual([600, 60]);
    expect([n[6], n[7]]).toEqual([260, 328]);
  });

  it('runs bottom to top for stacked cards, and top to bottom going up', () => {
    const down = nums(strandPath(rect(0, 0), rect(40, 400)));
    expect([down[0], down[1]]).toEqual([130, 190]);
    expect([down[6], down[7]]).toEqual([170, 400]);
    const up = nums(strandPath(rect(0, 400), rect(40, 0)));
    expect([up[0], up[1]]).toEqual([130, 400]);
    expect([up[6], up[7]]).toEqual([170, 190]);
  });

  it('keeps a short card\'s ends inside it', () => {
    const n = nums(strandPath(rect(0, 0, 260, 40), rect(600, 0, 260, 30)));
    expect(n[1]).toBe(20);
    expect(n[7]).toBe(15);
  });
});

describe('frameBox', () => {
  it('stands off the members, with room for the tab on top', () => {
    expect(frameBox([rect(0, 0), rect(300, 50, 260, 100)])).toEqual({
      x: -ATLAS_FRAME_PAD,
      y: -ATLAS_FRAME_TAB,
      w: 560 + ATLAS_FRAME_PAD * 2,
      h: 190 + ATLAS_FRAME_TAB + ATLAS_FRAME_PAD,
    });
  });
  it('is null with nothing to frame', () => {
    expect(frameBox([])).toBeNull();
  });
});

describe('parseTranslate', () => {
  it('reads a matrix, a matrix3d and a translate', () => {
    expect(parseTranslate('matrix(1, 0, 0, 1, 12.5, -40)')).toEqual({ x: 12.5, y: -40 });
    expect(parseTranslate('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,7,8,0,1)')).toEqual({ x: 7, y: 8 });
    expect(parseTranslate('translate(30px, 45px)')).toEqual({ x: 30, y: 45 });
    expect(parseTranslate('translate(-3px, 4.5px) scale(.96)')).toEqual({ x: -3, y: 4.5 });
  });
  it('is null for none or nonsense', () => {
    expect(parseTranslate('none')).toBeNull();
    expect(parseTranslate('')).toBeNull();
    expect(parseTranslate(undefined)).toBeNull();
    expect(parseTranslate('rotate(4deg)')).toBeNull();
  });
});

describe('policy and the cap', () => {
  it('draws strands and frames on Your map, strands only on Momentum and Timeline, nothing on By goal', () => {
    expect(strandPolicy('map')).toEqual({ strands: true, frames: true });
    expect(strandPolicy('momentum')).toEqual({ strands: true, frames: false });
    expect(strandPolicy('timeline')).toEqual({ strands: true, frames: false });
    expect(strandPolicy('goal')).toEqual({ strands: false, frames: false });
  });

  it('draws every strand up to the cap, and over it only the hot card\'s', () => {
    const few = Array.from({ length: ATLAS_STRAND_REST_CAP }, (_, i) => ({ from: 'goal:g', to: `project:${i}` }));
    expect(strandsToDraw(few, new Set())).toHaveLength(ATLAS_STRAND_REST_CAP);
    const many = [...few, { from: 'goal:h', to: 'project:x' }];
    expect(strandsToDraw(many, new Set())).toEqual([]);
    expect(strandsToDraw(many, new Set(['project:3']))).toEqual([{ from: 'goal:g', to: 'project:3' }]);
    expect(strandsToDraw(many, new Set(['goal:h']))).toEqual([{ from: 'goal:h', to: 'project:x' }]);
  });

  it('is hot from either end', () => {
    const l = { from: 'goal:g', to: 'project:p' };
    expect(isHotStrand(l, new Set(['goal:g']))).toBe(true);
    expect(isHotStrand(l, new Set(['project:p']))).toBe(true);
    expect(isHotStrand(l, new Set(['project:q']))).toBe(false);
  });
});
