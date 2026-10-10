import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLOR_KEYS,
  PREPAINT_TABLE,
  SHADOW_PRESETS,
  THEME_FONT_KEYS,
  ThemeManifestSchema,
  isPrintedDecl,
  WASH_KEYS,
  printTheme,
  type ThemeManifest,
} from '@/lib/mods/theme-grammar';
import { THEME_BASES, type ThemeBaseId } from '@/lib/mods/theme-bases';
import { USER_THEME_PREPAINT } from '@/lib/user-themes/prepaint';
import { USER_THEME_CACHE_KEY, composeUserThemeCss } from '@/lib/user-themes/css';

/**
 * The pre-paint script's regex table is generated from the grammar, and the
 * script runs before React with nothing but that table to trust a cached value
 * by. So: every value the printer can produce matches it (drift), nothing
 * hostile does, and the script itself writes what the app would.
 */

function rand(n: number): number {
  return Math.floor(Math.random() * n);
}
const randomColor = () =>
  Math.random() < 0.3
    ? `#${rand(0xffffff).toString(16).padStart(6, '0')}`
    : `oklch(${(Math.random()).toFixed(rand(6))} ${(Math.random() * 0.4).toFixed(rand(6))} ${(Math.random() * 360).toFixed(rand(4))})`;

function randomManifest(): ThemeManifest {
  const ids = Object.keys(THEME_BASES) as ThemeBaseId[];
  const base = ids[rand(ids.length)];
  const mode = THEME_BASES[base].mode;
  const tokens: Record<string, unknown> = {};
  for (const key of COLOR_KEYS) if (!WASH_KEYS.includes(key) && Math.random() < 0.6) tokens[key] = randomColor();
  if (Math.random() < 0.5) tokens.rowSelected = `oklch(0.5 0.1 90 / ${4 + rand(27)}%)`;
  if (Math.random() < 0.5) tokens.accent = `oklch(0.5 0.1 90 / ${2 + rand(19)}%)`;
  if (Math.random() < 0.5) tokens.scrim = `oklch(0 0 0 / ${(0.12 + Math.random() * 0.48).toFixed(3)})`;
  const relayKey = mode === 'light' ? 'relayLight' : 'relayDark';
  if (Math.random() < 0.5) tokens[relayKey] = Array.from({ length: 1 + rand(12) }, randomColor);
  if (Math.random() < 0.5) tokens.radius = rand(25);
  if (Math.random() < 0.5) tokens.shadows = SHADOW_PRESETS[rand(SHADOW_PRESETS.length)];
  if (Math.random() < 0.5) tokens.font = THEME_FONT_KEYS[rand(THEME_FONT_KEYS.length)];
  return ThemeManifestSchema.parse({ version: 1, mode, base, tokens });
}

describe('PREPAINT_TABLE drift', () => {
  it('every base theme prints only declarations the table accepts', () => {
    for (const base of Object.keys(THEME_BASES) as ThemeBaseId[]) {
      const m = ThemeManifestSchema.parse({ version: 1, mode: THEME_BASES[base].mode, base, tokens: {} });
      for (const [name, value] of printTheme(m).decls) expect(isPrintedDecl(name, value), `${base} ${name}: ${value}`).toBe(true);
    }
  });

  it('every preset and font matches', () => {
    for (const shadows of SHADOW_PRESETS) {
      for (const font of THEME_FONT_KEYS) {
        const m = ThemeManifestSchema.parse({ version: 1, mode: 'light', base: 'paper', tokens: { shadows, font } });
        for (const [name, value] of printTheme(m).decls) expect(isPrintedDecl(name, value), name).toBe(true);
      }
    }
  });

  it('500 random valid themes print only what the table accepts', () => {
    for (let i = 0; i < 500; i++) {
      for (const [name, value] of printTheme(randomManifest()).decls) {
        expect(isPrintedDecl(name, value), `${name}: ${value}`).toBe(true);
      }
    }
  });

  it('refuses hostile values and unknown names', () => {
    const hostile = [
      'url(x)',
      'oklch(0.5 0.1 90);}body{display:none',
      '</style><script>alert(1)</script>',
      '#fff',
      'red',
      'var(--x)',
      'oklch(0.5 0.1 90) ',
      'oklch(0.5 0.1 90)\n',
      '@import "x"',
      '0 0 0 1px red',
    ];
    for (const v of hostile) {
      expect(isPrintedDecl('--paper-0', v), v).toBe(false);
      expect(isPrintedDecl('--shadow-elev-sm', v), v).toBe(false);
      expect(isPrintedDecl('--font-ui', v), v).toBe(false);
    }
    expect(isPrintedDecl('--font-mono', 'oklch(0.5 0.1 90)')).toBe(false);
    expect(isPrintedDecl('--paper-0;color', 'oklch(0.5 0.1 90)')).toBe(false);
    expect(isPrintedDecl('__proto__', 'x')).toBe(false);
    expect(isPrintedDecl('constructor', 'x')).toBe(false);
    // Alpha only on the tokens that take it.
    expect(isPrintedDecl('--lime-solid', 'oklch(0.5 0.1 90 / 50%)')).toBe(false);
    expect(isPrintedDecl('--scrim', 'oklch(0.5 0.1 90 / 50%)')).toBe(true);
    // A wash is never opaque, in the cache either.
    expect(isPrintedDecl('--scrim', '#000000')).toBe(false);
    expect(isPrintedDecl('--accent', 'oklch(0.5 0.1 90)')).toBe(false);
    expect(isPrintedDecl('--border', '#dddddd')).toBe(true);
    expect(Object.keys(PREPAINT_TABLE)).toContain('--font-ui');
  });
});

