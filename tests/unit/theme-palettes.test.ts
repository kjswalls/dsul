import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  THEME_PALETTES,
  DEFAULT_PALETTE,
  PALETTE_STORAGE_KEY,
  isThemePalette,
  paletteDef,
} from '@/lib/theme-palettes';

/**
 * The palette feature spans three files that cannot import each other: the TS
 * catalog, the CSS preset blocks in app/globals.css, and the pre-hydration
 * script inlined in app/layout.tsx. These are drift tests — the compiler can't
 * catch a palette that exists in the picker but has no CSS, or a storage key
 * the blocking script no longer reads.
 */

const globalsCss = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
const layoutTsx = readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8');

describe('theme palettes — catalog', () => {
  it('values are unique and slug-shaped', () => {
    const values = THEME_PALETTES.map((p) => p.value);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
  });

  it('default palette exists and leads the list', () => {
    expect(THEME_PALETTES[0].value).toBe(DEFAULT_PALETTE);
    expect(isThemePalette(DEFAULT_PALETTE)).toBe(true);
  });

  it('every palette carries a label and hex theme-colors for both modes', () => {
    for (const p of THEME_PALETTES) {
      expect(p.label.trim(), p.value).not.toBe('');
      expect(p.themeColor.light, p.value).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.themeColor.dark, p.value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('isThemePalette rejects non-members', () => {
    expect(isThemePalette('neon')).toBe(false);
    expect(isThemePalette(null)).toBe(false);
    expect(isThemePalette(42)).toBe(false);
  });

  it('paletteDef falls back to the default for the default slug', () => {
    expect(paletteDef('default').value).toBe('default');
  });
});

describe('theme palettes — CSS contract', () => {
  it('every non-default palette has BOTH mode-scoped blocks in globals.css', () => {
    for (const p of THEME_PALETTES) {
      if (p.value === 'default') continue;
      // Mode-scoping is load-bearing: the bare attribute selector is (0,2,0)
      // and would beat `.dark` (0,1,0), leaking light values into dark.
      expect(globalsCss, `${p.value} light block`).toContain(
        `:root[data-theme='${p.value}']:not(.dark)`
      );
      expect(globalsCss, `${p.value} dark block`).toContain(
        `:root[data-theme='${p.value}'].dark`
      );
    }
  });

  it('no CSS palette block exists for a slug missing from the catalog', () => {
    const known = new Set<string>(THEME_PALETTES.map((p) => p.value));
    for (const match of globalsCss.matchAll(/:root\[data-theme='([a-z0-9-]+)'\]/g)) {
      expect(known.has(match[1]), `CSS block for unlisted palette "${match[1]}"`).toBe(true);
    }
  });

  it('palette blocks never restate the lime accent — the brand is not per-palette', () => {
    // Slice from the first palette block to @theme inline and assert no
    // --lime-* definitions inside it.
    const start = globalsCss.indexOf("/* ── Preset palettes");
    const end = globalsCss.indexOf('@theme inline');
    expect(start).toBeGreaterThan(-1);
    const presetSection = globalsCss.slice(start, end);
    expect(presetSection).not.toMatch(/--lime-(solid|ink|tint)\s*:/);
  });
});

describe('theme palettes — Settings preview twins', () => {
  it('every palette block also matches a preview root tinted with it', () => {
    for (const p of THEME_PALETTES) {
      if (p.value === 'default') continue;
      expect(globalsCss, `${p.value} light twin`).toContain(
        `[data-theme-preview][data-preview-tint='${p.value}']:not(.dark),\n:root[data-theme='${p.value}']:not(.dark) {`
      );
      expect(globalsCss, `${p.value} dark twin`).toContain(
        `[data-theme-preview][data-preview-tint='${p.value}'].dark,\n:root[data-theme='${p.value}'].dark {`
      );
    }
  });

  it('every palette has a dot colour for the Tint picker', () => {
    for (const p of THEME_PALETTES) expect(p.swatch, p.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(THEME_PALETTES.map((p) => p.swatch)).size).toBe(THEME_PALETTES.length);
  });
});

describe('theme palettes — pre-hydration script contract', () => {
  it('the layout inline script reads the exported storage key', () => {
    expect(PALETTE_STORAGE_KEY).toBe('dsul-palette');
    expect(layoutTsx).toContain(`localStorage.getItem('${PALETTE_STORAGE_KEY}')`);
  });

  it('the reset escape hatch survives in the inline script', () => {
    expect(layoutTsx).toContain('reset-theme');
    expect(layoutTsx).toContain(`localStorage.removeItem('${PALETTE_STORAGE_KEY}')`);
  });
});
