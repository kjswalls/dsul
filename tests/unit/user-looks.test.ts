import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  lookRefProblems,
  ownThemesOfMode,
  userLookBlurb,
  userLookByRef,
  userLookChanges,
  userLookFallbackNote,
  userLookShows,
  userLookState,
  unlistedLookLabel,
  userLooksFromRows,
  type UserLook,
} from '@/lib/user-looks';
import { setUserThemesFromRows, useUserThemes } from '@/lib/user-themes/store';
import { themeSlugForId } from '@/lib/user-themes/css';
import { useModsStore } from '@/lib/mods-store';
import type { LookManifest, UserMod } from '@/lib/mods/schema';

/** Your own Looks (lib/user-looks.ts, memory/plans/mods.md build order 5b). */

const row = (id: string, kind: UserMod['kind'], name: string, manifest: unknown, enabled = true, createdAt = '2026-10-07T00:00:00Z'): UserMod => ({
  id,
  userId: 'u1',
  kind,
  slug: themeSlugForId(id),
  name,
  enabled,
  manifest,
  disabledReason: null,
  createdAt,
  updatedAt: createdAt,
});

const lightTheme = { version: 1, mode: 'light', base: 'paper', tokens: { paper0: '#fafafa' } };
const darkTheme = { version: 1, mode: 'dark', base: 'night', tokens: {} };
const MOSS = row('aaaaaaaa-0000-4000-8000-000000000001', 'theme', 'Moss', lightTheme);
const FOG = row('bbbbbbbb-0000-4000-8000-000000000002', 'theme', 'Fog', lightTheme, false);
const EMBER = row('cccccccc-0000-4000-8000-000000000003', 'theme', 'Ember', darkTheme);

const lookRow = (id: string, name: string, m: Partial<LookManifest> = {}, enabled = true, createdAt?: string) =>
  row(id, 'look', name, { version: 1, layout: 'classic', light: 'paper', dark: 'night', ...m }, enabled, createdAt);

const look = (p: Partial<UserLook> = {}): UserLook => ({
  id: 'x',
  ref: 'u-12345678',
  label: 'Deep work',
  layout: 'classic',
  light: 'paper',
  dark: 'night',
  ...p,
});

beforeEach(() => {
  localStorage.clear();
  setUserThemesFromRows([MOSS, FOG, EMBER], false);
});
afterEach(() => {
  useUserThemes.setState({ themes: {}, draft: null, rev: 0, source: 'none' });
  useModsStore.getState().reset();
  useModsStore.setState({ safeMode: false });
});

describe('userLooksFromRows', () => {
  const DEEP = lookRow('11111111-0000-4000-8000-000000000001', 'Deep work', { layout: 'notebook', light: 'u-aaaaaaaa' });
  const CALM = lookRow('22222222-0000-4000-8000-000000000002', 'Calm', { dark: 'dusk' });
  const OFF = lookRow('33333333-0000-4000-8000-000000000003', 'Off one', {}, false);
  const BAD = row('44444444-0000-4000-8000-000000000004', 'look', 'Broken', { version: 1, layout: 'mine', light: 'paper', dark: 'night' });

  it('keeps enabled, well-formed Looks, in name order, with the ref from the id', () => {
    const looks = userLooksFromRows([DEEP, CALM, OFF, BAD, MOSS], false);
    expect(looks.map((l) => l.label)).toEqual(['Calm', 'Deep work']);
    expect(looks[1]).toMatchObject({ ref: 'u-11111111', layout: 'notebook', light: 'u-aaaaaaaa', dark: 'night' });
  });

  it('none in safe mode', () => {
    expect(userLooksFromRows([DEEP, CALM], true)).toEqual([]);
  });

  it('two rows sharing a ref keep the older', () => {
    const older = lookRow('55555555-0000-4000-8000-00000000000a', 'Older', {}, true, '2026-10-01T00:00:00Z');
    const newer = lookRow('55555555-1111-4000-8000-00000000000b', 'Newer', {}, true, '2026-10-05T00:00:00Z');
    expect(userLooksFromRows([newer, older], false).map((l) => l.label)).toEqual(['Older']);
  });

  it('the label is modLabel: a name only the database took falls back to the slug', () => {
    const odd = { ...DEEP, name: ' ' };
    expect(userLooksFromRows([odd], false)[0].label).toBe(odd.slug);
  });

  it('userLookByRef reads the store, and finds nothing for an off Look or in safe mode', () => {
    useModsStore.setState({ rows: [DEEP, OFF] });
    expect(userLookByRef('u-11111111')?.label).toBe('Deep work');
    expect(userLookByRef('u-33333333')).toBeUndefined();
    useModsStore.setState({ safeMode: true });
    expect(userLookByRef('u-11111111')).toBeUndefined();
  });
});

