import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A mod's ⌘K commands (lib/commands/registry.ts modCommands, PR 8 spec §9):
 * one per command in a switched-on mod's stored manifest, ids
 * `mod.<slug>.<id>`, "Your mod · <name>: <label>" in the 'mods' group, no
 * shortcut, no alias, nothing in safe mode or without the table, and a run
 * goes through ModHost's slot.
 */

const run = vi.hoisted(() => vi.fn());
vi.mock('@/lib/mods/command-run', () => ({ runModCommand: run, setModCommandRunner: vi.fn() }));

import type { CommandContext } from '@/lib/commands/types';
import { STATIC_COMMANDS, resolveCommands } from '@/lib/commands/registry';
import { useModsStore } from '@/lib/mods-store';
import type { UserMod } from '@/lib/mods/schema';

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u1',
  isMobile: false,
};

const WATER = {
  version: 1,
  uses: ['storage', 'ui'],
  commands: [
    { id: 'add', label: 'Add a glass', keywords: ['water', 'drink'] },
    { id: 'reset', label: 'Start over' },
  ],
};

const row = (slug: string, over: Partial<UserMod> = {}): UserMod => ({
  id: crypto.randomUUID(),
  userId: 'u1',
  kind: 'mod',
  slug,
  name: 'Water',
  enabled: true,
  manifest: WATER,
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  ...over,
});

const modCommands = () => resolveCommands(ctx).filter((c) => c.id.startsWith('mod.'));

beforeEach(() => {
  run.mockClear();
  useModsStore.setState({ available: true, loaded: true, safeMode: false, rows: [] });
});

describe('mod commands', () => {
  it('lists each command of a switched-on mod, under host chrome', () => {
    useModsStore.setState({ rows: [row('water')] });
    const commands = modCommands();
    expect(commands.map((c) => c.id)).toEqual(['mod.water.add', 'mod.water.reset']);
    expect(commands[0]).toMatchObject({
      label: 'Your mod · Water: Add a glass',
      description: 'Your mod',
      group: 'mods',
      keywords: 'water drink',
    });
    for (const c of commands) {
      expect(c.shortcut).toBeUndefined();
      expect(c.aliases).toBeUndefined();
    }
  });

  it('is empty in safe mode or without the table, and memoised on the rows', () => {
    useModsStore.setState({ rows: [row('water')] });
    expect(modCommands()[0]).toBe(modCommands()[0]);
    useModsStore.setState({ safeMode: true });
    expect(modCommands()).toEqual([]);
    useModsStore.setState({ safeMode: false, available: false });
    expect(modCommands()).toEqual([]);
  });

  it('switched-off mods and invalid manifests give nothing', () => {
    useModsStore.setState({
      rows: [
        row('off', { enabled: false }),
        row('bad', { manifest: { version: 1, uses: [], commands: [], panels: [] } }),
        row('run', { manifest: { version: 1, uses: [], commands: [{ id: 'run', label: 'Go' }] } }),
        row('recipe', { kind: 'recipe' }),
      ],
    });
    expect(modCommands()).toEqual([]);
  });

  it('a name that fails the label rule shows the slug', () => {
    useModsStore.setState({ rows: [row('water', { name: 'Sign in' })] });
    expect(modCommands()[0].label).toBe('Your mod · water: Add a glass');
  });

  it('runs through the slot, and greys once switched off', () => {
    const r = row('water');
    useModsStore.setState({ rows: [r] });
    const [command] = modCommands();
    command.run(ctx);
    expect(run).toHaveBeenCalledWith(r.id, 'add');
    useModsStore.setState({ rows: [{ ...r, enabled: false }] });
    expect(command.availableWhen?.(ctx)).toBe(false);
  });

  it('drops a duplicate id, first one wins, and owns no shortcut', () => {
    const first = row('same');
    useModsStore.setState({ rows: [first, row('same', { name: 'Other' })] });
    const commands = modCommands();
    expect(commands).toHaveLength(2);
    commands[0].run(ctx);
    expect(run).toHaveBeenCalledWith(first.id, 'add');
    const bound = resolveCommands(ctx).filter((c) => c.shortcut);
    expect(bound.every((c) => STATIC_COMMANDS.includes(c))).toBe(true);
  });
});
