import { afterEach, describe, expect, it } from 'vitest';
import type { ClientRect, DroppableContainer, UniqueIdentifier } from '@dnd-kit/core';
import { plannerCollision } from '@/lib/dnd/collision';

/**
 * Week × Schedule pins each column's header and Anytime strip over the hour
 * grid. The cells that scroll under a head stay live droppables at their real
 * rects, and one of them is nearly always nearer the pointer than the strip's
 * centre — so without the filter a drop aimed at Anytime lands on an hour
 * nobody could see.
 */

const rect = (top: number, height: number, left = 0, width = 140): ClientRect => ({
  top,
  left,
  width,
  height,
  bottom: top + height,
  right: left + width,
});

function run(
  rects: Record<string, ClientRect>,
  pointer: ClientRect,
  pointerCoordinates: { x: number; y: number } | null = null
) {
  const droppableRects = new Map<UniqueIdentifier, ClientRect>(Object.entries(rects));
  const droppableContainers = Object.keys(rects).map((id) => ({ id }) as unknown as DroppableContainer);
  return plannerCollision({
    active: {} as never,
    collisionRect: pointer,
    droppableRects,
    droppableContainers,
    pointerCoordinates,
  }).map((c) => c.id);
}

function pinHead(r: ClientRect) {
  const el = document.createElement('div');
  el.setAttribute('data-week-head', '');
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, toJSON: () => r }) as DOMRect;
  document.body.appendChild(el);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('plannerCollision', () => {
  // The strip spans 60–220; the grid has scrolled so 9h and 10h sit under it.
  const rects = {
    'week:2026-09-24:anytime': rect(60, 160),
    'weekhour:2026-09-24:9': rect(150, 40),
    'weekhour:2026-09-24:10': rect(190, 40),
    'weekhour:2026-09-24:11': rect(240, 40),
  };
  // Aimed at the strip, just off its centre, right on top of the hidden 9h.
  const pointer = rect(165, 10, 65, 10);

  it('is plain closestCenter off the week view', () => {
    expect(run(rects, pointer)[0]).toBe('weekhour:2026-09-24:9');
  });

  it('drops hour cells hidden under a pinned head, so the strip wins', () => {
    pinHead(rect(0, 236));
    const ids = run(rects, pointer);
    expect(ids[0]).toBe('week:2026-09-24:anytime');
    expect(ids).not.toContain('weekhour:2026-09-24:9');
    expect(ids).not.toContain('weekhour:2026-09-24:10');
    expect(ids).toContain('weekhour:2026-09-24:11');
  });
});

describe('plannerCollision — list days', () => {
  // Week × List: a short Sunday over a tall Monday. The pointer is in the top
  // of Monday, which is nearer Sunday's centre than Monday's.
  const rects = {
    'list:2026-09-27': rect(0, 60),
    'list:2026-09-28': rect(80, 600),
    sidebar: rect(0, 800, -300, 280),
  };
  const ghost = rect(95, 30, 20, 100);

  it('takes the list day the pointer is inside, not the nearest centre', () => {
    expect(run(rects, ghost)[0]).toBe('list:2026-09-27');
    expect(run(rects, ghost, { x: 60, y: 100 })).toEqual(['list:2026-09-28']);
  });

  it('falls through to closestCenter outside every list day', () => {
    expect(run(rects, rect(300, 30, -250, 100), { x: -200, y: 310 })[0]).toBe('sidebar');
  });
});

describe('plannerCollision: Atlas cards (PR4)', () => {
  // The board spans x 0 to 1000; the braindump sits to its left.
  const A = 'atlas:project:11111111-1111-4111-8111-111111111111';
  const B = 'atlas:routine:22222222-2222-4222-8222-222222222222';
  const OFF = 'atlas:goal:33333333-3333-4333-8333-333333333333';
  const rects = {
    sidebar: rect(0, 800, -300, 280),
    [A]: rect(100, 160, 100, 260),
    [B]: rect(100, 160, 500, 260),
    // Panned off the board's right edge.
    [OFF]: rect(100, 160, 1100, 260),
  };
  const at = (x: number, y: number) => rect(y - 5, 10, x - 5, 10);

  function board(r: ClientRect = rect(0, 800, 0, 1000)) {
    const el = document.createElement('div');
    el.setAttribute('data-atlas-root', '');
    el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, toJSON: () => r }) as DOMRect;
    document.body.appendChild(el);
  }

  it('the card under the pointer wins, however near another centre is', () => {
    board();
    // Inside A's right edge, nearer B's centre than A's.
    expect(run(rects, at(355, 110), { x: 355, y: 110 })).toEqual([A]);
  });

  it('between cards on the board there is no target, never the nearest card or the braindump', () => {
    board();
    expect(run(rects, at(430, 180), { x: 430, y: 180 })).toEqual([]);
  });

  it('a card off the board is skipped', () => {
    board();
    // The pointer is past the board's edge, over the off-screen card's rect.
    const ids = run(rects, at(1200, 180), { x: 1200, y: 180 });
    expect(ids).not.toContain(OFF);
  });

  it('off the board the braindump still wins, and no card is offered by centre', () => {
    board();
    const ids = run(rects, at(-200, 180), { x: -200, y: 180 });
    expect(ids[0]).toBe('sidebar');
    expect(ids.some((id) => String(id).startsWith('atlas:'))).toBe(false);
  });

  it('with no Atlas on screen, atlas ids never answer by centre', () => {
    const ids = run(rects, at(-200, 180), { x: -200, y: 180 });
    expect(ids).toEqual(['sidebar']);
  });
});
