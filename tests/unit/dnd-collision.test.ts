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

function run(rects: Record<string, ClientRect>, pointer: ClientRect) {
  const droppableRects = new Map<UniqueIdentifier, ClientRect>(Object.entries(rects));
  const droppableContainers = Object.keys(rects).map((id) => ({ id }) as unknown as DroppableContainer);
  return plannerCollision({
    active: {} as never,
    collisionRect: pointer,
    droppableRects,
    droppableContainers,
    pointerCoordinates: null,
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
