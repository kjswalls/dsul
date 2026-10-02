import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The extensions store (the body of Settings → Extensions) and the copy,
 * previews and adoption figures behind it.
 *
 * Four claims, each one a way the store could quietly lie:
 *   1. Every catalog extension reaches the store whole — copy, shelf, preview.
 *      Off is inert, not hidden, so a missing card is a missing extension.
 *   2. A card says the same state word as the settings index, through the one
 *      shared rule, and never holds a switch.
 *   3. Adoption figures never rest on too few people, and a default-on
 *      extension is counted the way the app resolves it.
 *   4. Previews do not move unless they may.
 */

const replace = vi.fn();
let params = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/extensions',
  useSearchParams: () => params,
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: () => {} }) }));

import {
  EXT_ACCOUNTABILITY_PARTNER,
  EXT_BEEMINDER,
  EXT_ORGANIZE,
  EXT_PHONE_CALL,
  EXT_SMS_NUDGE,
  EXT_STREAKS,
  OFFICIAL_EXTENSIONS,
} from '@/lib/extension-registry';
import { EXTENSION_SETTINGS } from '@/lib/extension-settings';
import { FEATURED_SLUG, STORE_SHELVES, catalogByShelf, costLabel } from '@/lib/extension-catalog';
import { MIN_PEOPLE, adoptionLine, computeAdoption, type AdoptionCounts } from '@/lib/extension-adoption';
import { EXTENSION_PREVIEWS, ExtensionPreview } from '@/components/extensions/previews/extension-preview';
import { ExtensionBrowse } from '@/components/extensions/extension-browse';
import { StoreCard } from '@/components/extensions/store-card';
import { extensionStateForSlug } from '@/lib/settings/extension-state';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useReminderStore } from '@/lib/reminder-store';
import { useExtensionAdoptionStore } from '@/lib/extension-adoption-store';
import { STATIC_COMMANDS } from '@/lib/commands/registry';
import { routeNeedsItems } from '@/lib/route-data';

const slugs = OFFICIAL_EXTENSIONS.map((extension) => extension.slug);

describe('every extension reaches the store whole', () => {
  it('has a tagline, a real shelf, one to three lines of change and a maker’s note', () => {
    const shelves = new Set(STORE_SHELVES.map((shelf) => shelf.id));
    for (const extension of OFFICIAL_EXTENSIONS) {
      expect(extension.tagline.trim(), extension.slug).not.toBe('');
      expect(shelves.has(extension.shelf), extension.slug).toBe(true);
      expect(extension.whatChanges.length, extension.slug).toBeGreaterThanOrEqual(1);
      expect(extension.whatChanges.length, extension.slug).toBeLessThanOrEqual(3);
      expect(extension.makerNote.trim().length, extension.slug).toBeGreaterThan(20);
    }
  });

  it('has exactly one preview per extension, and nothing extra', () => {
    expect(Object.keys(EXTENSION_PREVIEWS).sort()).toEqual([...slugs].sort());
  });

  it('puts every extension on exactly one shelf, with no empty shelf', () => {
    const grouped = catalogByShelf();
    expect(grouped.map((group) => group.shelf.id)).toEqual(STORE_SHELVES.map((shelf) => shelf.id));
    expect(grouped.flatMap((group) => group.extensions.map((e) => e.slug)).sort()).toEqual([...slugs].sort());
  });

  it('features a real extension', () => {
    expect(slugs).toContain(FEATURED_SLUG);
  });

  it('says what an extension needs whenever it holds a credential or reports to someone', () => {
    for (const spec of EXTENSION_SETTINGS) {
      const manifest = OFFICIAL_EXTENSIONS.find((extension) => extension.slug === spec.slug)!;
      if (spec.secrets.length > 0 || spec.slug === EXT_ACCOUNTABILITY_PARTNER) {
        expect(manifest.needs?.length, spec.slug).toBeGreaterThan(0);
      }
    }
  });

  it('flags every extension that can cost money, and why', () => {
    const costly = OFFICIAL_EXTENSIONS.filter((extension) => costLabel(extension)).map((e) => e.slug);
    expect(costly.sort()).toEqual([EXT_BEEMINDER, EXT_PHONE_CALL, EXT_SMS_NUDGE].sort());
    expect(OFFICIAL_EXTENSIONS.find((e) => e.slug === EXT_BEEMINDER)!.costs).toBe('stake');
  });
});

