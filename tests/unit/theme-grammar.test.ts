import { describe, it, expect } from 'vitest';
import { parseColor, printColor } from '@/lib/mods/color';
import {
  CSS_VAR,
  ThemeManifestSchema,
  canonicalTokens,
  parseToken,
  printTheme,
} from '@/lib/mods/theme-grammar';

/**
 * The user-theme grammar (memory/plans/mods.md, "Themes and Looks"): what a
 * token accepts, how it is printed back, and that nothing shaped like CSS gets
 * through. The host never passes a user's text to a stylesheet.
 */

const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  mode: 'light',
  base: 'paper',
  tokens: {},
  ...over,
});

const ok = (m: unknown) => ThemeManifestSchema.safeParse(m).success;

describe('colours: accepted and re-printed', () => {
  it.each([
    ['#ABC', '#aabbcc'],
    ['#aAbBcC', '#aabbcc'],
    ['oklch(50% .1 90)', 'oklch(0.5 0.1 90)'],
    ['oklch(0.50000 0.1000 90.00)', 'oklch(0.5 0.1 90)'],
    ['  oklch(0.986 0.0012 90)  ', 'oklch(0.986 0.0012 90)'],
    ['OKLCH(1 0 0)', 'oklch(1 0 0)'],
    ['oklch(1 0 0 / 10%)', 'oklch(1 0 0 / 10%)'],
    ['oklch(1 0 0 / 0.125)', 'oklch(1 0 0 / 12.5%)'],
    ['oklch(0.123456 0.12345 123.456)', 'oklch(0.1235 0.1235 123.46)'],
  ])('%s prints as %s', (input, printed) => {
    const c = parseColor(input);
    expect(c).not.toBeNull();
    expect(printColor(c!)).toBe(printed);
  });

  it('a printed value parses back to itself', () => {
    for (const v of ['#0a0b0c', 'oklch(0.5 0.1 90)', 'oklch(0.2 0 0 / 4%)']) {
      expect(printColor(parseColor(v)!)).toBe(v);
    }
  });
});

describe('tokens: bounds', () => {
  it('alpha only where allowed, and within bounds', () => {
    expect(parseToken('limeSolid', 'oklch(0.86 0.17 125 / 50%)')).toBeNull();
    expect(parseToken('ink0', 'oklch(0.2 0 0 / 90%)')).toBeNull();
    expect(parseToken('scrim', 'oklch(0 0 0 / 11%)')).toBeNull();
    expect(parseToken('scrim', 'oklch(0 0 0 / 12%)')).not.toBeNull();
    expect(parseToken('scrim', 'oklch(0 0 0 / 61%)')).toBeNull();
    expect(parseToken('accent', 'oklch(0 0 0 / 1%)')).toBeNull();
    expect(parseToken('accent', 'oklch(0 0 0 / 4%)')).not.toBeNull();
    expect(parseToken('border', 'oklch(1 0 0 / 22%)')).not.toBeNull();
    expect(parseToken('rowSelected', 'oklch(1 0 0 / 31%)')).toBeNull();
    // A wash is never opaque: a missing alpha is 100%, over every ceiling.
    expect(parseToken('scrim', '#000')).toBeNull();
    expect(parseToken('scrim', '#000000')).toBeNull();
    expect(parseToken('scrim', 'oklch(0 0 0)')).toBeNull();
    expect(parseToken('accent', '#ffffff')).toBeNull();
    expect(parseToken('rowSelected', 'oklch(0.5 0.1 90)')).toBeNull();
    // The hairlines may be opaque, as the light built-ins draw them.
    expect(parseToken('border', '#dddddd')).not.toBeNull();
    expect(parseToken('input', 'oklch(0.86 0.012 272)')).not.toBeNull();
    expect(parseToken('sidebarBorder', '#eee')).not.toBeNull();
  });

  it('numbers out of range, and forms that are not plain decimals', () => {
    for (const v of [
      'oklch(0.5 0.5 90)',
      'oklch(1.1 0.1 90)',
      'oklch(101% 0.1 90)',
      'oklch(0.5 0.1 361)',
      'oklch(-0.5 0.1 90)',
      'oklch(5e-1 0.1 90)',
      'oklch(none 0.1 90)',
      'oklch(calc(0.5) 0.1 90)',
      'oklch(var(--x) 0.1 90)',
      'var(--lime-solid)',
      'red',
      'transparent',
      'rgb(0 0 0)',
      '#abcd',
      '#aabbccdd',
      '',
    ]) {
      expect(parseColor(v), v).toBeNull();
    }
  });

  it('radius is a whole number of pixels, 0 to 24', () => {
    expect(ok(manifest({ tokens: { radius: 0 } }))).toBe(true);
    expect(ok(manifest({ tokens: { radius: 24 } }))).toBe(true);
    expect(ok(manifest({ tokens: { radius: 25 } }))).toBe(false);
    expect(ok(manifest({ tokens: { radius: 1.5 } }))).toBe(false);
    expect(ok(manifest({ tokens: { radius: '8px' } }))).toBe(false);
  });

  it('shadows and fonts are closed lists', () => {
    expect(ok(manifest({ tokens: { shadows: 'dusk', font: 'serif' } }))).toBe(true);
    expect(ok(manifest({ tokens: { shadows: '0 0 0 red' } }))).toBe(false);
    expect(ok(manifest({ tokens: { font: 'Comic Sans' } }))).toBe(false);
  });
});