describe('the pre-paint script', () => {
  const SLUG = 'u-1a2b3c4d';
  const DARK_SLUG = 'u-99887766';
  const m = ThemeManifestSchema.parse({ version: 1, mode: 'light', base: 'studio', tokens: { paper0: '#fafafa' } });
  const md = ThemeManifestSchema.parse({ version: 1, mode: 'dark', base: 'dusk', tokens: { radius: 2 } });
  const printed = printTheme(m);
  const printedDark = printTheme(md);
  const entry = (slug: string, p = printed) => ({ s: slug, m: p.mode, c: p.themeColor, d: p.decls });

  const run = (search = '') => {
    window.history.replaceState(null, '', `/${search}`);
    // Indirect eval: the script's own scope, as an inline <script> has.
    (0, eval)(USER_THEME_PREPAINT);
  };
  const boot = () => document.getElementById('dsul-user-themes-boot');

  beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = '';
    document.documentElement.removeAttribute('data-look-light');
    document.documentElement.removeAttribute('data-look-dark');
  });

  it('a good cache: the boot sheet is exactly what the app writes, live rules only', () => {
    localStorage.setItem(USER_THEME_CACHE_KEY, JSON.stringify({ v: 1, t: [entry(SLUG), entry(DARK_SLUG, printedDark)] }));
    document.documentElement.setAttribute('data-look-light', SLUG);
    document.documentElement.setAttribute('data-look-dark', DARK_SLUG);
    run();
    expect(boot()?.textContent).toBe(
      composeUserThemeCss(
        [
          { slug: SLUG, mode: 'light', decls: printed.decls },
          { slug: DARK_SLUG, mode: 'dark', decls: printedDark.decls },
        ],
        { preview: false }
      )
    );
    expect(document.documentElement.getAttribute('data-look-light')).toBe(SLUG);
    expect(boot()?.textContent).not.toContain('data-theme-preview');
  });

  it('a tampered value drops the entry and the attribute', () => {
    const bad = entry(SLUG);
    bad.d = [...bad.d.slice(0, 1), ['--paper-1', 'red;}body{display:none']] as typeof bad.d;
    localStorage.setItem(USER_THEME_CACHE_KEY, JSON.stringify({ v: 1, t: [bad] }));
    document.documentElement.setAttribute('data-look-light', SLUG);
    run();
    expect(boot()).toBeNull();
    expect(document.documentElement.hasAttribute('data-look-light')).toBe(false);
  });

  it('an unknown declaration name drops it too', () => {
    const bad = entry(SLUG);
    bad.d = [...bad.d, ['--font-mono', 'oklch(0.5 0.1 90)']] as typeof bad.d;
    localStorage.setItem(USER_THEME_CACHE_KEY, JSON.stringify({ v: 1, t: [bad] }));
    document.documentElement.setAttribute('data-look-light', SLUG);
    run();
    expect(document.documentElement.hasAttribute('data-look-light')).toBe(false);
  });

  it('a missing entry, or one of the other mode, removes the attribute', () => {
    localStorage.setItem(USER_THEME_CACHE_KEY, JSON.stringify({ v: 1, t: [entry(DARK_SLUG, printedDark)] }));
    document.documentElement.setAttribute('data-look-light', DARK_SLUG);
    run();
    expect(boot()).toBeNull();
    expect(document.documentElement.hasAttribute('data-look-light')).toBe(false);
  });

  it('?safe-mode injects nothing and removes the attribute', () => {
    localStorage.setItem(USER_THEME_CACHE_KEY, JSON.stringify({ v: 1, t: [entry(SLUG)] }));
    document.documentElement.setAttribute('data-look-light', SLUG);
    run('?safe-mode');
    expect(boot()).toBeNull();
    expect(document.documentElement.hasAttribute('data-look-light')).toBe(false);
    window.history.replaceState(null, '', '/');
  });

  it('leaves a built-in pick alone', () => {
    document.documentElement.setAttribute('data-look-light', 'studio');
    run();
    expect(document.documentElement.getAttribute('data-look-light')).toBe('studio');
    expect(boot()).toBeNull();
  });

  it('a garbage cache is a cache miss, never a throw', () => {
    localStorage.setItem(USER_THEME_CACHE_KEY, '{not json');
    document.documentElement.setAttribute('data-look-light', SLUG);
    expect(() => run()).not.toThrow();
    expect(document.documentElement.hasAttribute('data-look-light')).toBe(false);
  });

  it('runs after the look stamp in app/layout.tsx', () => {
    const layout = readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8');
    const look = layout.indexOf("['dsul-look-light','data-look-light']");
    const own = layout.indexOf('__html: USER_THEME_PREPAINT');
    expect(look).toBeGreaterThan(0);
    expect(own).toBeGreaterThan(look);
    expect(layout.indexOf('<ThemeProvider')).toBeGreaterThan(own);
  });
});