describe('resolving a Look', () => {
  const rows = [MOSS, FOG, EMBER];

  it('writes its own themes by their slugs, a theme that is switched off included', () => {
    expect(userLookChanges(look({ light: 'u-aaaaaaaa', dark: 'u-cccccccc' }), rows)).toEqual({
      layout: 'classic',
      light: 'u-aaaaaaaa',
      dark: 'u-cccccccc',
    });
    // Fog is off: saved as itself, shown as Paper until it is on again.
    expect(userLookChanges(look({ light: 'u-bbbbbbbb' }), rows).light).toBe('u-bbbbbbbb');
    expect(userLookShows(look({ light: 'u-bbbbbbbb' })).light).toBe('paper');
  });

  it('asks the rows, not the theme registry, so an empty registry changes nothing', () => {
    useUserThemes.setState({ themes: {}, source: 'none' });
    expect(userLookChanges(look({ light: 'u-aaaaaaaa' }), rows).light).toBe('u-aaaaaaaa');
    // And the store's rows are the default.
    useModsStore.setState({ rows });
    expect(userLookChanges(look({ dark: 'u-cccccccc' })).dark).toBe('u-cccccccc');
  });

  it('writes the default for a ref that is gone or names a theme of the other mode', () => {
    for (const light of ['u-deadbeef', 'u-cccccccc'] as const) {
      expect(userLookChanges(look({ light }), rows).light, light).toBe('paper');
    }
    expect(userLookChanges(look({ dark: 'u-aaaaaaaa' }), rows).dark).toBe('night');
  });

  it('shows the default for a theme that is missing, off or of the other mode', () => {
    for (const light of ['u-deadbeef', 'u-bbbbbbbb', 'u-cccccccc'] as const) {
      expect(userLookShows(look({ light })).light, light).toBe('paper');
    }
    expect(userLookShows(look({ dark: 'u-aaaaaaaa' })).dark).toBe('night');
  });

  it('is on only when all three saved picks are what it writes', () => {
    const l = look({ layout: 'writer', light: 'u-aaaaaaaa', dark: 'dusk' });
    expect(userLookState(l, { layout: 'writer', light: 'u-aaaaaaaa', dark: 'dusk' }, rows)).toBe('on');
    expect(userLookState(l, { layout: 'classic', light: 'u-aaaaaaaa', dark: 'dusk' }, rows)).toBe('off');
    expect(userLookState(l, { layout: 'writer', light: 'paper', dark: 'dusk' }, rows)).toBe('off');
    expect(userLookState(l, { layout: 'writer', light: 'u-aaaaaaaa', dark: 'night' }, rows)).toBe('off');
  });

  it('compares saved picks: a switched-off theme is on as itself, not as the default it shows', () => {
    const l = look({ light: 'u-bbbbbbbb' });
    expect(userLookState(l, { layout: 'classic', light: 'u-bbbbbbbb', dark: 'night' }, rows)).toBe('on');
    expect(userLookState(l, { layout: 'classic', light: 'paper', dark: 'night' }, rows)).toBe('off');
  });

  it('is on when both its themes have gone and the defaults are saved', () => {
    const l = look({ light: 'u-deadbeef', dark: 'u-feedface' });
    expect(userLookState(l, { layout: 'classic', light: 'paper', dark: 'night' }, rows)).toBe('on');
  });

  it('says quietly which side fell back', () => {
    expect(userLookFallbackNote(look({ light: 'u-aaaaaaaa', dark: 'u-cccccccc' }))).toBeNull();
    expect(userLookFallbackNote(look({ light: 'u-bbbbbbbb' }))).toBe('Its light theme is off or gone, so Paper shows by day.');
    expect(userLookFallbackNote(look({ dark: 'u-feedface' }))).toBe('Its dark theme is off or gone, so Night shows at night.');
    expect(userLookFallbackNote(look({ light: 'u-deadbeef', dark: 'u-feedface' }))).toBe(
      'Its themes are off or gone, so Paper and Night show.'
    );
  });

  it('the blurb names the layout and what shows, or the layout’s own colours', () => {
    expect(userLookBlurb(look({ layout: 'notebook', light: 'u-aaaaaaaa', dark: 'dusk' }))).toBe('Notebook on Moss and Dusk');
    expect(userLookBlurb(look({ light: 'u-deadbeef' }))).toBe('Classic on Paper and Night');
    expect(userLookBlurb(look({ layout: 'notepad-retro' }))).toBe('Notepad, Retro in its own colours');
  });
});