describe('adoption figures', () => {
  const row = (slug: string, partial: Partial<AdoptionCounts>): AdoptionCounts => ({
    slug,
    users_total: 100,
    rows_on: 0,
    rows_off: 0,
    tried_30d: 0,
    kept_30d: 0,
    ...partial,
  });

  it('withholds everything below the minimum number of people', () => {
    const stats = computeAdoption([row(EXT_BEEMINDER, { users_total: MIN_PEOPLE - 1, rows_on: 8 })]);
    expect(stats[EXT_BEEMINDER]).toEqual({ hasItOn: null, keptOn30d: null });
  });

  it('withholds a share that would single out a handful of people', () => {
    const stats = computeAdoption([row(EXT_BEEMINDER, { rows_on: 3 })]);
    expect(stats[EXT_BEEMINDER].hasItOn).toBeNull();
  });

  it('counts accounts with no saved row as ON for a default-on extension', () => {
    // 100 people, 10 switched Streaks off, nobody else touched it: 90% have it.
    const stats = computeAdoption([row(EXT_STREAKS, { rows_off: 10 })]);
    expect(stats[EXT_STREAKS].hasItOn).toBe(0.9);
    // …and a slug with no row at all is still resolved off the default.
    expect(computeAdoption([row(EXT_BEEMINDER, {})])[EXT_ORGANIZE].hasItOn).toBeNull();
  });

  it('never claims a kept-on rate for a default-on extension', () => {
    const stats = computeAdoption([row(EXT_ORGANIZE, { tried_30d: 50, kept_30d: 40 })]);
    expect(stats[EXT_ORGANIZE].keptOn30d).toBeNull();
  });

  it('rounds the kept-on rate to the nearest 5% and prefers it in the line', () => {
    const stats = computeAdoption([row(EXT_BEEMINDER, { rows_on: 30, tried_30d: 40, kept_30d: 33 })]);
    expect(stats[EXT_BEEMINDER].keptOn30d).toBe(0.85);
    expect(adoptionLine(stats[EXT_BEEMINDER])).toBe('85% kept it on after 30 days');
    expect(adoptionLine({ hasItOn: 0.25, keptOn30d: null })).toBe('On for 25% of people');
    expect(adoptionLine({ hasItOn: null, keptOn30d: null })).toBeNull();
  });
});

