import { describe, it, expect } from 'vitest';
import { THEME_BASES, type ThemeBaseId } from '@/lib/mods/theme-bases';
import { contrastWarnings, resolvedColor } from '@/lib/mods/theme-contrast';
import { printColor } from '@/lib/mods/color';

/** The contrast check a user theme gets (lib/mods/theme-contrast.ts). */

describe('contrast warnings', () => {
  it.each(Object.keys(THEME_BASES) as ThemeBaseId[])('the built-in %s passes every pair', (id) => {
    expect(contrastWarnings({ mode: THEME_BASES[id].mode, base: id, tokens: {} })).toEqual([]);
  });

  it('white on Paper’s lime warns about text on the accent', () => {
    const warnings = contrastWarnings({ mode: 'light', base: 'paper', tokens: { primaryForeground: '#ffffff' } });
    expect(warnings.map((w) => w.label)).toEqual(['Text on the accent']);
    expect(warnings[0].ratio).toBeLessThan(4.5);
  });

  it('checks the sidebar, secondary text on cards and, in light, the accent wash', () => {
    const sidebar = contrastWarnings({ mode: 'light', base: 'paper', tokens: { paper1: '#666666' } }).map((w) => w.label);
    expect(sidebar).toContain('Text in the sidebar');
    const cards = contrastWarnings({ mode: 'dark', base: 'night', tokens: { paper3: '#888888' } }).map((w) => w.label);
    expect(cards).toContain('Secondary text on cards');
    const wash = contrastWarnings({ mode: 'light', base: 'paper', tokens: { limeTint: '#556655' } }).map((w) => w.label);
    expect(wash).toEqual(['Accent text on the accent wash']);
  });

  it('light grey ink on white warns', () => {
    const labels = contrastWarnings({ mode: 'light', base: 'studio', tokens: { ink0: '#dddddd' } }).map((w) => w.label);
    expect(labels).toContain('Text on the page');
  });

  it('Paper’s chained foreground resolves through the theme’s accent text', () => {
    const tokens = { limeInk: '#123456' };
    expect(printColor(resolvedColor({ base: 'paper', tokens }, 'primaryForeground')!)).toBe('#123456');
    // ...so a pale accent text warns on the fill, though the foreground was never set.
    const pale = contrastWarnings({ mode: 'light', base: 'paper', tokens: { limeInk: '#e0f0c0' } }).map((w) => w.label);
    expect(pale).toContain('Text on the accent');
  });
});
