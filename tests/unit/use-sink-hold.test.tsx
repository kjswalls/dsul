import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { sinkCompleted, type SortableRow } from '@/lib/sort-rows';
import { SINK_HOLD_MS, useSinkHold } from '@/hooks/use-sink-hold';
import type { Task } from '@/lib/planner-types';
import { useDragStore } from '@/lib/drag-store';
import { bumpSettleEpoch } from '@/lib/settle-epoch';

/**
 * A tick used to move the row to the foot of its group in the same frame the
 * checkbox filled. The hold keeps it in place until the list has been still for
 * SINK_HOLD_MS, then lets every pending row go at once.
 */

const task = (id: string, done = false): SortableRow => ({
  itemType: 'task',
  item: { type: 'task', id, title: id, status: done ? 'completed' : 'pending', order: 0 } as unknown as Task,
});

function List({ rows }: { rows: SortableRow[] }) {
  const { completedAs, rootRef } = useSinkHold();
  return (
    <div ref={rootRef}>
      {sinkCompleted(rows, '2026-09-25', completedAs).map((r) => (
        <div key={r.item.id} data-item-id={r.item.id} data-done={r.item.status === 'completed'}>
          {r.item.id}
        </div>
      ))}
    </div>
  );
}

const order = (c: HTMLElement) => [...c.querySelectorAll('[data-item-id]')].map((el) => el.textContent);

/**
 * jsdom has no animate() and no layout: a spy for the one, and each row placed
 * by its index in the DOM for the other. Returns the spy and its undo.
 */
function fakeMotion() {
  const animate = vi.fn();
  const proto = HTMLElement.prototype as unknown as { animate?: unknown };
  const original = proto.animate;
  proto.animate = animate;
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const i = [...(this.parentElement?.children ?? [])].indexOf(this);
      return { top: i * 40 } as DOMRect;
    });
  return {
    animate,
    restore: () => {
      rect.mockRestore();
      proto.animate = original;
    },
  };
}