describe('the store', () => {
  beforeEach(() => {
    usePlannerStore.setState({ userId: 'test-user' });
    useMorningStore.setState({ settingsHydratedUserId: 'test-user' });
    useExtensionsStore.setState({ available: true, configsLoaded: true, enabled: {}, configs: {} });
    useReminderStore.setState({ remindersEnabled: false, stakesEnabled: false });
    // No network in the store's figures: they are decoration, and "ready with
    // nothing to say" is exactly what a pre-launch store shows.
    useExtensionAdoptionStore.setState({ status: 'ready', stats: {} });
  });
  afterEach(() => {
    cleanup();
    useExtensionsStore.getState().reset();
  });

  const ctx = { theme: 'system', setTheme: () => {}, userId: 'test-user' };

  it('draws one card per extension, each linking to its own settings pane', () => {
    render(<ExtensionBrowse ctx={ctx} />);
    for (const slug of slugs) {
      const card = document.querySelector(`[data-store-card="${slug}"]`);
      expect(card, slug).toBeTruthy();
      // ?from=browse is what puts "Back to Browse" at the top of the pane.
      expect(card!.getAttribute('href')).toBe(`/settings/extensions/${slug}?from=browse`);
    }
  });

  it('says the same state word as the shared rule, and holds no switch', () => {
    useExtensionsStore.setState({ enabled: { [EXT_BEEMINDER]: true } });
    render(<ExtensionBrowse ctx={ctx} />);
    for (const slug of slugs) {
      const card = document.querySelector<HTMLElement>(`[data-store-card="${slug}"]`)!;
      expect(card.dataset.extensionState, slug).toBe(extensionStateForSlug(slug, ctx).label);
      expect(within(card).queryByRole('switch')).toBeNull();
    }
    // Beeminder is on but its master switch is off: the card must not say On.
    const beeminder = document.querySelector<HTMLElement>(`[data-store-card="${EXT_BEEMINDER}"]`)!;
    expect(beeminder.dataset.extensionState).toBe('Unavailable');
    expect(beeminder.textContent).toContain('Settle the day');
  });

  it('filters by shelf through the URL, and the featured slot shows only under All', () => {
    params = new URLSearchParams();
    const { rerender } = render(<ExtensionBrowse ctx={ctx} />);
    expect(document.querySelector(`[data-store-featured="${FEATURED_SLUG}"]`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Put something on the line' }));
    expect(replace).toHaveBeenCalledWith('/settings/extensions?shelf=stakes', { scroll: false });

    params = new URLSearchParams('shelf=stakes');
    rerender(<ExtensionBrowse ctx={ctx} />);
    expect(document.querySelectorAll('[data-store-shelf]')).toHaveLength(1);
    expect(document.querySelector('[data-store-shelf="stakes"]')).toBeTruthy();
    expect(document.querySelector('[data-store-featured]')).toBeNull();
    // The shelf rides along to the pane, so "Back to Browse" can return to it.
    const card = document.querySelector(`[data-store-card="${EXT_BEEMINDER}"]`)!;
    expect(card.getAttribute('href')).toBe(`/settings/extensions/${EXT_BEEMINDER}?from=browse&shelf=stakes`);
    params = new URLSearchParams();
  });

  it('says so when nothing is switched on', () => {
    useExtensionsStore.setState({
      available: true,
      configsLoaded: true,
      configs: {},
      // Explicitly off, default-on extensions included.
      enabled: Object.fromEntries(slugs.map((slug) => [slug, false])),
    });
    params = new URLSearchParams('shelf=on');
    render(<ExtensionBrowse ctx={ctx} />);
    expect(screen.getByRole('button', { name: 'On · 0' })).toBeTruthy();
    expect(screen.getByText('Nothing is switched on yet.')).toBeTruthy();
    expect(document.querySelector('[data-store-card]')).toBeNull();
    params = new URLSearchParams();
  });
});

describe('previews', () => {
  afterEach(cleanup);

  it('rest on a still frame when they cannot tell they are on screen', () => {
    // jsdom has no IntersectionObserver: the honest answer is "not playing".
    render(<ExtensionPreview slug={EXT_STREAKS} />);
    const preview = document.querySelector<HTMLElement>(`[data-extension-preview="${EXT_STREAKS}"]`)!;
    expect(preview.dataset.playing).toBe('false');
    expect(preview.getAttribute('role')).toBe('img');
    expect(preview.getAttribute('aria-label')).toMatch(/^Preview: /);
  });

  it('do not play under the app’s own reduced-motion setting, even on screen', () => {
    const observed: Array<(entries: { isIntersecting: boolean }[]) => void> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          observed.push(cb);
        }
        observe() {
          observed.forEach((cb) => cb([{ isIntersecting: true }]));
        }
        disconnect() {}
      }
    );
    document.documentElement.setAttribute('data-reduce-motion', 'true');
    try {
      render(<ExtensionPreview slug={EXT_STREAKS} />);
      const preview = document.querySelector<HTMLElement>(`[data-extension-preview="${EXT_STREAKS}"]`)!;
      expect(preview.dataset.playing).toBe('false');
    } finally {
      document.documentElement.removeAttribute('data-reduce-motion');
      vi.unstubAllGlobals();
    }
  });
});

