import { describe, expect, it } from 'vitest';
import { ATLAS_COPY, atlasCopyStrings } from '@/lib/atlas-copy';
import { ATLAS_LAYOUT_OPTIONS, SCOPE_OPTIONS } from '@/lib/view-options';
import { STATIC_COMMANDS } from '@/lib/commands';

/**
 * Atlas's words: one module, scanned. No dashes (commas, colons, "to"), no
 * "Beacon", no ⌘ or "Cmd" (keys are drawn per platform by chordLabel), and
 * nothing that reads as guilt.
 */
describe('atlas copy', () => {
  const strings = atlasCopyStrings();

  it('scans something', () => {
    expect(strings.length).toBeGreaterThan(20);
  });

  it.each([
    ['an em dash', /—/],
    ['an en dash', /–/],
    ['Beacon', /beacon/i],
    ['⌘', /⌘/],
    ['Cmd', /\bcmd\b/i],
    ['overdue', /overdue/i],
    ['stalled', /stalled/i],
  ])('has no %s', (_name, re) => {
    expect(strings.filter((s) => re.test(s))).toEqual([]);
  });

  it('is where the Scope and layout options take their words', () => {
    expect(SCOPE_OPTIONS.find((o) => o.value === 'atlas')?.label).toBe(ATLAS_COPY.name);
    expect(ATLAS_LAYOUT_OPTIONS.map((o) => o.label)).toEqual([ATLAS_COPY.layoutMap]);
  });

  it('is where the registry rows with an atlas id take theirs', () => {
    const rows = STATIC_COMMANDS.filter((c) => /atlas/i.test(c.id));
    expect(rows.length).toBeGreaterThan(0);
    const words = new Set(strings);
    for (const c of rows) {
      expect(words.has(c.label), c.id).toBe(true);
      if (c.description) expect(words.has(c.description), c.id).toBe(true);
    }
  });
});
