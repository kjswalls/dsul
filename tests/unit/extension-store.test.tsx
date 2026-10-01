import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The extensions store (/extensions) and the copy, previews and adoption
 * figures behind it.
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/extensions',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: () => {} }) }));

import {
  EXT_ACCOUNTABILITY_PARTNER,
  EXT_BEEMINDER,
  EXT_ORGANIZE,
  EXT_PHONE_CALL,
  EXT_SMS_NUDGE,
  EXT_STREAKS,
  EXT_VOICE_ANNOUNCEMENTS,
  OFFICIAL_EXTENSIONS,
} from '@/lib/extension-registry';
import { EXTENSION_SETTINGS } from '@/lib/extension-settings';
import { FEATURED_SLUG, STORE_SHELVES, catalogByShelf, costLabel, searchCatalog } from '@/lib/extension-catalog';
import { MIN_PEOPLE, adoptionLine, computeAdoption, type AdoptionCounts } from '@/lib/extension-adoption';
import { EXTENSION_PREVIEWS, ExtensionPreview } from '@/components/extensions/previews/extension-preview';
import { ExtensionsStorePage } from '@/components/extensions/extensions-store-page';
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

describe('store search', () => {
  it('returns everything for an empty query', () => {
    expect(searchCatalog('  ')).toHaveLength(OFFICIAL_EXTENSIONS.length);
  });

  it('finds what settings search finds, through the records’ own keywords', () => {
    // "sonos" is only a keyword on the Speak aloud records, never in its copy.
    expect(searchCatalog('sonos').map((e) => e.slug)).toEqual([EXT_VOICE_ANNOUNCEMENTS]);
    expect(searchCatalog('twilio').map((e) => e.slug).sort()).toEqual([EXT_PHONE_CALL, EXT_SMS_NUDGE].sort());
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

describe('the store page', () => {
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

  it('draws one card per extension, each linking to its own settings pane', () => {
    render(<ExtensionsStorePage />);
    for (const slug of slugs) {
      const card = document.querySelector(`[data-store-card="${slug}"]`);
      expect(card, slug).toBeTruthy();
      expect(card!.getAttribute('href')).toBe(`/settings/extensions/${slug}`);
    }
  });

  it('says the same state word as the shared rule, and holds no switch', () => {
    useExtensionsStore.setState({ enabled: { [EXT_BEEMINDER]: true } });
    render(<ExtensionsStorePage />);
    const ctx = { theme: 'system', setTheme: () => {}, userId: 'test-user' };
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

  it('waits for this account’s settings before saying anything', () => {
    useMorningStore.setState({ settingsHydratedUserId: 'someone-else' });
    render(<ExtensionsStorePage />);
    expect(screen.getByTestId('extensions-store').dataset.storeState).toBe('loading');
    expect(document.querySelector('[data-store-card]')).toBeNull();
  });

  it('filters by search and by shelf', () => {
    render(<ExtensionsStorePage />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search extensions' }), { target: { value: 'twilio' } });
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[data-store-card]')).map((c) => c.dataset.storeCard).sort()
    ).toEqual([EXT_PHONE_CALL, EXT_SMS_NUDGE].sort());
    expect(document.querySelector('[data-store-featured]')).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search extensions' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Put something on the line' }));
    expect(document.querySelectorAll('[data-store-shelf]')).toHaveLength(1);
    expect(document.querySelector('[data-store-shelf="stakes"]')).toBeTruthy();
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

describe('doors into the store', () => {
  it('is a lean route', () => {
    expect(routeNeedsItems('/extensions')).toBe(false);
  });

  it('has a ⌘K command with no shortcut', () => {
    const command = STATIC_COMMANDS.find((c) => c.id === 'app.extensions');
    expect(command).toBeTruthy();
    expect(command!.shortcut).toBeUndefined();
  });
});
