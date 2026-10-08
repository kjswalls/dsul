import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/**
 * /settings/[[...pane]] — the two effects that argue about the URL.
 *
 * Nothing under tests/ imported this route before, which is how a ?focus= that
 * silently does nothing shipped. The self-routing claim is "the id is enough,
 * the pane no longer has to be right", and it has exactly one hard case: a
 * record whose home pane IS the fallback. The focus effect skips it (home ===
 * pane), so the normalising replace is the only navigation that link ever gets
 * — and that replace carried no query, so the param was dropped before anything
 * could read it. On a cold load the hydration gate means SettingsShell is not
 * even mounted yet, so "before anything could read it" is every time.
 *
 * These render the page UNHYDRATED on purpose: that is the state a deep link
 * arrives in, and both effects run above the gate's early return.
 */

const nav = vi.hoisted(() => {
  const replace = vi.fn();
  const push = vi.fn();
  return {
    replace,
    push,
    router: { replace, push, refresh: vi.fn(), prefetch: vi.fn() },
    params: {} as { pane?: string[] },
    search: new URLSearchParams(),
  };
});

vi.mock('next/navigation', () => ({
  // ONE object, not a fresh one per call. Next's router is stable and both
  // effects list it as a dep, so a new identity per render would re-fire them
  // on every unrelated state change and double every assertion below.
  useRouter: () => nav.router,
  useParams: () => nav.params,
  useSearchParams: () => nav.search,
  usePathname: () => '/settings',
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));
vi.mock('@/lib/settings-service', () => ({
  saveSettings: vi.fn(async () => {}),
  flushSettings: vi.fn(async () => {}),
}));
vi.mock('@/lib/user-profile', () => ({ resetOnboardingComplete: vi.fn(async () => {}) }));
// The surface itself, stood in so a HYDRATED render can say which pane the
// route handed it. Every other case renders unhydrated and never reaches it.
const shell = vi.hoisted(() => ({ pane: null as string | null }));
vi.mock('@/components/settings/settings-shell', () => ({
  SettingsShell: ({ pane }: { pane: string }) => {
    shell.pane = pane;
    return null;
  },
}));
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    auth: { getUser: async () => ({ data: { user: null } }), signOut: async () => ({}) },
  }),
}));

import SettingsPage from '@/app/settings/[[...pane]]/page';
import { PANES, paneHref, resolvePaneSlug, settingById } from '@/lib/settings/manifest';
import { AI_SETTINGS_PATH } from '@/lib/ai-types';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';

/** Render the route at one URL. `pane` undefined is a bare /settings. */
function at(pane: string[] | undefined, focus?: string) {
  nav.replace.mockClear();
  nav.params = pane ? { pane } : {};
  nav.search = new URLSearchParams(focus === undefined ? '' : `focus=${focus}`);
  render(<SettingsPage />);
  return nav.replace.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => nav.replace.mockClear());
afterEach(() => cleanup());

describe('?focus= survives the path-normalising replace', () => {
  it('carries the id off a bare /settings — the case the focus effect cannot cover', () => {
    // day.weekStart lives on 'day', which is also the fallback, so the focus
    // effect correctly does nothing. If this replace drops the query, the deep
    // link is gone.
    expect(settingById('day.weekStart')!.pane).toBe('day');
    expect(at(undefined, 'day.weekStart')).toEqual(['/settings/day?focus=day.weekStart']);
  });

  it('carries it off an unrecognised path too', () => {
    expect(at(['junk'], 'day.weekStart')).toEqual(['/settings/day?focus=day.weekStart']);
  });

  it('sends an unknown extension slug to the index, id intact', () => {
    // fallbackPane keeps an extensions/* path under Extensions — the one page
    // that can say which extensions exist. Both effects have something to say
    // here (the fallback is 'extensions', the record's home is 'day'), so what
    // matters is that NEITHER of them loses the id and the last word is the
    // record's home.
    const calls = at(['extensions', 'nope'], 'day.weekStart');
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) expect(url).toContain('?focus=day.weekStart');
    expect(calls.at(-1)).toBe('/settings/day?focus=day.weekStart');
  });

  it('appends nothing when there is no id to carry', () => {
    expect(at(undefined)).toEqual(['/settings/day']);
    // ?focus= with an empty value is not an id either.
    expect(at(undefined, '')).toEqual(['/settings/day']);
  });

  it('percent-encodes the id rather than pasting it into the URL', () => {
    expect(at(undefined, 'a%20b%26c')).toEqual(['/settings/day?focus=a%20b%26c']);
  });
});

