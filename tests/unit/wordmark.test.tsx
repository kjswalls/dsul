import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

import { Wordmark } from '@/components/primitives/wordmark';
import {
  WORDMARK_CHARS,
  WORDMARK_CYCLE_KEY,
  WORDMARK_FLAVORS,
  WORDMARK_TEXT,
  readNextFlavorIndex,
  takeNextFlavor,
  unrollTimings,
} from '@/lib/wordmark-flavors';

/**
 * The wordmark spells out "do stuff unlimited" on hover, in the next flavor
 * of a fixed cycle, remembered per device; at rest it is always classic.
 */

describe('wordmark phrase', () => {
  it('rests on d, s, u and l, and spells the whole phrase open', () => {
    expect(
      WORDMARK_CHARS.filter((c) => c.initial)
        .map((c) => c.ch)
        .join(''),
    ).toBe('dsul');
    expect(
      WORDMARK_CHARS.map((c) => c.ch)
        .join('')
        .replace(/ /g, ' '),
    ).toBe(WORDMARK_TEXT);
  });

  it('numbers the growing letters left to right with no gaps', () => {
    const fills = WORDMARK_CHARS.filter((c) => !c.initial).map((c) => c.fillIndex);
    expect(fills).toEqual(fills.map((_, i) => i));
  });

  it('cycles twelve distinct flavors, classic first', () => {
    expect(WORDMARK_FLAVORS).toHaveLength(12);
    expect(new Set(WORDMARK_FLAVORS).size).toBe(12);
    expect(WORDMARK_FLAVORS[0]).toBe('classic');
  });
});

describe('unroll timings', () => {
  // The edge's position at time t, read back off the per-letter slices.
  const bezierY = (ease: string, u: number) => {
    const [, y1, , y2] = ease.match(/-?\d*\.?\d+/g)!.map(Number);
    // x handles at thirds make x(s) = s, so y is a plain cubic in u.
    return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3;
  };
  const edgeAt = (widths: number[], t: number, dir: 'in' | 'out') => {
    const total = widths.reduce((a, b) => a + b, 0);
    return unrollTimings(widths).reduce((sum, timing, i) => {
      const p = timing[dir];
      const u = p.duration === 0 ? (t >= p.delay ? 1 : 0) : Math.min(1, Math.max(0, (t - p.delay) / p.duration));
      return sum + (widths[i] / total) * bezierY(p.ease, u);
    }, 0);
  };
  const widths = [7.8, 3.2, 4.5, 7.8, 4.9, 4.9, 3.2, 7.8, 3.3, 11.6, 3.3, 4.5, 7.6, 8];

  it('covers the run once, left to right, with no gaps or overlaps', () => {
    const timings = unrollTimings(widths);
    expect(timings[0].in.delay).toBe(0);
    for (let i = 1; i < timings.length; i++) {
      const prev = timings[i - 1].in;
      expect(timings[i].in.delay).toBeCloseTo(prev.delay + prev.duration, 9);
    }
    const last = timings.at(-1)!.in;
    expect(last.delay + last.duration).toBeCloseTo(1, 9);
    // Closing starts at the far end and finishes on the first letter.
    expect(timings.at(-1)!.out.delay).toBe(0);
    expect(timings[0].out.delay + timings[0].out.duration).toBeCloseTo(1, 9);
  });

  it('moves the edge on one quadratic ease-out, opening and closing', () => {
    for (let t = 0; t <= 1; t += 0.05) {
      expect(edgeAt(widths, t, 'in')).toBeCloseTo(1 - (1 - t) ** 2, 3);
      expect(edgeAt(widths, t, 'out')).toBeCloseTo(1 - (1 - t) ** 2, 3);
    }
  });

  it('gives a wide letter more of the run than a narrow one', () => {
    const [i, m] = [1, 9].map((k) => unrollTimings(widths)[k].in.duration);
    expect(m).toBeGreaterThan(i);
  });

  it('splits evenly when nothing has been laid out', () => {
    const timings = unrollTimings([0, 0, 0, 0]);
    expect(timings).toHaveLength(4);
    const last = timings.at(-1)!.in;
    expect(last.delay + last.duration).toBeCloseTo(1, 9);
    for (const t of timings) expect(t.in.duration).toBeGreaterThan(0);
  });
});

