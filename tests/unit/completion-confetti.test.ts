import { afterEach, describe, expect, it } from 'vitest';

import { burstOrigin } from '@/lib/completion-confetti';

function mountRow(rect: Partial<DOMRect>): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-testid', 'undo-strip');
  const full = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, ...rect };
  row.getBoundingClientRect = () => ({ ...full, toJSON: () => full }) as DOMRect;
  document.body.appendChild(row);
  return row;
}

describe('burstOrigin', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the old spot when no activity row is showing', () => {
    expect(burstOrigin()).toEqual({ x: 0.5, y: 0.7 });
  });

  it('rises from the top centre of the activity row', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    mountRow({ left: 100, width: 200, right: 300, top: 600, height: 26, bottom: 626 });
    expect(burstOrigin()).toEqual({ x: 200 / w, y: 600 / h });
  });

  it('skips the dock that is not mounted in the visible shell', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    mountRow({}); // display:none — no box
    mountRow({ left: 0, width: 100, right: 100, top: 500, height: 26, bottom: 526 });
    expect(burstOrigin()).toEqual({ x: 50 / w, y: 500 / h });
  });

  it('falls back when the row is off-screen', () => {
    const h = window.innerHeight;
    mountRow({ left: 0, width: 100, right: 100, top: h + 10, height: 26, bottom: h + 36 });
    expect(burstOrigin()).toEqual({ x: 0.5, y: 0.7 });
  });
});