describe('useSinkHold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sinks rows that arrive already finished, with no hold', () => {
    const { container } = render(<List rows={[task('a', true), task('b'), task('c')]} />);
    expect(order(container)).toEqual(['b', 'c', 'a']);
  });

  it('keeps a just-ticked row in place, then sinks it after the hold', () => {
    const { container, rerender } = render(<List rows={[task('a'), task('b'), task('c')]} />);
    rerender(<List rows={[task('a', true), task('b'), task('c')]} />);
    // The row's own state is live — only its position waits.
    expect(order(container)).toEqual(['a', 'b', 'c']);
    expect(container.querySelector('[data-item-id="a"]')?.getAttribute('data-done')).toBe('true');

    act(() => vi.advanceTimersByTime(SINK_HOLD_MS - 1));
    expect(order(container)).toEqual(['a', 'b', 'c']);
    act(() => vi.advanceTimersByTime(1));
    expect(order(container)).toEqual(['b', 'c', 'a']);
  });

  it('holds an unticked row at the foot the same way before lifting it', () => {
    const { container, rerender } = render(<List rows={[task('a', true), task('b')]} />);
    expect(order(container)).toEqual(['b', 'a']);
    rerender(<List rows={[task('a'), task('b')]} />);
    expect(order(container)).toEqual(['b', 'a']);
    act(() => vi.advanceTimersByTime(SINK_HOLD_MS));
    expect(order(container)).toEqual(['a', 'b']);
  });

  it('debounces: a second tick restarts the hold and both rows move together', () => {
    const { container, rerender } = render(<List rows={[task('a'), task('b'), task('c')]} />);
    rerender(<List rows={[task('a', true), task('b'), task('c')]} />);
    act(() => vi.advanceTimersByTime(SINK_HOLD_MS - 100));
    rerender(<List rows={[task('a', true), task('b', true), task('c')]} />);
    act(() => vi.advanceTimersByTime(SINK_HOLD_MS - 1));
    expect(order(container)).toEqual(['a', 'b', 'c']);
    act(() => vi.advanceTimersByTime(1));
    expect(order(container)).toEqual(['c', 'a', 'b']);
  });

  it('an unrelated re-render during the hold does not extend it', () => {
    const { container, rerender } = render(<List rows={[task('a'), task('b')]} />);
    rerender(<List rows={[task('a', true), task('b')]} />);
    act(() => vi.advanceTimersByTime(SINK_HOLD_MS - 100));
    rerender(<List rows={[task('a', true), task('b')]} />);
    act(() => vi.advanceTimersByTime(100));
    expect(order(container)).toEqual(['b', 'a']);
  });

  it('unticking inside the hold cancels it; nothing ever moves', () => {
    const { container, rerender } = render(<List rows={[task('a'), task('b')]} />);
    rerender(<List rows={[task('a', true), task('b')]} />);
    rerender(<List rows={[task('a'), task('b')]} />);
    act(() => vi.advanceTimersByTime(SINK_HOLD_MS * 2));
    expect(order(container)).toEqual(['a', 'b']);
  });

  it('a row that changed while not drawn comes back already in place', () => {
    const { container, rerender } = render(<List rows={[task('a'), task('b')]} />);
    // 'a' leaves (another date, a filter), is finished elsewhere, then returns.
    rerender(<List rows={[task('b')]} />);
    rerender(<List rows={[task('a', true), task('b')]} />);
    expect(order(container)).toEqual(['b', 'a']);
  });

  it('waits for a drag to end before moving anything', () => {
    const { container, rerender } = render(<List rows={[task('a'), task('b')]} />);
    act(() => useDragStore.setState({ activeId: 'x' }));
    rerender(<List rows={[task('a', true), task('b')]} />);
    act(() => vi.advanceTimersByTime(SINK_HOLD_MS * 3));
    expect(order(container)).toEqual(['a', 'b']);
    act(() => useDragStore.setState({ activeId: null }));
    act(() => vi.advanceTimersByTime(SINK_HOLD_MS));
    expect(order(container)).toEqual(['b', 'a']);
  });

  it('slides moved rows from their old place when the hold lets go', () => {
    const { animate, restore } = fakeMotion();
    try {
      const { rerender } = render(<List rows={[task('a'), task('b')]} />);
      rerender(<List rows={[task('a', true), task('b')]} />);
      expect(animate).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(SINK_HOLD_MS));
      // a: 0 → 40, b: 40 → 0; each starts from where it was.
      const offsets = animate.mock.calls.map((c) => c[0][0].transform).sort();
      expect(offsets).toEqual(['translateY(-40px)', 'translateY(40px)']);
    } finally {
      restore();
    }
  });

  it("keeps the hold but drops the slide under dsul's own animations toggle", () => {
    // The OS query alone missed this: data-reduce-motion is the in-app switch
    // (stamped by supabase-provider), and the CSS clamp never reaches animate().
    const { animate, restore } = fakeMotion();
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    try {
      const { container, rerender } = render(<List rows={[task('a'), task('b')]} />);
      rerender(<List rows={[task('a', true), task('b')]} />);
      // A pause, not motion: the hold stays.
      act(() => vi.advanceTimersByTime(SINK_HOLD_MS - 1));
      expect(order(container)).toEqual(['a', 'b']);
      act(() => vi.advanceTimersByTime(1));
      expect(order(container)).toEqual(['b', 'a']);
      expect(animate).not.toHaveBeenCalled();
    } finally {
      document.documentElement.removeAttribute('data-reduce-motion');
      restore();
    }
  });

  describe('the cached → fresh landing (the settle epoch)', () => {
    it('adopts a completion that changed on the landing with no hold and no slide', () => {
      // The preview drew 'a' open; the fresh load says it was finished on
      // another device. The settle conductor moves it once — this hook must
      // not hold it in place and then slide it a second time.
      const { animate, restore } = fakeMotion();
      try {
        const { container, rerender } = render(<List rows={[task('a'), task('b')]} />);
        bumpSettleEpoch(); // inside the landing set(), before React commits
        rerender(<List rows={[task('a', true), task('b')]} />);
        expect(order(container)).toEqual(['b', 'a']);
        act(() => vi.advanceTimersByTime(SINK_HOLD_MS * 2));
        expect(order(container)).toEqual(['b', 'a']);
        expect(animate).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('drops a hold already armed when the landing lands, rather than firing it', () => {
      const { animate, restore } = fakeMotion();
      try {
        const { container, rerender } = render(<List rows={[task('a'), task('b'), task('c')]} />);
        rerender(<List rows={[task('a', true), task('b'), task('c')]} />);
        act(() => vi.advanceTimersByTime(SINK_HOLD_MS - 100));
        bumpSettleEpoch();
        rerender(<List rows={[task('a', true), task('b'), task('c', true)]} />);
        expect(order(container)).toEqual(['b', 'a', 'c']);
        act(() => vi.advanceTimersByTime(SINK_HOLD_MS * 2));
        expect(order(container)).toEqual(['b', 'a', 'c']);
        expect(animate).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('adopts once: the first tick after the landing holds and slides as usual', () => {
      const { animate, restore } = fakeMotion();
      try {
        const { container, rerender } = render(<List rows={[task('a'), task('b')]} />);
        bumpSettleEpoch();
        rerender(<List rows={[task('a'), task('b')]} />);
        rerender(<List rows={[task('a', true), task('b')]} />);
        expect(order(container)).toEqual(['a', 'b']);
        act(() => vi.advanceTimersByTime(SINK_HOLD_MS));
        expect(order(container)).toEqual(['b', 'a']);
        expect(animate).toHaveBeenCalledTimes(2);
      } finally {
        restore();
      }
    });

    it('a list mounted after the landing takes the current epoch, and holds its first tick', () => {
      bumpSettleEpoch();
      const { container, rerender } = render(<List rows={[task('a'), task('b')]} />);
      rerender(<List rows={[task('a', true), task('b')]} />);
      expect(order(container)).toEqual(['a', 'b']);
      act(() => vi.advanceTimersByTime(SINK_HOLD_MS));
      expect(order(container)).toEqual(['b', 'a']);
    });
  });
});
