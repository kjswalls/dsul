import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DARK_LOOKS,
  DEFAULT_DARK_LOOK,
  DEFAULT_LIGHT_LOOK,
  LIGHT_LOOKS,
  LOOK_ATTRIBUTES,
  LOOK_STORAGE_KEYS,
  isDarkLook,
  isLightLook,
} from '@/lib/theme-looks';

/**
 * Themes span the TS catalog, the mode-scoped CSS blocks in app/globals.css and
 * the pre-hydration script in app/layout.tsx — three files that cannot import
 * each other, so these are drift tests, like theme-palettes.test.ts.
 */

const globalsCss = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
const layoutTsx = readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8');

const BLOCKS = {
  light: (slug: string) => `:root[data-look-light='${slug}']:not(.dark) {`,
  dark: (slug: string) => `:root[data-look-dark='${slug}'].dark {`,
};

describe('theme looks — catalog', () => {
  it('values are unique and slug-shaped, and the default leads each list', () => {
    for (const [list, def] of [
      [LIGHT_LOOKS, DEFAULT_LIGHT_LOOK],
      [DARK_LOOKS, DEFAULT_DARK_LOOK],
    ] as const) {
      const values = list.map((l) => l.value);
      expect(new Set(values).size).toBe(values.length);
      for (const v of values) expect(v).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
      expect(list[0].value).toBe(def);
    }
  });

  it('a light slug is never a dark slug — one pick per mode, never crossed', () => {
    const dark = new Set<string>(DARK_LOOKS.map((l) => l.value));
    for (const l of LIGHT_LOOKS) expect(dark.has(l.value), l.value).toBe(false);
    expect(isLightLook('terminal')).toBe(false);
    expect(isDarkLook('studio')).toBe(false);
    expect(isLightLook(null)).toBe(false);
  });

  it('only the defaults defer their chrome colour; every other theme names a hex', () => {
    for (const l of [...LIGHT_LOOKS, ...DARK_LOOKS]) {
      const isDefault = l.value === DEFAULT_LIGHT_LOOK || l.value === DEFAULT_DARK_LOOK;
      if (isDefault) expect(l.themeColor, l.value).toBeNull();
      else expect(l.themeColor, l.value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('theme looks — CSS contract', () => {
  it('every non-default theme has its mode-scoped block, and no default does', () => {
    for (const l of LIGHT_LOOKS) {
      expect(globalsCss.includes(BLOCKS.light(l.value)), l.value).toBe(l.value !== DEFAULT_LIGHT_LOOK);
    }
    for (const l of DARK_LOOKS) {
      expect(globalsCss.includes(BLOCKS.dark(l.value)), l.value).toBe(l.value !== DEFAULT_DARK_LOOK);
    }
  });

  it('no block exists for a slug the catalog does not list', () => {
    const light = new Set<string>(LIGHT_LOOKS.map((l) => l.value));
    const dark = new Set<string>(DARK_LOOKS.map((l) => l.value));
    for (const m of globalsCss.matchAll(/data-look-light='([a-z0-9-]+)'/g)) {
      expect(light.has(m[1]), m[1]).toBe(true);
    }
    for (const m of globalsCss.matchAll(/data-look-dark='([a-z0-9-]+)'/g)) {
      expect(dark.has(m[1]), m[1]).toBe(true);
    }
  });

  it('light blocks are scoped away from dark and dark blocks to it', () => {
    // An unscoped attribute selector is (0,2,0) and beats `.dark` (0,1,0):
    // a light theme's ground would leak into dark mode.
    for (const m of globalsCss.matchAll(/:root\[data-look-light='[a-z0-9-]+'\]([^ {]*)/g)) {
      expect(m[1]).toBe(':not(.dark)');
    }
    for (const m of globalsCss.matchAll(/:root\[data-look-dark='[a-z0-9-]+'\]([^ {]*)/g)) {
      expect(m[1]).toBe('.dark');
    }
  });

  it('theme blocks come after the palettes and shadow tokens they override', () => {
    // Equal weight to a palette block, so order decides: a tint left set from
    // Paper must not bleed into a theme that designed its own ground.
    const firstTheme = globalsCss.indexOf("data-look-");
    expect(firstTheme).toBeGreaterThan(globalsCss.lastIndexOf(":root[data-theme='"));
    expect(firstTheme).toBeGreaterThan(globalsCss.lastIndexOf('--shadow-elev-plate:'));
  });

  it('every theme re-declares what a palette touches, so no tint shows through', () => {
    const palettesTouch = [
      '--paper-0', '--paper-1', '--paper-2', '--paper-3', '--paper-well',
      '--ink-0', '--ink-1', '--ink-2', '--accent', '--border', '--input',
      '--row-selected', '--sidebar-border',
    ];
    const blocks = [
      ...LIGHT_LOOKS.filter((l) => l.value !== DEFAULT_LIGHT_LOOK).map((l) => BLOCKS.light(l.value)),
      ...DARK_LOOKS.filter((l) => l.value !== DEFAULT_DARK_LOOK).map((l) => BLOCKS.dark(l.value)),
    ];
    for (const head of blocks) {
      const start = globalsCss.indexOf(head);
      const body = globalsCss.slice(start, globalsCss.indexOf('\n}', start));
      for (const token of palettesTouch) {
        expect(body, `${head} ${token}`).toMatch(new RegExp(`\\n\\s*${token}:`));
      }
      // Light palettes also tint the scrim; dark scrims are hue-free black.
      if (head.includes('look-light')) expect(body, head).toMatch(/\n\s*--scrim:/);
    }
  });
});

describe('theme looks — pre-hydration script contract', () => {
  it('the layout inline script reads both storage keys and stamps both attributes', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(layoutTsx).toContain(`'${LOOK_STORAGE_KEYS[mode]}'`);
      expect(layoutTsx).toContain(`'${LOOK_ATTRIBUTES[mode]}'`);
    }
  });

  it('the reset escape hatch clears the themes too', () => {
    expect(layoutTsx).toMatch(/reset-theme[^"]*localStorage\.removeItem\(K\[i\]\[0\]\)/);
  });
});
