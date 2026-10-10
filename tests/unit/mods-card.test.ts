import { describe, it, expect } from 'vitest';
import { cardPanelOf } from '@/lib/mods/ui/card';
import { surfaceStateOf } from '@/lib/mods/ui/surface-state';
import type { UserMod } from '@/lib/mods/schema';

/**
 * lib/mods/ui/card.ts (which panel the braindump card shows) and
 * lib/mods/ui/surface-state.ts (what a mod surface shows, from the row and
 * the sandbox, never from the runner slot).
 */

const panels = (card: boolean) => [{ id: 'main', label: 'Main', ...(card && { card: true }) }];

const mod = (id: string, over: Partial<UserMod> = {}, card = true): UserMod => ({
  id,
  userId: 'u',
  kind: 'mod',
  slug: id,
  name: id,
  enabled: true,
  manifest: { version: 1, uses: ['ui'], commands: [], panels: panels(card) },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  ...over,
});

describe('cardPanelOf', () => {
  it('picks the earliest-created switched-on mod with a card panel', () => {
    const rows = [
      mod('b', { createdAt: '2026-03-02T00:00:00Z' }),
      mod('a', { createdAt: '2026-03-01T00:00:00Z' }),
      mod('c', { createdAt: '2026-03-03T00:00:00Z' }),
    ];
    expect(cardPanelOf(rows)).toMatchObject({ modId: 'a', panelId: 'main' });
  });

  it('skips switched-off mods, mods with no card panel, and other kinds', () => {
    const rows = [
      mod('off', { enabled: false, createdAt: '2026-01-01T00:00:00Z' }),
      mod('plain', { createdAt: '2026-01-02T00:00:00Z' }, false),
      mod('recipe', { kind: 'recipe', createdAt: '2026-01-03T00:00:00Z' }),
      mod('late', { createdAt: '2026-04-01T00:00:00Z' }),
    ];
    expect(cardPanelOf(rows)?.modId).toBe('late');
    expect(cardPanelOf([rows[0], rows[1]])).toBeNull();
  });

  it('ignores a manifest that no longer parses', () => {
    expect(cardPanelOf([mod('x', { manifest: { version: 1, uses: [], panels: panels(true) } })])).toBeNull();
  });
});

describe('surfaceStateOf', () => {
  const ref = { modId: 'a', panelId: 'main' };
  const ctx = { rows: [mod('a')], safeMode: false, sandboxStatus: 'ready' as const, panel: undefined };

  it('is absent in safe mode, with no ref, or for a panel the mod no longer declares', () => {
    expect(surfaceStateOf(ref, { ...ctx, safeMode: true })).toBe('absent');
    expect(surfaceStateOf(null, ctx)).toBe('absent');
    expect(surfaceStateOf({ modId: 'a', panelId: 'gone' }, ctx)).toBe('absent');
  });

  it('is off when the row is gone or switched off', () => {
    expect(surfaceStateOf(ref, { ...ctx, rows: [] })).toBe('off');
    expect(surfaceStateOf(ref, { ...ctx, rows: [mod('a', { enabled: false })] })).toBe('off');
  });

  it('is unavailable when the sandbox cannot run or this tab is older than the deploy', () => {
    expect(surfaceStateOf(ref, { ...ctx, sandboxStatus: 'unavailable' })).toBe('unavailable');
    expect(surfaceStateOf(ref, { ...ctx, sandboxStatus: 'outdated' })).toBe('unavailable');
  });

  it('is otherwise the panel’s status, and loading before there is one', () => {
    expect(surfaceStateOf(ref, ctx)).toBe('loading');
    expect(surfaceStateOf(ref, { ...ctx, sandboxStatus: 'idle' })).toBe('loading');
    for (const panel of ['ok', 'error', 'empty', 'loading'] as const) {
      expect(surfaceStateOf(ref, { ...ctx, panel })).toBe(panel);
    }
  });
});
