import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * "Run recipe: <name>" in ⌘K (lib/commands/registry.ts recipeCommands,
 * memory/plans/mods.md "Commands"): only switched-on recipes whose trigger is
 * ⌘K, ids `mod.<slug>.run`, the 'mods' group, no shortcut, no alias, memoised
 * on the rows, nothing in safe mode, and a run goes to the engine.
 */

const run = vi.hoisted(() => vi.fn());
vi.mock('@/lib/recipes/command-run', () => ({ runRecipeCommand: run, setRecipeCommandRunner: vi.fn() }));

import { COMMAND_GROUPS, type CommandContext } from '@/lib/commands/types';
import { STATIC_COMMANDS, resolveCommands } from '@/lib/commands/registry';
import { useModsStore } from '@/lib/mods-store';
import { getCustomTypeDefs, hydrateCustomTypes } from '@/lib/item-registry';
import type { UserMod } from '@/lib/mods/schema';

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u1',
  isMobile: false,
};

const row = (slug: string, on: string, over: Partial<UserMod> = {}): UserMod => ({
  id: crypto.randomUUID(),
  userId: 'u1',
  kind: 'recipe',
  slug,
  name: slug.toUpperCase(),
  enabled: true,
  manifest: { version: 1, trigger: { on }, filters: {}, steps: [{ do: 'toast', text: 'x' }] },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  ...over,
});

const recipeCommands = () => resolveCommands(ctx).filter((c) => c.id.startsWith('mod.'));

beforeEach(() => {
  run.mockClear();
  useModsStore.setState({ available: true, loaded: true, safeMode: false, rows: [] });
});

describe('recipe commands', () => {
  it('lists only switched-on ⌘K recipes, plainly', () => {
    useModsStore.setState({
      rows: [
        row('morning', 'command'),
        row('off', 'command', { enabled: false }),
        row('tick', 'item.completed'),
        row('broken', 'command', { manifest: { version: 1 } }),
        row('moss', 'command', { kind: 'theme' }),
      ],
    });
    const commands = recipeCommands();
    expect(commands.map((c) => c.id)).toEqual(['mod.morning.run']);
    expect(commands[0]).toMatchObject({ label: 'Run recipe: MORNING', group: 'mods' });
    expect(commands[0].shortcut).toBeUndefined();
    expect(commands[0].aliases).toBeUndefined();
    expect(COMMAND_GROUPS.some((g) => g.id === 'mods')).toBe(true);
  });

  it('is memoised on the rows, and empty in safe mode or without the table', () => {
    useModsStore.setState({ rows: [row('a', 'command')] });
    expect(recipeCommands()[0]).toBe(recipeCommands()[0]);
    useModsStore.setState({ safeMode: true });
    expect(recipeCommands()).toEqual([]);
    useModsStore.setState({ safeMode: false, available: false });
    expect(recipeCommands()).toEqual([]);
  });

  it('a recipe that adds a custom type appears once that type has loaded, with the same rows', () => {
    const before = getCustomTypeDefs();
    hydrateCustomTypes([]);
    const errand = row('errands', 'command', {
      manifest: { version: 1, trigger: { on: 'command' }, filters: {}, steps: [{ do: 'create', type: 'errand', title: 'Post' }] },
    });
    useModsStore.setState({ rows: [errand] });
    expect(recipeCommands()).toEqual([]);
    hydrateCustomTypes([{ id: 'it-1', name: 'errand', label: 'Errand', labelPlural: 'Errands' } as never]);
    expect(recipeCommands().map((c) => c.id)).toEqual(['mod.errands.run']);
    hydrateCustomTypes(before);
  });

  it('runs through the engine, and greys once switched off', () => {
    const r = row('a', 'command');
    useModsStore.setState({ rows: [r] });
    const [command] = recipeCommands();
    command.run(ctx);
    expect(run).toHaveBeenCalledWith(r.id);
    useModsStore.setState({ rows: [{ ...r, enabled: false }] });
    expect(command.availableWhen?.(ctx)).toBe(false);
  });

  it('drops a duplicate id, first one wins', () => {
    const first = row('same', 'command');
    useModsStore.setState({ rows: [first, row('same', 'command', { name: 'Second' })] });
    const commands = recipeCommands();
    expect(commands).toHaveLength(1);
    commands[0].run(ctx);
    expect(run).toHaveBeenCalledWith(first.id);
  });

  it('owns no shortcut: only the static list does', () => {
    useModsStore.setState({ rows: [row('a', 'command')] });
    const bound = resolveCommands(ctx).filter((c) => c.shortcut);
    expect(bound.every((c) => STATIC_COMMANDS.includes(c))).toBe(true);
  });
});
