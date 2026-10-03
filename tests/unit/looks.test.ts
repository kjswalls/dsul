import { describe, it, expect } from 'vitest';
import { LAYOUTS, isLayoutTheme, layoutDef } from '@/lib/layout-themes';
import { darkLookDef, lightLookDef } from '@/lib/theme-looks';
import { LOOKS, lookBlurb, lookChanges, lookColours, lookHasOwnColours, lookState } from '@/lib/looks';

/**
 * A Look is a layout with the colours it was made with (lib/looks.ts). Its
 * colours are the layout's pairsWith, so the card, the "for <Layout>" marks on
 * the swatches and a tap can never say three different things.
 */

const shipped = { layout: 'classic', light: 'paper', dark: 'night' } as const;

describe('the Looks catalog', () => {
  it('names real layouts, once each, with unique ids', () => {
    const ids = LOOKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const layouts = LOOKS.map((l) => l.layout);
    expect(new Set(layouts).size).toBe(layouts.length);
    for (const look of LOOKS) expect(isLayoutTheme(look.layout), look.id).toBe(true);
  });

  it('leads with dsul, the shipped look: Classic on Paper and Night', () => {
    expect(LOOKS[0]).toMatchObject({ id: 'dsul', layout: 'classic' });
    expect(lookColours(LOOKS[0])).toEqual({ light: 'paper', dark: 'night' });
    expect(lookState(LOOKS[0], shipped)).toBe('on');
  });

  it('every look either pairs with a theme or brings its own colours', () => {
    // A look that set nothing but a layout would be the Layout row twice.
    for (const look of LOOKS) {
      const { light, dark } = lookColours(look);
      expect(Boolean(light || dark) || lookHasOwnColours(look), look.id).toBe(true);
    }
  });

  it('a style is part of a look: Retro is Notepad drawn its own way', () => {
    const retro = LOOKS.find((l) => l.id === 'retro')!;
    expect(layoutDef(retro.layout).styleLabel).toBe('Retro');
    expect(lookHasOwnColours(retro)).toBe(true);
    // Notepad Quiet is not Retro, though they are one family.
    expect(lookState(retro, { ...shipped, layout: 'notepad' })).toBe('off');
    expect(lookState(retro, { ...shipped, layout: 'notepad-retro' })).toBe('on');
  });
});

describe('a look is on, edited or off', () => {
  const console_ = LOOKS.find((l) => l.id === 'console')!;

  it('is off on any other layout, whatever the colours', () => {
    expect(lookState(console_, { ...shipped, dark: 'terminal' })).toBe('off');
  });

  it('is edited when a colour it set has moved, and only those', () => {
    expect(lookState(console_, { layout: 'console', light: 'paper', dark: 'night' })).toBe('edited');
    // Console says nothing about the day, so any light theme leaves it on.
    expect(lookState(console_, { layout: 'console', light: 'sorbet', dark: 'terminal' })).toBe('on');
  });
});

describe('what a tap changes', () => {
  it('the exact layout, and the theme for each mode the layout pairs with', () => {
    const notebook = LOOKS.find((l) => l.id === 'notebook')!;
    expect(lookChanges(notebook)).toEqual({ layout: 'notebook', light: 'paper' });
    const retro = LOOKS.find((l) => l.id === 'retro')!;
    expect(lookChanges(retro)).toEqual({ layout: 'notepad-retro' });
  });
});

describe('the card line', () => {
  it('names the colours a tap sets, from the pairing itself', () => {
    for (const look of LOOKS) {
      const blurb = lookBlurb(look);
      const { light, dark } = lookColours(look);
      if (light) expect(blurb, look.id).toContain(lightLookDef(light).label);
      if (dark) expect(blurb, look.id).toContain(darkLookDef(dark).label);
      // No em dashes in app copy.
      expect(blurb).not.toContain('—');
    }
    expect(lookBlurb(LOOKS.find((l) => l.id === 'console')!)).toBe(
      'Terminal at night, your light by day'
    );
    expect(lookBlurb(LOOKS.find((l) => l.id === 'retro')!)).toBe('Notepad in its own colours');
  });

  it('every layout with a pairing has a look, so no pairing goes unoffered', () => {
    const offered = new Set(LOOKS.map((l) => l.layout));
    for (const layout of LAYOUTS) {
      const { light, dark } = layout.pairsWith;
      if (light || dark) expect(offered.has(layout.value), layout.value).toBe(true);
    }
  });
});