describe('the two effects settle instead of arguing', () => {
  it('reaches a sub-pane record and then stops', () => {
    const id = 'extensions.beeminder.username';
    expect(settingById(id)!.pane).toBe('extensions/beeminder');

    // Both effects fire in the same commit — the path is not a pane AND the
    // fallback is not the record's home — so the browser gets two replaces and
    // the second is the one it ends on.
    const calls = at(undefined, id);
    for (const url of calls) expect(url).toContain(`?focus=${id}`);
    expect(calls.at(-1)).toBe(`/settings/extensions/beeminder?focus=${id}`);

    cleanup();
    // Landing there is the fixed point: neither effect has anything left to do.
    expect(at(['extensions', 'beeminder'], id)).toEqual([]);
  });

  it('takes a valid pane straight to the record it names', () => {
    // The self-routing claim on its own: a real pane, a real id that lives
    // somewhere else, one replace.
    const id = 'extensions.beeminder.username';
    expect(at(['day'], id)).toEqual([`/settings/extensions/beeminder?focus=${id}`]);
  });

  it('leaves a valid path with a same-pane id completely alone', () => {
    expect(at(['day'], 'day.weekStart')).toEqual([]);
  });

  it('stops at the fallback for an id that names no record', () => {
    // Malformed and merely unknown both land here: settingById returns
    // undefined, so the focus effect declines to route and nothing loops.
    expect(at(undefined, 'nope.nope')).toEqual(['/settings/day?focus=nope.nope']);
    cleanup();
    expect(at(['day'], 'nope.nope')).toEqual([]);
    cleanup();
    expect(at(['day'], '../../etc/passwd')).toEqual([]);
  });
});

describe('/settings/ai, the AI pane by the name the rail gives it', () => {
  /** Render at a path with a raw query, as the browser has it. */
  function atQuery(pane: string[], query: string) {
    nav.replace.mockClear();
    nav.params = { pane };
    nav.search = new URLSearchParams(query);
    render(<SettingsPage />);
    return nav.replace.mock.calls.map((c) => c[0] as string);
  }

  it('resolves to the pane it stands for, by own keys only', () => {
    expect(resolvePaneSlug('ai')).toBe('beacon');
    expect(resolvePaneSlug('beacon')).toBe('beacon');
    expect(resolvePaneSlug('day')).toBe('day');
    expect(resolvePaneSlug('extensions/beeminder')).toBe('extensions/beeminder');
    for (const junk of ['constructor', '__proto__', 'toString', 'AI', 'nope', '', undefined]) {
      expect(resolvePaneSlug(junk)).toBeNull();
    }
  });

  it('is linked by its alias, and every other pane by its id', () => {
    expect(paneHref('beacon')).toBe('/settings/ai');
    expect(paneHref('beacon')).toBe(AI_SETTINGS_PATH);
    expect(paneHref('day')).toBe('/settings/day');
    expect(paneHref('extensions/beeminder')).toBe('/settings/extensions/beeminder');
    // An alias is a way in, not a pane: the rail still has one AI row, under its id.
    expect(PANES.filter((p) => p.name === 'AI').map((p) => p.id)).toEqual(['beacon']);
  });

  it('keeps its address: nothing replaces /settings/ai', () => {
    expect(at(['ai'])).toEqual([]);
    expect(at(['ai'], 'beacon.model')).toEqual([]);
  });

  it("keeps its query: the pane's own ?start= and ?connect= survive the normalizer", () => {
    expect(atQuery(['ai'], 'start=openrouter')).toEqual([]);
    cleanup();
    expect(atQuery(['ai'], 'connect=denied')).toEqual([]);
  });

  it('sends an AI record that arrived on another pane to /settings/ai, never /settings/beacon', () => {
    expect(at(['day'], 'beacon.model')).toEqual(['/settings/ai?focus=beacon.model']);
    cleanup();
    // Use AI in dsul, the pane's first row, is a record like the rest.
    expect(at(['day'], 'beacon.useAi')).toEqual(['/settings/ai?focus=beacon.useAi']);
    cleanup();
    // The one-time nudges' bare /settings?focus=<id>: normalized first, then the record's own pane.
    expect(at(undefined, 'beacon.apiKey').at(-1)).toBe('/settings/ai?focus=beacon.apiKey');
  });

  it('still answers to /settings/beacon, which old links name', () => {
    expect(at(['beacon'])).toEqual([]);
    expect(at(['beacon'], 'beacon.model')).toEqual([]);
  });

  it('renders the AI pane at /settings/ai', () => {
    usePlannerStore.setState({ userId: 'u1' });
    useMorningStore.setState({ settingsHydratedUserId: 'u1' });
    try {
      shell.pane = null;
      at(['ai']);
      expect(shell.pane).toBe('beacon');
      cleanup();
      shell.pane = null;
      at(['beacon']);
      expect(shell.pane).toBe('beacon');
    } finally {
      useMorningStore.setState({ settingsHydratedUserId: null });
      usePlannerStore.setState({ userId: null });
    }
  });
});