describe('store cards play only when engaged', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('rest until the card is hovered or focused, and stop when it is left', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        cb: (entries: { isIntersecting: boolean }[]) => void;
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          this.cb = cb;
        }
        observe() {
          this.cb([{ isIntersecting: true }]);
        }
        disconnect() {}
      }
    );
    const extension = OFFICIAL_EXTENSIONS.find((e) => e.slug === EXT_STREAKS)!;
    render(<StoreCard extension={extension} state={{ label: 'Off', on: false }} adoption={null} />);
    const card = document.querySelector<HTMLElement>(`[data-store-card="${EXT_STREAKS}"]`)!;
    const preview = card.querySelector<HTMLElement>('[data-extension-preview]')!;
    expect(preview.dataset.playing).toBe('false');

    fireEvent.pointerEnter(card);
    expect(preview.dataset.playing).toBe('true');
    fireEvent.pointerLeave(card);
    expect(preview.dataset.playing).toBe('false');

    // Keyboard focus plays it. jsdom never matches :focus-visible, so a real
    // focus stands in for a keyboard one here.
    const matches = Element.prototype.matches;
    const spy = vi
      .spyOn(Element.prototype, 'matches')
      .mockImplementation(function (this: Element, selector: string) {
        return matches.call(this, selector === ':focus-visible' ? ':focus' : selector);
      });
    try {
      act(() => card.focus());
      expect(preview.dataset.playing).toBe('true');
      act(() => card.blur());
      expect(preview.dataset.playing).toBe('false');
    } finally {
      spy.mockRestore();
    }
  });

  it('do not count a mouse focus as engagement once the pointer leaves', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        cb: (entries: { isIntersecting: boolean }[]) => void;
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          this.cb = cb;
        }
        observe() {
          this.cb([{ isIntersecting: true }]);
        }
        disconnect() {}
      }
    );
    const extension = OFFICIAL_EXTENSIONS.find((e) => e.slug === EXT_STREAKS)!;
    render(<StoreCard extension={extension} state={{ label: 'Off', on: false }} adoption={null} />);
    const card = document.querySelector<HTMLElement>(`[data-store-card="${EXT_STREAKS}"]`)!;
    const preview = card.querySelector<HTMLElement>('[data-extension-preview]')!;
    // A ⌘-click: the pointer enters, the link takes (non-visible) focus, the
    // pointer leaves. The preview must stop.
    fireEvent.pointerEnter(card);
    act(() => card.focus());
    fireEvent.pointerLeave(card);
    expect(preview.dataset.playing).toBe('false');
  });

  it('play on their own on an extension’s own page', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        cb: (entries: { isIntersecting: boolean }[]) => void;
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          this.cb = cb;
        }
        observe() {
          this.cb([{ isIntersecting: true }]);
        }
        disconnect() {}
      }
    );
    render(<ExtensionPreview slug={EXT_STREAKS} />);
    const preview = document.querySelector<HTMLElement>(`[data-extension-preview="${EXT_STREAKS}"]`)!;
    expect(preview.dataset.playing).toBe('true');
  });
});

describe('doors into the store', () => {
  it('keeps the old address lean: it only redirects', () => {
    expect(routeNeedsItems('/extensions')).toBe(false);
  });

  it('has a ⌘K command with no shortcut, opening Settings → Extensions', () => {
    const command = STATIC_COMMANDS.find((c) => c.id === 'app.extensions');
    expect(command).toBeTruthy();
    expect(command!.shortcut).toBeUndefined();
    const navigate = vi.fn();
    command!.run({ navigate } as never);
    expect(navigate).toHaveBeenCalledWith('/settings/extensions');
  });
});