describe('flavor cycle', () => {
  beforeEach(() => localStorage.clear());

  it('advances and wraps, persisting the next position', () => {
    const seen = WORDMARK_FLAVORS.map(() => takeNextFlavor());
    expect(seen).toEqual([...WORDMARK_FLAVORS]);
    expect(takeNextFlavor()).toBe('classic');
    expect(localStorage.getItem(WORDMARK_CYCLE_KEY)).toBe('1');
  });

  it('carries on where the stored position left off', () => {
    localStorage.setItem(WORDMARK_CYCLE_KEY, '4');
    expect(takeNextFlavor()).toBe(WORDMARK_FLAVORS[4]);
  });

  it('falls back to the start on a garbage value', () => {
    localStorage.setItem(WORDMARK_CYCLE_KEY, '99');
    expect(readNextFlavorIndex()).toBe(0);
    localStorage.setItem(WORDMARK_CYCLE_KEY, 'pixel');
    expect(readNextFlavorIndex()).toBe(0);
  });

  it('still advances within a visit when storage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const a = takeNextFlavor();
    const b = takeNextFlavor();
    expect(b).not.toBe(a);
    get.mockRestore();
    set.mockRestore();
  });
});

describe('<Wordmark />', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  const mark = () => screen.getByRole('img', { name: 'dsul, do stuff unlimited' });

  it('rests closed and classic', () => {
    render(<Wordmark />);
    expect(mark().dataset.flavor).toBe('classic');
    expect(mark().hasAttribute('data-open')).toBe(false);
  });

  it('opens in the next flavor on hover and returns to classic after', () => {
    localStorage.setItem(WORDMARK_CYCLE_KEY, '2');
    render(<Wordmark />);
    fireEvent.pointerEnter(mark(), { pointerType: 'mouse' });
    expect(mark().hasAttribute('data-open')).toBe(true);
    expect(mark().dataset.flavor).toBe(WORDMARK_FLAVORS[2]);

    fireEvent.pointerLeave(mark(), { pointerType: 'mouse' });
    expect(mark().hasAttribute('data-open')).toBe(false);
    act(() => vi.advanceTimersByTime(500));
    expect(mark().dataset.flavor).toBe('classic');

    fireEvent.pointerEnter(mark(), { pointerType: 'mouse' });
    expect(mark().dataset.flavor).toBe(WORDMARK_FLAVORS[3]);
  });

  it("ignores a pen contact's pointerenter and toggles on its tap", () => {
    render(<Wordmark />);
    fireEvent.pointerEnter(mark(), { pointerType: 'pen' });
    expect(mark().hasAttribute('data-open')).toBe(false);
    fireEvent.pointerDown(mark(), { pointerType: 'pen' });
    fireEvent.click(mark());
    expect(mark().hasAttribute('data-open')).toBe(true);
  });

  it('dresses the swap back to classic in a restore sweep, and only for a flavor', () => {
    localStorage.setItem(WORDMARK_CYCLE_KEY, '1');
    render(<Wordmark />);
    fireEvent.pointerEnter(mark(), { pointerType: 'mouse' });
    fireEvent.pointerLeave(mark(), { pointerType: 'mouse' });
    expect(mark().hasAttribute('data-restoring')).toBe(false);
    act(() => vi.advanceTimersByTime(500));
    expect(mark().dataset.flavor).toBe('classic');
    expect(mark().hasAttribute('data-restoring')).toBe(true);
    act(() => vi.advanceTimersByTime(800));
    expect(mark().hasAttribute('data-restoring')).toBe(false);

    localStorage.setItem(WORDMARK_CYCLE_KEY, '0');
    fireEvent.pointerEnter(mark(), { pointerType: 'mouse' });
    expect(mark().dataset.flavor).toBe('classic');
    fireEvent.pointerLeave(mark(), { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(500));
    expect(mark().hasAttribute('data-restoring')).toBe(false);
  });

  it('a hover during the sweep cancels it', () => {
    localStorage.setItem(WORDMARK_CYCLE_KEY, '1');
    render(<Wordmark />);
    fireEvent.pointerEnter(mark(), { pointerType: 'mouse' });
    fireEvent.pointerLeave(mark(), { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerEnter(mark(), { pointerType: 'mouse' });
    expect(mark().hasAttribute('data-restoring')).toBe(false);
    expect(mark().hasAttribute('data-open')).toBe(true);
  });

  it('toggles on tap', () => {
    render(<Wordmark />);
    fireEvent.pointerDown(mark(), { pointerType: 'touch' });
    fireEvent.click(mark());
    expect(mark().hasAttribute('data-open')).toBe(true);
    fireEvent.pointerDown(mark(), { pointerType: 'touch' });
    fireEvent.click(mark());
    expect(mark().hasAttribute('data-open')).toBe(false);
  });

  it('keeps the lime dot its own element, outside the letters', () => {
    const { container } = render(<Wordmark />);
    const dot = container.querySelector('.wordmark-dot');
    expect(dot).not.toBeNull();
    expect(dot!.closest('.wordmark-word')).toBeNull();
  });
});
