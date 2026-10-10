import { describe, expect, it } from 'vitest';

import { EXT_DO_STUFF, EXT_ORGANIZE, EXT_STREAKS, OFFICIAL_EXTENSIONS } from '@/lib/extension-registry';

/**
 * The default-on rule (lib/extension-registry.ts, the note on `defaultEnabled`).
 *
 * An extension may start on only if it is QUIET UNTIL USED (a fresh account's
 * screen looks the same as with it off, until the user does the thing it is
 * for) and brings NO NEW IDEA to learn. Never one that reaches out of the app or
 * costs money. Everything that starts on is weight carried by every new user,
 * so the list is frozen here: adding an entry fails this test until someone
 * writes down how it passes.
 */
const DEFAULT_ON: Record<string, string> = {
  [EXT_ORGANIZE]:
    'A console you open from the sidebar or ⌘K; nothing on the planner changes until you open it, and it holds the containers you already have.',
  [EXT_DO_STUFF]:
    'Draws nothing on a short or unsized braindump; its one row appears only once the list is long, and a size shows only after you give one.',
};

describe('extensions that start on', () => {
  it('are exactly the frozen list, each with how it passes the rule', () => {
    const on = OFFICIAL_EXTENSIONS.filter((e) => e.defaultEnabled).map((e) => e.slug);
    expect(on.sort()).toEqual(Object.keys(DEFAULT_ON).sort());
  });

  it('never include anything that reaches out of the app or costs money', () => {
    for (const e of OFFICIAL_EXTENSIONS.filter((x) => x.defaultEnabled)) {
      expect(e.shelf, e.slug).not.toBe('reach');
      expect(e.shelf, e.slug).not.toBe('stakes');
      expect(e.costs, e.slug).toBeUndefined();
      expect(e.needs, e.slug).toBeUndefined();
    }
  });

  it('leave Streaks off, since a chain on screen can read as guilt (Kirby, 2026-10-10)', () => {
    expect(OFFICIAL_EXTENSIONS.find((e) => e.slug === EXT_STREAKS)?.defaultEnabled).toBe(false);
  });
});
