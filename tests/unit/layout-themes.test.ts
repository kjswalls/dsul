import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_LAYOUT,
  LAYOUTS,
  LAYOUT_FAMILIES,
  LAYOUT_ORNAMENTS,
  LAYOUT_SLOTS,
  LAYOUT_STORAGE_KEY,
  STYLED_SLOTS,
  isLayoutTheme,
  layoutAttributes,
  layoutDef,
  layoutStyles,
  type LayoutSlot,
} from '@/lib/layout-themes';
import { DARK_LOOKS, LIGHT_LOOKS } from '@/lib/theme-looks';

/**
 * A layout is config: a variant per slot from a closed list. These tests are
 * what make the list closed — a layout naming a variant nothing draws, a CSS
 * rule for a variant the catalog doesn't list, or a structural variant the
 * shell never reads all fail here rather than shipping a silent no-op.
 */

const root = process.cwd();
const globalsCss = readFileSync(join(root, 'app', 'globals.css'), 'utf8');
const layoutTsx = readFileSync(join(root, 'app', 'layout.tsx'), 'utf8');
const shellTsx = readFileSync(join(root, 'components', 'shell', 'desktop-shell.tsx'), 'utf8');

const SLOTS = Object.keys(LAYOUT_SLOTS) as LayoutSlot[];
const STRUCTURAL = SLOTS.filter((s) => !(STYLED_SLOTS as readonly string[]).includes(s));

describe('layouts — catalog', () => {
  it('values are unique and slug-shaped, and Classic leads as the default', () => {
    const values = LAYOUTS.map((l) => l.value);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect(LAYOUTS[0].value).toBe(DEFAULT_LAYOUT);
    expect(isLayoutTheme('console')).toBe(true);
    expect(isLayoutTheme('notebook-v9')).toBe(false);
    expect(isLayoutTheme(null)).toBe(false);
  });

  it('every layout picks a variant the slot actually has, for every slot', () => {
    for (const layout of LAYOUTS) {
      expect(Object.keys(layout.slots).sort(), layout.value).toEqual([...SLOTS].sort());
      for (const slot of SLOTS) {
        expect(LAYOUT_SLOTS[slot] as readonly string[], `${layout.value}.${slot}`).toContain(
          layout.slots[slot]
        );
      }
      for (const o of layout.ornaments) {
        expect(LAYOUT_ORNAMENTS as readonly string[], `${layout.value} ornament`).toContain(o);
      }
    }
  });

  it('the default layout is every slot at its default, with nothing added', () => {
    const classic = LAYOUTS[0];
    for (const slot of SLOTS) expect(classic.slots[slot], slot).toBe(LAYOUT_SLOTS[slot][0]);
    expect(classic.ornaments).toEqual([]);
    expect(layoutAttributes(classic)).toEqual({ 'data-layout': DEFAULT_LAYOUT });
  });

  it('a pairing names a colour theme that exists, in the right mode', () => {
    for (const layout of LAYOUTS) {
      const { light, dark } = layout.pairsWith;
      if (light) expect(LIGHT_LOOKS.map((l) => l.value), layout.value).toContain(light);
      if (dark) expect(DARK_LOOKS.map((l) => l.value), layout.value).toContain(dark);
    }
  });

  it('every variant some layout uses is used — no slot carries a dead variant', () => {
    for (const slot of SLOTS) {
      for (const variant of LAYOUT_SLOTS[slot]) {
        expect(LAYOUTS.some((l) => l.slots[slot] === variant), `${slot}: ${variant}`).toBe(true);
      }
    }
  });
});

describe('layouts — families and styles', () => {
  it('every family names a lead that is its own family, listed before its styles', () => {
    for (const layout of LAYOUTS) {
      const lead = layoutDef(layout.family);
      expect(lead.value, layout.value).toBe(layout.family);
      expect(lead.family, layout.value).toBe(lead.value);
      expect(LAYOUTS.indexOf(lead), layout.value).toBeLessThanOrEqual(LAYOUTS.indexOf(layout));
    }
    expect(LAYOUT_FAMILIES.map((l) => l.value)).toEqual(['classic', 'console', 'notebook', 'notepad', 'writer']);
  });

  it('a family with styles names every one of them, and a lone layout names none', () => {
    for (const family of LAYOUT_FAMILIES) {
      const styles = layoutStyles(family.value);
      if (styles.length > 1) {
        const labels = styles.map((l) => l.styleLabel);
        for (const label of labels) expect(label, family.value).toBeTruthy();
        expect(new Set(labels).size, family.value).toBe(labels.length);
      } else {
        expect(family.styleLabel, family.value).toBeUndefined();
      }
    }
    expect(layoutStyles('notepad').map((l) => l.styleLabel)).toEqual(['Quiet', 'Markdown', 'Retro']);
  });

  it('only one family has styles, because Settings lists them statically', () => {
    // look.layoutStyle's options are every styled layout at once. A second
    // family with styles would show its styles under the first one's Layout;
    // give the record per-family options before adding one.
    const styled = LAYOUT_FAMILIES.filter((f) => layoutStyles(f.value).length > 1);
    expect(styled.map((f) => f.value)).toEqual(['notepad']);
  });
});

describe('layouts — drawn somewhere', () => {
  it('every non-default styled variant has its rule, scoped to the shell stamp', () => {
    for (const slot of STYLED_SLOTS) {
      for (const variant of LAYOUT_SLOTS[slot].slice(1)) {
        expect(globalsCss, `${slot}=${variant}`).toContain(`[data-layout-${slot}='${variant}']`);
      }
    }
  });

  it('no rule keys on a slot or variant the catalog does not list, or on <html>', () => {
    for (const m of globalsCss.matchAll(/(\S*)\[data-layout-([a-z]+)='([a-z0-9-]+)'\]/g)) {
      const [, before, slot, variant] = m;
      expect(STYLED_SLOTS as readonly string[], slot).toContain(slot);
      expect(LAYOUT_SLOTS[slot as LayoutSlot] as readonly string[], `${slot}=${variant}`).toContain(variant);
      // Keyed on the shell's root, which the phone never renders.
      expect(before, m[0]).not.toMatch(/:root|html/);
    }
  });

  it('the desktop shell reads every structural slot and stamps the styled ones', () => {
    for (const slot of STRUCTURAL) expect(shellTsx, slot).toContain(`slots.${slot}`);
    expect(shellTsx).toContain('layoutAttributes(layout)');
    for (const o of LAYOUT_ORNAMENTS) expect(shellTsx, o).toContain(`'${o}'`);
  });

  it('?reset-theme clears the layout too', () => {
    expect(layoutTsx).toMatch(
      new RegExp(`reset-theme[^"]*localStorage\\.removeItem\\('${LAYOUT_STORAGE_KEY}'\\)`)
    );
  });
});
