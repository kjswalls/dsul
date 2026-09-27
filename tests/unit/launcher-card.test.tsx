import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * The ⌘K launcher renders as ONE card; the dock does not.
 *
 * One component renders both shells (components/sidebar/omnibar.tsx, `variant`).
 * Three affordances belong to the summoned card ONLY — a dark leading icon tile,
 * a lime "↵ verb" preview pill on each row, and a persistent footer bar — and the
 * whole point of the redesign is that the resting sidebar dock keeps none of them
 * (it is a pill on a real surface, not a floating card). This pins that split so a
 * later edit can't quietly leak the card chrome into the dock, or drop it from the
 * launcher.
 *
 * Asserted through `data-omnibar-variant`, the same handle the placeholder test and
 * the e2e helpers use. jsdom does not apply the Tailwind stylesheet, so the pill —
 * `hidden` until its row is cmdk-selected — is still in the DOM here; we assert its
 * PRESENCE (the launcher renders it) versus total ABSENCE in the dock (where the
 * helper returns null), not its computed visibility.
 */

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
// The omnibar's command context reaches for the router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { Omnibar } from '@/components/sidebar/omnibar';

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

afterEach(cleanup);

const scopeFor = (variant: 'dock' | 'launcher') =>
  document.querySelector(`[data-omnibar-variant="${variant}"]`) as HTMLElement;

describe('the ⌘K launcher renders as one card', () => {
  it('mounts the card-only affordances — tile, footer, and a preview pill — in the launcher', () => {
    // The launcher opens already focused with its resting panel showing, so the
    // Add / Ask rows (and their pills) are on screen without any interaction.
    render(<Omnibar variant="launcher" />);
    const scope = scopeFor('launcher');

    expect(scope.querySelector('[data-testid="omnibar-launcher-tile"]')).not.toBeNull();
    expect(scope.querySelector('[data-testid="omnibar-launcher-footer"]')).not.toBeNull();
    expect(
      scope.querySelectorAll('[data-testid="omnibar-enter-pill"]').length,
    ).toBeGreaterThan(0);
  });

  it('renders none of them in the dock, even once its panel is open', () => {
    // The dock's panel is closed at rest; focus opens it so its own Add / Ask rows
    // render. Even then the tile, footer, and pill must be absent — the helper
    // short-circuits to null off `variant`, and the tile/footer are isLauncher-gated.
    render(<Omnibar variant="dock" />);
    fireEvent.focus(screen.getByTestId('omnibar-input'));
    const scope = scopeFor('dock');

    // Sanity: the panel is actually open (the resting hint row is showing), so the
    // absence below is a real "not rendered", not "nothing rendered yet".
    expect(screen.getByText(/\? chat/)).toBeInTheDocument();

    expect(scope.querySelector('[data-testid="omnibar-launcher-tile"]')).toBeNull();
    expect(scope.querySelector('[data-testid="omnibar-launcher-footer"]')).toBeNull();
    expect(scope.querySelectorAll('[data-testid="omnibar-enter-pill"]').length).toBe(0);
  });
});