describe('unlistedLookLabel', () => {
  it('names an off Look from its row, a gone one plainly, and an on one (safe mode) bare', () => {
    const on = lookRow('66666666-0000-4000-8000-000000000006', 'Calm');
    const off = lookRow('77777777-0000-4000-8000-000000000007', 'Quiet', {}, false);
    expect(unlistedLookLabel('u-77777777', [on, off])).toBe('Quiet (off)');
    expect(unlistedLookLabel('u-66666666', [on, off])).toBe('Calm');
    expect(unlistedLookLabel('u-88888888', [on, off])).toBe('A Look you deleted');
    // A theme row sharing the ref is not a Look.
    expect(unlistedLookLabel('u-aaaaaaaa', [MOSS])).toBe('A Look you deleted');
  });
});

describe('ownThemesOfMode', () => {
  it('lists the owner’s themes of one mode from the rows, off ones marked, in name order', () => {
    expect(ownThemesOfMode([MOSS, FOG, EMBER], 'light')).toEqual([
      { slug: 'u-bbbbbbbb', label: 'Fog', enabled: false },
      { slug: 'u-aaaaaaaa', label: 'Moss', enabled: true },
    ]);
    expect(ownThemesOfMode([MOSS, FOG, EMBER], 'dark')).toEqual([{ slug: 'u-cccccccc', label: 'Ember', enabled: true }]);
  });
});

describe('lookRefProblems', () => {
  const m = (p: Partial<LookManifest>): LookManifest => ({ version: 1, layout: 'classic', light: 'paper', dark: 'night', ...p });
  const rows = [MOSS, FOG, EMBER];

  it('takes built-ins and your themes of the right mode, switched off included', () => {
    expect(lookRefProblems(m({}), rows)).toEqual([]);
    expect(lookRefProblems(m({ light: 'u-aaaaaaaa', dark: 'u-cccccccc' }), rows)).toEqual([]);
    expect(lookRefProblems(m({ light: 'u-bbbbbbbb' }), rows)).toEqual([]);
  });

  it('refuses an unknown ref and a theme of the other mode', () => {
    expect(lookRefProblems(m({ light: 'u-deadbeef' }), rows)).toEqual(['Pick a light theme.']);
    expect(lookRefProblems(m({ light: 'u-cccccccc', dark: 'u-aaaaaaaa' }), rows)).toEqual([
      'Pick a light theme.',
      'Pick a dark theme.',
    ]);
  });
});
