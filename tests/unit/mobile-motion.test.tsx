import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * Phase 4 of the mobile redesign: the one place the radial relay is struck on a
 * phone, and the two surfaces that stopped naming a colour they could not know.
 *
 * The relay is a canvas, so none of what it draws is assertable here. What IS
 * assertable — and what a later change would break silently — is everything
 * around the draw: that the field is mounted in the PILL rather than as the
 * desktop halo, that it rests dark and is lit by one event only, that the event
 * is an item actually filing itself, that the window shuts again, and that the
 * whole thing is absent when the user has asked for reduced motion. RelayField
 * is stubbed to a div carrying its props so all five are readable.
 *
 * The desktop assertions in here are the load-bearing ones: Omnibar is the
 * sidebar dock's bar as well as the phone's, and `captureRelay` defaulting the
 * wrong way would put new motion on a surface the spec deliberately left alone.
 */

vi.mock('@/components/primitives/relay-field', () => ({
  RelayField: (props: {
    className?: string;
    active?: boolean;
    burst?: number;
    idleIntensity?: number;
  }) => (
    <div
      data-testid="relay-field"
      data-place={props.className ?? ''}
      data-active={String(props.active ?? false)}
      data-burst={String(props.burst ?? 0)}
      data-idle={String(props.idleIntensity ?? '')}
    />
  ),
}));

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { Omnibar } from '@/components/sidebar/omnibar';
import { ModeSwitcherSheet } from '@/components/mobile/mode-switcher-sheet';
import { SwipeRow } from '@/components/mobile/swipe-row';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let addTask: ReturnType<typeof vi.fn>;

