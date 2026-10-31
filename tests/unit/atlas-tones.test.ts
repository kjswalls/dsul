import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import look from '../fixtures/organize/look.json';
import {
  ATLAS_TONES,
  TOKEN_TONE_FALLBACK,
  nearestTone,
  oklchToRgba,
  paleColor,
  parseCssColor,
  toneColor,
  toneForColor,
} from '@/lib/atlas-tones';

/**
 * The far zoom's colours: the six Aurora tones, and every stored container
 * colour mapped to its nearest one (design PR3).
 */

const tokens = (look as { tokens: { name: string; light: { l: number; c: number; h: number; hex: string }; dark: { l: number; c: number; h: number; hex: string } }[] }).tokens;
const ramp = tokens.filter((t) => /^accent-\d$/.test(t.name));

const EXPECTED: Record<string, string> = {
  'accent-1': 'green', // moss
  'accent-2': 'teal',
  'accent-3': 'indigo',
  'accent-4': 'indigo', // plum
  'accent-5': 'ember', // coral
  'accent-6': 'honey',
  'accent-7': 'teal', // slate
  'accent-8': 'lime',
};

describe('atlas tones', () => {
  it('reads the eight ramp tokens', () => {
    expect(ramp).toHaveLength(8);
  });

  it.each(ramp.map((t) => [t.name, t]))('maps %s to its nearest Aurora tone, on both themes and as hex', (name, t) => {
    const want = EXPECTED[name as string];
    const tok = t as (typeof ramp)[number];
    expect(nearestTone(`oklch(${tok.light.l} ${tok.light.c} ${tok.light.h})`)).toBe(want);
    expect(nearestTone(`oklch(${tok.dark.l} ${tok.dark.c} ${tok.dark.h})`)).toBe(want);
    expect(nearestTone(tok.light.hex)).toBe(want);
    // The production minifier's form.
    expect(nearestTone(`oklch(${tok.light.l * 100}% ${tok.light.c} ${tok.light.h})`)).toBe(want);
  });

  it('agrees with the fallback table for every shipped token, read out of globals.css', () => {
    const css = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');
    for (const [name, tone] of Object.entries(TOKEN_TONE_FALLBACK)) {
      const m = css.match(new RegExp(`${name}:\\s*(oklch\\([^)]*\\))`));
      expect(m, name).toBeTruthy();
      expect(nearestTone(m![1]), name).toBe(tone);
    }
  });

  it('keeps lime for lime only: moss is green', () => {
    expect(nearestTone('oklch(0.68 0.11 140)')).toBe('green');
    expect(nearestTone('oklch(0.78 0.14 125)')).toBe('lime');
  });

  it('maps legacy hex and rgb colours', () => {
    expect(nearestTone('#e5484d')).toBe('ember');
    expect(nearestTone('#3b82f6')).toBe('indigo');
    expect(nearestTone('#22c55e')).toBe('green');
    expect(nearestTone('#f5b400')).toBe('honey');
    expect(nearestTone('#0ea5a4')).toBe('teal');
    expect(nearestTone('#abc')).toBe(nearestTone('#aabbcc'));
    expect(nearestTone('rgb(229, 72, 77)')).toBe('ember');
    expect(nearestTone('nonsense')).toBe('teal');
  });

  it('resolves a var() through the island, else the fallback table', () => {
    expect(toneForColor('var(--accent-8)', () => 'oklch(0.76 0.13 125)')).toBe('lime');
    expect(toneForColor('var(--accent-8)', () => '')).toBe('lime');
    expect(toneForColor('var(--accent-5)')).toBe('ember');
    // A theme that re-tunes a token answers with its own value.
    expect(toneForColor('var(--accent-1)', () => 'oklch(0.7 0.12 272)')).toBe('indigo');
    expect(toneForColor('#22c55e')).toBe('green');
  });

  it('parses the forms the app writes', () => {
    expect(parseCssColor('oklch(0.68 0.11 140)')).toEqual({ L: 0.68, C: 0.11, h: 140 });
    expect(parseCssColor('oklch(68% 0.11 140)')).toEqual({ L: 0.68, C: 0.11, h: 140 });
    expect(parseCssColor('var(--accent-1)')).toBeNull();
    const white = parseCssColor('#ffffff')!;
    expect(white.L).toBeCloseTo(1, 3);
    expect(white.C).toBeCloseTo(0, 3);
  });

  it('draws Bloom deeper and more saturated than glow, and pale tints for paper', () => {
    expect(oklchToRgba(1, 0, 0)).toBe('rgba(255,255,255,1)');
    expect(oklchToRgba(0, 0, 0, 0.5)).toBe('rgba(0,0,0,0.5)');
    for (const k of Object.keys(ATLAS_TONES) as (keyof typeof ATLAS_TONES)[]) {
      const glow = parseCssColor(rgbHex(toneColor(k, 'glow')))!;
      const bloom = parseCssColor(rgbHex(toneColor(k, 'bloom')))!;
      expect(bloom.L, k).toBeLessThan(glow.L);
      expect(paleColor(k, 0.5)).toMatch(/,0\.5\)$/);
    }
  });
});

function rgbHex(rgba: string): string {
  const [r, g, b] = rgba.match(/\d+/g)!.map(Number);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
