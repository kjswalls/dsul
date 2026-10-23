import { describe, it, expect } from 'vitest';
import { BookOpen, Briefcase, Dumbbell, Flame, Footprints, Inbox, Sunrise, Target } from 'lucide-react';
import {
  ALL_ICON_ENTRIES,
  CATEGORY_ICON_NAMES,
  FEATURED_ICON_NAMES,
  KEYWORD_ICON_NAMES,
  NAME_ICON_NAMES,
  categoryIconName,
  getCategoryIcon,
  getIconByName,
  hashName,
  isIconName,
  makeIconToken,
  resolveCategoryIcon,
  resolveCategoryIconName,
} from '@/lib/category-icons';

/**
 * lib/category-icons.ts states the glyph derivation in library NAMES
 * (categoryIconName, resolveCategoryIconName), which the iPhone ports, and the
 * Lucide components the web draws are lookups over those names. These hold
 * the two to each other, so the phone's glyph and the web's can never differ
 * for one container.
 */

/** Names and glyphs the derivation meets: defaults, keywords, the hash, and the awkward ones. */
const NAMES = [
  'Work',
  'work',
  '  WORK  ',
  'Wellness',
  'Personal',
  'Tasks',
  'Habits',
  'No project',
  'Anytime',
  'Gym days',
  'Morning run',
  'Bookkeeping',
  'Finance',
  'Errands',
  'Autumn',
  'Café',
  'Cafe\u0301',
  '🏃 Club',
  '日本語',
  'evadgrga',
  '',
  ' ',
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
];
const GLYPHS = [
  null,
  undefined,
  '',
  '📋',
  'icon:Sunrise',
  'icon:sunrise',
  'icon:CalendarRange',
  'icon:constructor',
  'icon:',
  'icon',
  ...FEATURED_ICON_NAMES.map(makeIconToken),
];

describe('category icons: the components are lookups over the names', () => {
  it('getCategoryIcon is the library icon categoryIconName names', () => {
    for (const name of NAMES) {
      const derived = categoryIconName(name);
      expect(isIconName(derived), `${JSON.stringify(name)} → ${derived}`).toBe(true);
      expect(getCategoryIcon(name), JSON.stringify(name)).toBe(getIconByName(derived));
    }
  });

  it('resolveCategoryIcon is the library icon resolveCategoryIconName names', () => {
    for (const glyph of GLYPHS) {
      for (const name of NAMES) {
        const resolved = resolveCategoryIconName(glyph, name);
        expect(isIconName(resolved)).toBe(true);
        expect(resolveCategoryIcon(glyph, name), `${String(glyph)} / ${JSON.stringify(name)}`).toBe(getIconByName(resolved));
      }
    }
  });

  it('draws the icons it always drew', () => {
    expect(getCategoryIcon('Work')).toBe(Briefcase);
    expect(getCategoryIcon(' no project ')).toBe(Inbox);
    expect(getCategoryIcon('Gym days')).toBe(Dumbbell);
    // First keyword wins: 'run' is listed before 'morning'.
    expect(getCategoryIcon('Morning run')).toBe(Footprints);
    expect(getCategoryIcon('Bookkeeping')).toBe(BookOpen);
    // 2^31 % 30 is 8.
    expect(getCategoryIcon('evadgrga')).toBe(Flame);
    expect(resolveCategoryIcon('icon:Sunrise', 'Work')).toBe(Sunrise);
    expect(resolveCategoryIcon('icon:Target', 'Anything')).toBe(Target);
    // Not in the library: derived from the name, as the web's default season glyph is.
    expect(resolveCategoryIcon('icon:CalendarRange', 'Work')).toBe(Briefcase);
    expect(resolveCategoryIcon('📋', 'Work')).toBe(Briefcase);
  });

  it('answers only the library’s own names, never an object key', () => {
    expect(getIconByName('constructor')).toBeUndefined();
    expect(getIconByName('toString')).toBeUndefined();
    expect(getIconByName('__proto__')).toBeUndefined();
    expect(isIconName('Sunrise')).toBe(true);
    expect(isIconName('sunrise')).toBe(false);
    expect(categoryIconName('constructor')).toBe(CATEGORY_ICON_NAMES[hashName('constructor') % CATEGORY_ICON_NAMES.length]);
    expect(resolveCategoryIconName('icon:constructor', 'Work')).toBe('Briefcase');
  });
});

describe('category icons: the tables', () => {
  const library = new Set(ALL_ICON_ENTRIES.map(([name]) => name));

  it('every name a derivation or the picker can give is in the library', () => {
    for (const name of [
      ...CATEGORY_ICON_NAMES,
      ...Object.values(NAME_ICON_NAMES),
      ...KEYWORD_ICON_NAMES.map(([, icon]) => icon),
      ...FEATURED_ICON_NAMES,
    ]) {
      expect(library.has(name), name).toBe(true);
    }
  });

  it('keeps the hash at 30 icons, so a name keeps its glyph', () => {
    // Changing the length re-derives every unpicked glyph on both devices.
    expect(CATEGORY_ICON_NAMES).toHaveLength(30);
  });

  it('hashes as JS does: UTF-16 code units, ToInt32, and Math.abs past int32', () => {
    expect(hashName('')).toBe(5381);
    expect(hashName('a')).toBe(177604);
    expect(hashName('evadgrga')).toBe(2 ** 31);
    // An astral character is two code units.
    expect(hashName('🏃')).toBe(Math.abs(((5381 * 33) ^ 0xd83c) * 33 ^ 0xdfc3));
  });
});