beforeEach(() => {
  addTask = vi.fn();
  // Signed in and loaded: a capture before landing is now held, not added (lib/held-captures.ts).
  usePlannerStore.setState({ addTask, animationsEnabled: true, userId: 'u1', isLoading: false, error: null });
  useMobileNavStore.setState({ activeTab: 'today' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const field = () => screen.queryByTestId('relay-field');
const input = () => screen.getByTestId('omnibar-input');

/** Type a quick-add and commit it, the way a thumb does. */
function capture(text = '+milk') {
  fireEvent.focus(input());
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: 'Enter' });
}

describe('the capture relay in the phone’s command bar', () => {
  it('sits inside the pill, where the desktop field is a halo around it', () => {
    render(<Omnibar captureRelay />);
    // inset-0 + a negative z: the field is clipped to the bar and paints over
    // the bar's own fill. The desktop halo is -inset-3 and sits OUTSIDE, on the
    // dock capsule — a placement with nothing to show for it on a phone, where
    // the well's 10px of padding is all that is left uncovered.
    expect(field()).toHaveAttribute('data-place', expect.stringContaining('inset-0'));
    expect(field()).toHaveAttribute('data-place', expect.stringContaining('-z-10'));

    cleanup();
    render(<Omnibar />);
    expect(field()).toHaveAttribute('data-place', expect.stringContaining('-inset-3'));
  });

  it('rests dark, and is lit only by an item filing itself', () => {
    vi.useFakeTimers();
    render(<Omnibar captureRelay />);

    // Nothing ambient: the resting field is at zero intensity and unstruck, so
    // between captures the bar is a flat pill. This is the assertion the spec's
    // "no always-on motion" turns into.
    expect(field()).toHaveAttribute('data-idle', '0');
    expect(field()).toHaveAttribute('data-active', 'false');
    expect(field()).toHaveAttribute('data-burst', '0');

    act(() => capture());

    expect(addTask).toHaveBeenCalledWith({ title: 'milk' });
    // Both halves: the token re-strikes the ripple from the middle of the bar,
    // the window is what it is bright enough to be seen in.
    expect(field()).toHaveAttribute('data-burst', '1');
    expect(field()).toHaveAttribute('data-active', 'true');

    act(() => void vi.advanceTimersByTime(1000));
    // Shut again, and the token holds its value — a burst is a change, not a
    // level, so resetting it would strike the field a second time.
    expect(field()).toHaveAttribute('data-active', 'false');
    expect(field()).toHaveAttribute('data-burst', '1');
  });

  it('strikes nothing when the bar had nothing to file', () => {
    render(<Omnibar captureRelay />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '+' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

    // An empty quick-add opens the add dialog instead. Nothing has been filed
    // yet — the decision is still in front of the user — so there is nothing for
    // the relay to answer.
    expect(addTask).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeDialog?.type).toBe('add');
    expect(field()).toHaveAttribute('data-burst', '0');
  });

  it('is absent entirely when the user has asked for reduced motion', () => {
    usePlannerStore.setState({ animationsEnabled: false });
    render(<Omnibar captureRelay />);

    // Not "mounted but still" — unmounted. `[data-reduce-motion]` reaches CSS
    // animations and transitions only, and this is a canvas driving its own RAF
    // loop, so the setting has to be honoured by not mounting it. Capturing
    // still works; it just does so quietly.
    expect(field()).toBeNull();
    act(() => capture());
    expect(addTask).toHaveBeenCalledWith({ title: 'milk' });
    expect(field()).toBeNull();
  });

  it('leaves the desktop bar exactly as it was', () => {
    render(<Omnibar />);
    act(() => capture());

    // The desktop dock already carries an ambient field of its own behind this
    // pill, and the spec earns the relay on the phone. A default that reached
    // desktop would be new motion on a surface nobody asked to change.
    //
    // The halo is lit here, and that is the UNCHANGED behaviour: it has always
    // brightened for as long as the input holds focus, which the caret still
    // does after a quick-add. What must stay absent is the strike.
    expect(addTask).toHaveBeenCalledWith({ title: 'milk' });
    expect(field()).toHaveAttribute('data-burst', '0');
    expect(field()).toHaveAttribute('data-place', expect.stringContaining('-inset-3'));
  });
});

describe('the switcher sheet in dark mode', () => {
  it('marks the current surface with the latched-selection wash, not the well', async () => {
    render(<ModeSwitcherSheet />);
    fireEvent.click(screen.getByTestId('mobile-mode-card'));

    const current = await screen.findByTestId('mode-option-today');
    // bg-surface-3 on the sheet's --modal ground is 0.945-on-0.996 in light and
    // 0.245-on-0.21 in dark — and dark's hover wash (white 6%) is a bigger step
    // than that, so the row you were passing over read stronger than the row you
    // were on. --row-selected is the token whose whole job is sitting a notch
    // above the hover in both themes.
    expect(current.className).toContain('var(--row-selected)');
    expect(current.className).not.toContain('bg-surface-3');
    expect(screen.getByTestId('mode-option-braindump').className).toContain('hover-wash');
  });
});

describe('a swiped row', () => {
  it('names no ground, so it reads the paper and a bucket card alike', () => {
    render(
      <SwipeRow onComplete={() => {}} onSchedule={() => {}} onDelete={() => {}}>
        <span>Water the plants</span>
      </SwipeRow>
    );

    // The face used to be painted `bg-canvas` so it could hide the action tray
    // at rest. On the paper that is correct and on a bucket card it is not — a
    // 0.004 mismatch in light, 0.105 in dark, which is a visible dark strip
    // dragged behind every swiped row on Buckets. The tray is clipped to the
    // strip the row has vacated now, so the face has nothing to hide and needs
    // no fill of its own.
    const face = screen.getByText('Water the plants').parentElement!;
    expect(face.className).not.toMatch(/\bbg-/);

    // Clipped to nothing at rest — the buttons are in the DOM but occupy no
    // width, which is what replaces the cover the opaque face used to be.
    const tray = document.querySelector('[aria-label="Delete"]')!.parentElement as HTMLElement;
    expect(tray.style.width).toBe('0px');
    expect(tray.className).toContain('overflow-hidden');
  });
});
