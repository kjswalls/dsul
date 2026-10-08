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
const openPanel = vi.hoisted(() => vi.fn());
vi.mock('@/lib/mods/ui/open-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mods/ui/open-panel')>()),
  openModPanel: openPanel,
}));

import type { CommandContext } from '@/lib/commands/types';
import { STATIC_COMMANDS, resolveCommands } from '@/lib/commands/registry';
import { useModsStore } from '@/lib/mods-store';
import { useRailStore } from '@/lib/rail-store';
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

/** A mod's own commands and its panel openers; `mod.close-panel` is the host's. */
const modCommands = () => resolveCommands(ctx).filter((c) => c.id.startsWith('mod.') && c.id !== 'mod.close-panel');
const closePanel = () => resolveCommands(ctx).find((c) => c.id === 'mod.close-panel');

const WITH_PANELS = {
  ...WATER,
  panels: [
    { id: 'water', label: 'Water', icon: 'CupSoda', card: true },
    { id: 'log', label: 'Log' },
  ],
};

beforeEach(() => {
  run.mockClear();
  openPanel.mockClear();
  useRailStore.getState().reset();
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

describe('mod panel commands (build order 9)', () => {
  it('one opener per panel of a switched-on mod, after its commands, under host chrome', () => {
    useModsStore.setState({ rows: [row('water', { manifest: WITH_PANELS }), row('off', { enabled: false, manifest: WITH_PANELS })] });
    const commands = modCommands();
    expect(commands.map((c) => c.id)).toEqual([
      'mod.water.add',
      'mod.water.reset',
      'mod.water.open.water',
      'mod.water.open.log',
    ]);
    expect(commands[2]).toMatchObject({
      label: 'Your mod · Water: Open Water',
      description: 'Your mod',
      group: 'mods',
    });
    expect(commands[3].label).toBe('Your mod · Water: Open Log');
    for (const c of commands) {
      expect(c.shortcut).toBeUndefined();
      expect(c.aliases).toBeUndefined();
    }
  });

  it('opens through the router', () => {
    const r = row('water', { manifest: WITH_PANELS });
    useModsStore.setState({ rows: [r] });
    modCommands()
      .find((c) => c.id === 'mod.water.open.log')!
      .run(ctx);
    expect(openPanel).toHaveBeenCalledWith({ modId: r.id, panelId: 'log' });
  });

  it('none in safe mode', () => {
    useModsStore.setState({ rows: [row('water', { manifest: WITH_PANELS })], safeMode: true });
    expect(modCommands()).toEqual([]);
    expect(closePanel()).toBeUndefined();
  });

  it('"Close your mod\'s panel" shows only while a panel is in the rail, and closes it', () => {
    const r = row('water', { manifest: WITH_PANELS });
    useModsStore.setState({ rows: [r] });
    const close = closePanel()!;
    expect(close.shortcut).toBeUndefined();
    expect(close.group).toBe('mods');
    expect(typeof close.hidden === 'function' && close.hidden(ctx)).toBe(true);
    useRailStore.getState().openModPanel({ modId: r.id, panelId: 'water' });
    expect(typeof close.hidden === 'function' && close.hidden(ctx)).toBe(false);
    expect(close.availableWhen?.(ctx)).toBe(true);
    close.run(ctx);
    expect(useRailStore.getState().modPanel).toBeNull();
  });
});
