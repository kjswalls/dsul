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