describe('injection attempts are refused', () => {
  const HOSTILE = [
    'url(x)',
    'url(https://evil.example/a.png)',
    'image-set("a.png" 1x)',
    '@import "x.css"',
    'oklch(0.5 0.1 90);}body{display:none',
    'oklch(0.5 0.1 90)}',
    '#fff;background:red',
    '</style><script>alert(1)</script>',
    '\\6f klch(0.5 0.1 90)',
    'oklch(0.5 0.1 90)\n',
    'oklch(0.5\n0.1 90)',
    'oklch(0.5 /**/ 0.1 90)',
    'content: "x"',
    "'#fff'",
    '"#fff"',
    'expression(alert(1))',
    'oklch(0.5 0.1 90) !important',
  ];

  it.each(HOSTILE)('%s', (v) => {
    expect(parseColor(v)).toBeNull();
    expect(ok(manifest({ tokens: { paper0: v } }))).toBe(false);
    expect(ok(manifest({ tokens: { relayLight: [v] } }))).toBe(false);
  });

  it('unknown keys, at either level, fail: --font-mono is not a token', () => {
    expect(ok(manifest({ tokens: { '--font-mono': 'x' } }))).toBe(false);
    expect(ok(manifest({ tokens: { fontMono: 'jetbrains' } }))).toBe(false);
    expect(ok(manifest({ tokens: { '--paper-0': '#fff' } }))).toBe(false);
    expect(ok({ ...manifest(), css: 'body{}' })).toBe(false);
  });

  it('a relay belongs to its mode, and the base to the theme’s mode', () => {
    expect(ok(manifest({ tokens: { relayDark: ['#ffffff'] } }))).toBe(false);
    expect(ok(manifest({ mode: 'dark', base: 'night', tokens: { relayLight: ['#ffffff'] } }))).toBe(false);
    expect(ok(manifest({ mode: 'dark', base: 'night', tokens: { relayDark: ['#ffffff'] } }))).toBe(true);
    expect(ok(manifest({ base: 'night' }))).toBe(false);
    expect(ok(manifest({ mode: 'dark', base: 'studio' }))).toBe(false);
    expect(ok(manifest({ tokens: { relayLight: Array(13).fill('#ffffff') } }))).toBe(false);
  });

  it('themeColor is #rrggbb only', () => {
    expect(ok(manifest({ themeColor: '#abcdef' }))).toBe(true);
    expect(ok(manifest({ themeColor: '#abc' }))).toBe(false);
    expect(ok(manifest({ themeColor: 'oklch(0.5 0.1 90)' }))).toBe(false);
  });
});

describe('printing', () => {
  it('prints from parsed numbers, never the text it was given', () => {
    const m = ThemeManifestSchema.parse(manifest({ tokens: { paper0: '#ABC', ink0: 'oklch(20% 0.0100 272)' } }));
    const decls = new Map(printTheme(m).decls);
    expect(decls.get('--paper-0')).toBe('#aabbcc');
    expect(decls.get('--ink-0')).toBe('oklch(0.2 0.01 272)');
  });

  it('canonicalTokens re-prints what Save stores', () => {
    expect(canonicalTokens({ paper0: '#ABC', relayLight: ['#FFF', 'oklch(50% .1 90)'] })).toEqual({
      paper0: '#aabbcc',
      relayLight: ['#ffffff', 'oklch(0.5 0.1 90)'],
    });
  });

  it('every value printed has only the characters the grammar writes', () => {
    const m = ThemeManifestSchema.parse(
      manifest({ mode: 'dark', base: 'terminal', tokens: { paper0: '#000', relayDark: ['#fff'], radius: 3 } })
    );
    for (const [name, value] of printTheme(m).decls) {
      expect(name).toMatch(/^--[a-z0-9-]+$/);
      if (name === '--font-ui' || name.startsWith('--shadow-')) continue;
      expect(value, name).toMatch(/^[0-9a-z#.%() /,]+$/);
    }
  });

  it('Paper leaves its var() chains unprinted; Studio prints its literals', () => {
    const paper = new Map(printTheme(ThemeManifestSchema.parse(manifest())).decls);
    expect(paper.has(CSS_VAR.primaryForeground)).toBe(false);
    expect(paper.has(CSS_VAR.askIconPairInk)).toBe(false);
    expect(paper.has(CSS_VAR.relayLight)).toBe(false);
    const studio = new Map(printTheme(ThemeManifestSchema.parse(manifest({ base: 'studio' }))).decls);
    expect(studio.get(CSS_VAR.primaryForeground)).toBe('oklch(0.99 0 0)');
    expect(studio.get(CSS_VAR.askIconPairInk)).toBe('oklch(0.65 0.13 225)');
    expect(studio.get('--radius')).toBe('8px');
    expect(studio.get('--font-ui')).toContain('--font-geist');
  });

  it('an Ask ink that follows its partner follows the theme’s partner', () => {
    const m = ThemeManifestSchema.parse(manifest({ base: 'studio', tokens: { askIconPair: '#112233' } }));
    expect(new Map(printTheme(m).decls).get(CSS_VAR.askIconPairInk)).toBe('#112233');
  });

  it('always prints what a tint touches, so no tint shows through', () => {
    const decls = new Map(printTheme(ThemeManifestSchema.parse(manifest())).decls);
    for (const v of ['--paper-0', '--paper-well', '--ink-2', '--accent', '--border', '--input', '--row-selected', '--scrim', '--sidebar-border']) {
      expect(decls.has(v), v).toBe(true);
    }
  });

  it('themeColor: the manifest’s, else the ground as hex', () => {
    expect(printTheme(ThemeManifestSchema.parse(manifest({ themeColor: '#123456' }))).themeColor).toBe('#123456');
    expect(printTheme(ThemeManifestSchema.parse(manifest({ tokens: { paper0: '#fafafa' } }))).themeColor).toBe('#fafafa');
    expect(printTheme(ThemeManifestSchema.parse(manifest())).themeColor).toMatch(/^#[0-9a-f]{6}$/);
  });
});
