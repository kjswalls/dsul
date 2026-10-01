import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

/**
 * WeekScale re-measures on the planner's pending → settled edge.
 *
 * The control lives in the header and finds the week view's scroll viewport by
 * selector, in a layout effect keyed on scope/layout. Since ViewRouter shows a
 * skeleton until the load lands, the week views — and their ScrollArea — mount
 * only on that edge, AFTER the header. Keyed on layout alone, a cold load
 * straight into a week layout ran the effect against the skeleton, found
 * nothing, and never looked again: the readout sat on its fallback and the
 * step buttons stayed inert until the user changed layout.
 */

vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

/** jsdom has no ResizeObserver; this one records what it observes. */
const observed = new Set<Element>();
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(el: Element) {
      observed.add(el);
    }
    unobserve(el: Element) {
      observed.delete(el);
    }
    disconnect() {
      observed.clear();
    }
  }
);

import { WeekScale } from '@/components/canvas/week-scale';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';

afterEach(() => {
  cleanup();
  observed.clear();
  usePlannerStore.getState().clearStore();
});

describe('WeekScale on a cold load into a week layout', () => {
  it('measures the viewport the week view mounts once the planner settles', () => {
    useViewStore.setState({ scope: 'week', layout: 'schedule' });
    usePlannerStore.setState({ userId: 'u1', isLoading: true });

    const { container } = render(
      <div data-tour="timeline">
        <WeekScale />
      </div>
    );
    // The skeleton is up: no viewport, nothing measured.
    expect(screen.getByTestId('week-scale').dataset.measured).toBe('false');

    // The week view's ScrollArea arrives with the data. Appended in the SAME
    // act as the settle, the way ViewRouter's swap commits it.
    const viewport = document.createElement('div');
    viewport.setAttribute('data-slot', 'scroll-area-viewport');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 1200 });
    act(() => {
      container.querySelector('[data-tour="timeline"]')!.appendChild(viewport);
      usePlannerStore.setState({ isLoading: false });
    });

    expect(observed.has(viewport)).toBe(true);
    const scale = screen.getByTestId('week-scale');
    expect(scale.dataset.measured).toBe('true');
    expect(scale.dataset.colPx).not.toBe('');
  });
});
