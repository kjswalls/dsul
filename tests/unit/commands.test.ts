import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STATIC_COMMANDS,
  chordLabel,
  findCommand,
  formatKeys,
  matchCommands,
  matchEntityOptions,
  matchesBinding,
  normalizeBinding,
  pressedKeys,
  resolveCommands,
  type Command,
  type CommandContext,
} from '@/lib/commands';
import { DEFAULT_SHORTCUTS } from '@/lib/keyboard-shortcuts-store';
import { getActionLog, usePlannerStore } from '@/lib/planner-store';
import { registerItemPanelFlush, useUIStore } from '@/lib/ui-store';
import { useRailStore } from '@/lib/rail-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useProposalStore } from '@/lib/proposal-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { AskMarkUnlitIcon } from '@/components/ai/ask-mark';
import type { Item, ItemTypeDef } from '@/lib/planner-types';
import { AI_HIDDEN, CONNECTED_MODEL, KEY_TURNED_DOWN, NOTHING_CONNECTED, OPENCLAW_PLUGIN, seedAI } from './helpers/ai-fixtures';

/**
 * The palette's load-bearing invariants: every rendered row has a unique cmdk
 * value (duplicates silently collapse selection), a keypress maps to exactly
 * one command on both platforms, and — since round 2 — an item command never
 * offers you a target it would no-op on.
 */

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'test-user',
  isMobile: false,
};

/** The day the fixtures are written against; every date assertion is relative. */
const TODAY = '2026-03-10';

function seedStore(items: Item[], itemTypes: ItemTypeDef[] = []) {
  usePlannerStore.setState({
    items,
    // The projections the store derives; custom types ride the task one.
    tasks: items.filter((i) => i.type !== 'habit') as never,
    habits: items.filter((i) => i.type === 'habit') as never,
    itemTypes,
    selectedDate: new Date(`${TODAY}T12:00:00Z`),
    userTimezone: 'UTC',
  });
}

const task = (over: Partial<Item> & { id: string; title: string }) =>
  ({
    type: 'task',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    ...over,
  }) as Item;

const habit = (over: Partial<Item> & { id: string; title: string }) =>
  ({
    type: 'habit',
    project: 'Wellness',
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  }) as Item;

/** Item ids the given command would offer for a query. */
function picks(id: string, query = ''): string[] {
  const command = findCommand(id, ctx);
  if (!command) throw new Error(`no such command: ${id}`);
  return matchEntityOptions(command, query, ctx).map((option) => option.value);
}

function commandById(id: string): Command {
  const command = findCommand(id, ctx);
  if (!command) throw new Error(`no such command: ${id}`);
  return command;
}

beforeEach(() => seedStore([]));

/** Minimal stand-in — pressedKeys only reads these five fields. */
function keyEvent(
  key: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}
): KeyboardEvent {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  } as KeyboardEvent;
}

describe('command registry', () => {
  it('has no duplicate command ids', () => {
    const ids = resolveCommands(ctx).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lets no dynamically derived command own a keyboard shortcut', () => {
    // Bindings are persisted by shortcut id. A command that can disappear
    // (a custom type, deleted) would strand the user's override behind it.
    seedStore([], [typeDef('goal')]);
    const dynamic = resolveCommands(ctx).filter(
      (command) => !STATIC_COMMANDS.includes(command)
    );
    expect(dynamic.length).toBeGreaterThan(0);
    expect(dynamic.every((command) => !command.shortcut)).toBe(true);
  });

  it('has no duplicate shortcut ids', () => {
    const ids = DEFAULT_SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every historical shortcut id, so persisted rebindings still resolve', () => {
    // These are the keys a user's override is stored under. Renaming one
    // silently discards their custom binding.
    const expected = [
      'new_task',
      'edit_hovered',
      'delete_hovered',
      'undo',
      'redo',
      'toggle_left_sidebar',
      'toggle_right_sidebar',
      'system_settings',
      'system_shortcuts',
      'system_search',
      'system_command',
      'system_capture',
      'report_bug',
      'toggle_view_scope',
      'focus_item_panel',
      'select_all',
      'week_columns_wider',
      'week_columns_narrower',
      'week_columns_reset',
      'toggle_zen',
    ];
    const actual = DEFAULT_SHORTCUTS.map((s) => s.id);
    for (const id of expected) expect(actual).toContain(id);
    expect(actual).toHaveLength(expected.length);
  });

  it('gives no two bindings the same normalized key combination', () => {
    const seen = new Map<string, string>();
    for (const binding of DEFAULT_SHORTCUTS) {
      const combo = normalizeBinding(binding.keys).join('+');
      expect(seen.has(combo), `${binding.id} collides with ${seen.get(combo)} on ${combo}`).toBe(
        false
      );
      seen.set(combo, binding.id);
    }
  });
});

describe('aliases', () => {
  /** Every alias in the registry, including those on flattened enum options. */
  function allAliases() {
    const found: { alias: string; owner: string }[] = [];
    for (const command of resolveCommands(ctx)) {
      for (const alias of command.aliases ?? []) found.push({ alias, owner: command.id });
      const arg = command.argument;
      if (arg?.kind !== 'enum') continue;
      for (const option of arg.options(ctx)) {
        for (const alias of option.aliases ?? []) {
          found.push({ alias, owner: `${command.id}::${option.value}` });
        }
      }
    }
    return found;
  }

  it('are unique across the whole registry', () => {
    // An alias is a promise that typing it lands in exactly one place. Two
    // owners for one token silently breaks that.
    const seen = new Map<string, string>();
    for (const { alias, owner } of allAliases()) {
      expect(seen.has(alias), `"${alias}" claimed by both ${seen.get(alias)} and ${owner}`).toBe(
        false
      );
      seen.set(alias, owner);
    }
  });

  it('are single lowercase words', () => {
    for (const { alias, owner } of allAliases()) {
      expect(alias, `${owner} has a malformed alias`).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('sends /dark and /light straight to the theme, not the toggle', () => {
    const dark = matchCommands('dark', ctx)[0];
    expect(dark.command.id).toBe('settings.theme');
    expect(dark.arg?.value).toBe('dark');

    const light = matchCommands('light', ctx)[0];
    expect(light.command.id).toBe('settings.theme');
    expect(light.arg?.value).toBe('light');

    // Both run in one step — no chip, no second Enter.
    expect(dark.arg).toBeDefined();
    expect(light.arg).toBeDefined();
  });

  it('outranks another command that merely contains the word', () => {
    // "Toggle dark mode" matches "dark" on a word boundary; the alias wins.
    const ids = matchCommands('dark', ctx).map((r) => r.command.id);
    expect(ids).toContain('settings.darkMode');
    expect(ids[0]).toBe('settings.theme');
  });

  it('resolves the short navigation tokens', () => {
    const top = (q: string) => matchCommands(q, ctx)[0];
    expect(top('today').command.id).toBe('goto.today');
    expect(top('tomorrow').command.id).toBe('goto.tomorrow');
    expect(top('yesterday').command.id).toBe('goto.yesterday');
    expect(top('week').command.id).toBe('view.scopeWeek');
    expect(top('eod').command.id).toBe('rituals.eod');
    expect(top('inbox').command.id).toBe('goto.braindump');
  });
});

describe('matchCommands', () => {
  it('produces unique row values so cmdk selection cannot collapse', () => {
    for (const query of ['', 'a', 'e', 'task', 'list', 'to', 'set']) {
      const values = matchCommands(query, ctx).map((r) => r.value);
      expect(new Set(values).size, `duplicate row value for query "${query}"`).toBe(values.length);
    }
  });

  it('ranks an exact label match first', () => {
    expect(matchCommands('add task', ctx)[0].command.id).toBe('create.task');
    expect(matchCommands('undo', ctx)[0].command.id).toBe('history.undo');
  });

  it('finds a singular command from a plural query', () => {
    // People type "habits"; the command is labelled "Add habit".
    const ids = matchCommands('habits', ctx).map((r) => r.command.id);
    expect(ids).toContain('create.habit');
  });

  it('does not let a three-letter word drag in unrelated commands', () => {
    // "settings" starts with the word "Set" in "Set theme" — too weak a signal.
    const ids = matchCommands('settings', ctx).map((r) => r.command.id);
    expect(ids).toContain('app.settings');
    expect(ids).not.toContain('settings.theme');
  });

  it('reaches a nested enum value in one step once you type it', () => {
    const row = matchCommands('schedule', ctx).find((r) => r.arg?.value === 'schedule');
    expect(row?.command.id).toBe('view.layout');
    expect(row?.value).toBe('cmd:view.layout::schedule');
  });

  it('does not flatten options into the resting list', () => {
    expect(matchCommands('', ctx).every((r) => !r.arg)).toBe(true);
  });

  it('omits commands hidden for the current platform', () => {
    // Chat connected, so the AI gate is not what hides the chat toggle: with
    // nothing to answer it is hidden on desktop too, and the mobile half of
    // this case would pass whether or not the platform rule existed.
    const unseed = seedAI(CONNECTED_MODEL);
    try {
      const mobile = matchCommands('', { ...ctx, isMobile: true }).map((r) => r.command.id);
      expect(mobile).not.toContain('view.scopeWeek');
      expect(mobile).not.toContain('workspace.toggleChat');

      const desktop = matchCommands('', ctx).map((r) => r.command.id);
      expect(desktop).toContain('workspace.toggleChat');
      expect(desktop).not.toContain('goto.todayTab');
      // Never a row on either platform — it would hide the palette itself.
      expect(desktop).not.toContain('workspace.toggleSidebar');
    } finally {
      unseed();
    }
  });
});

describe('entity arguments', () => {
  it('offers only the items the command can actually act on', () => {
    seedStore([
      task({ id: 't1', title: 'Write spec', startDate: TODAY }),
      task({ id: 't2', title: 'Ship it', status: 'completed', startDate: TODAY }),
      task({ id: 't3', title: 'Old news', status: 'cancelled', startDate: TODAY }),
    ]);
    // Completing a completed item would un-complete it — the picker must not
    // present that as "Complete".
    expect(picks('items.complete')).toEqual(['t1']);
    // Delete is the one command with no eligibility rule beyond existing.
    expect(picks('items.delete').sort()).toEqual(['t1', 't2', 't3']);
  });

  it('greys the command out when nothing qualifies, rather than opening an empty picker', () => {
    seedStore([task({ id: 't1', title: 'Ship it', status: 'completed' })]);
    expect(commandById('items.complete').availableWhen?.(ctx)).toBe(false);
    expect(commandById('items.delete').availableWhen?.(ctx)).toBe(true);

    seedStore([task({ id: 't1', title: 'Ship it' })]);
    expect(commandById('items.complete').availableWhen?.(ctx)).toBe(true);
  });

  it('resolves against the day on screen, not today', () => {
    seedStore([habit({ id: 'h1', title: 'Stretch', completedDates: [TODAY] })]);
    expect(picks('items.complete')).toEqual([]);

    // Same habit, previous day: not done then, so it is completable there.
    usePlannerStore.setState({ selectedDate: new Date('2026-03-09T12:00:00Z') });
    expect(picks('items.complete')).toEqual(['h1']);
  });

  it('ranks the selected day above other dates, and the backlog below both', () => {
    seedStore([
      task({ id: 'backlog', title: 'Someday thing' }),
      task({ id: 'next-week', title: 'Later thing', startDate: '2026-03-17' }),
      task({ id: 'today', title: 'Now thing', startDate: TODAY }),
      task({ id: 'tomorrow', title: 'Soon thing', startDate: '2026-03-11' }),
    ]);
    expect(picks('items.complete')).toEqual(['today', 'tomorrow', 'next-week', 'backlog']);
  });

  it('scores a title match above mere proximity', () => {
    seedStore([
      task({ id: 'today', title: 'Unrelated', startDate: TODAY }),
      task({ id: 'match', title: 'Write the spec' }),
    ]);
    expect(picks('items.complete', 'write')[0]).toBe('match');
  });

  it('inherits the omnibar search grammar', () => {
    seedStore([
      task({ id: 'work', title: 'Standup', project: 'Work', startDate: TODAY }),
      task({ id: 'home', title: 'Standup notes', project: 'Personal', startDate: TODAY }),
    ]);
    // project: is consumed as a filter, not matched as title text.
    expect(picks('items.complete', 'project:Work')).toEqual(['work']);
    expect(picks('items.complete', 'standup').sort()).toEqual(['home', 'work']);
  });

  it('still ranks by title when the query also carries a keyword token', () => {
    seedStore([
      task({ id: 'notes', title: 'Standup notes', project: 'Work', startDate: TODAY }),
      task({ id: 'exact', title: 'Standup', project: 'Work', startDate: TODAY }),
    ]);
    // Both survive the filter and both sit on the selected day, so the exact
    // title has to win on score — which it only does if "project:Work" was
    // stripped before scoring. Left in, no title matches the phrase, every row
    // scores zero, and the tie falls back to store order.
    expect(picks('items.complete', 'standup project:Work')[0]).toBe('exact');
    expect(picks('items.complete', 'standup')[0]).toBe('exact');
  });

  it('confines habit-only commands to habits', () => {
    seedStore([
      task({ id: 't1', title: 'Write spec', startDate: TODAY }),
      habit({ id: 'h1', title: 'Stretch', streak: 4 }),
      habit({ id: 'h2', title: 'Read', streak: 0 }),
    ]);
    // t1 is a one-shot task: skipping is per-DATE, so it needs recurrence, not
    // habit-ness (see the recurring-task case below).
    expect(picks('items.skip').sort()).toEqual(['h1', 'h2']);
    // Nothing to reset on a streak of zero.
    expect(picks('items.resetStreak')).toEqual(['h1']);
    // Habits are date-blind, so there is no date on them to snooze.
    expect(picks('items.snooze')).toEqual(['t1']);
  });

  it('offers Skip to recurring items of any skippable type (#194)', () => {
    seedStore(
      [
        task({ id: 'once', title: 'File taxes', startDate: TODAY }),
        task({
          id: 'daily',
          title: 'Water plants',
          startDate: '2026-03-01',
          repeatFrequency: 'daily',
        }),
        task({
          id: 'done-today',
          title: 'Vitamins',
          startDate: '2026-03-01',
          repeatFrequency: 'daily',
          completedDates: [TODAY],
        }),
        task({
          id: 'already-skipped',
          title: 'Journal',
          startDate: '2026-03-01',
          repeatFrequency: 'daily',
          skippedDates: [TODAY],
        }),
        {
          ...task({ id: 'goal', title: 'Ship v2', startDate: '2026-03-01' }),
          type: 'custom',
          customType: 'goal',
          repeatFrequency: 'weekdays',
        } as Item,
        habit({ id: 'h1', title: 'Stretch' }),
      ],
      [typeDef('goal')]
    );
    // Recurring task and recurring custom type join the habit; the one-shot,
    // the day's completion and the already-skipped day are all excluded.
    expect(picks('items.skip').sort()).toEqual(['daily', 'goal', 'h1']);
  });

  it('does not offer a value the item already has', () => {
    seedStore([
      task({ id: 'high', title: 'Urgent', priority: 'high', timeBucket: 'morning' }),
      task({ id: 'low', title: 'Whenever', priority: 'low', timeBucket: 'evening' }),
    ]);
    expect(picks('items.priority.high')).toEqual(['low']);
    expect(picks('items.bucket.morning')).toEqual(['low']);
  });

  it('re-reads the item at run time instead of trusting the painted row', () => {
    seedStore([task({ id: 't1', title: 'Write spec', startDate: TODAY })]);
    const complete = commandById('items.complete');

    // Completed (or deleted) between painting the row and pressing Enter.
    seedStore([task({ id: 't1', title: 'Write spec', status: 'completed', startDate: TODAY })]);
    complete.run(ctx, 't1');
    expect(usePlannerStore.getState().items[0].status).toBe('completed');

    seedStore([]);
    expect(() => complete.run(ctx, 't1')).not.toThrow();
  });
});

describe('entity arguments: several at once', () => {
  /** The multi-select half of the entity argument, which only itemCommand builds. */
  function entityArg(id: string) {
    const argument = commandById(id).argument;
    if (argument?.kind !== 'entity' || !argument.runMany || !argument.resolve) {
      throw new Error(`${id} is not multi-select`);
    }
    return argument as typeof argument & {
      runMany: NonNullable<typeof argument.runMany>;
      resolve: NonNullable<typeof argument.resolve>;
    };
  }
  const priorityOf = (id: string) =>
    (usePlannerStore.getState().items.find((i) => i.id === id) as { priority?: string } | undefined)
      ?.priority;

  it('gives every entity command a resolve and a runMany', () => {
    const entity = resolveCommands(ctx).filter((c) => c.argument?.kind === 'entity');
    expect(entity.length).toBeGreaterThan(0);
    for (const command of entity) {
      const argument = command.argument as { resolve?: unknown; runMany?: unknown };
      expect(typeof argument.resolve, command.id).toBe('function');
      expect(typeof argument.runMany, command.id).toBe('function');
    }
  });

  it('runs every id as ONE history entry', () => {
    seedStore([task({ id: 't1', title: 'One' }), task({ id: 't2', title: 'Two' })]);
    const entries = getActionLog().length;
    entityArg('items.priority.high').runMany(ctx, ['t1', 't2']);
    expect(priorityOf('t1')).toBe('high');
    expect(priorityOf('t2')).toBe('high');
    expect(getActionLog()).toHaveLength(entries + 1);
    expect(getActionLog()[0]).toMatchObject({ label: 'Set priority: High · 2 items', batch: 2 });
  });

  it('runs a single id exactly as run() does', () => {
    seedStore([task({ id: 't1', title: 'One' }), task({ id: 't2', title: 'Two' })]);
    commandById('items.priority.high').run(ctx, 't1');
    const single = getActionLog()[0];
    entityArg('items.priority.high').runMany(ctx, ['t2']);
    const viaMany = getActionLog()[0];
    expect(viaMany.label).toBe(single.label.replace('One', 'Two'));
    expect(viaMany.batch).toBeUndefined();
  });

  it('drops duplicate, missing and ineligible ids before mutating anything', () => {
    seedStore([
      task({ id: 't1', title: 'One' }),
      task({ id: 'already', title: 'Already', priority: 'high' }),
      habit({ id: 'h1', title: 'Stretch' }),
    ]);
    const entries = getActionLog().length;
    entityArg('items.priority.high').runMany(ctx, ['t1', 't1', 'gone', 'already', 'h1']);
    // One survivor is a single pick: no batch, and one entry.
    expect(getActionLog()).toHaveLength(entries + 1);
    expect(getActionLog()[0].batch).toBeUndefined();
    expect(priorityOf('t1')).toBe('high');
  });

  describe('snooze', () => {
    // The carry is clamped to real today (lib/row-moves.ts nextDayTarget), so
    // the wall clock has to agree with the fixtures' TODAY.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
    });
    afterEach(() => vi.useRealTimers());

    const dateOf = (id: string) =>
      (usePlannerStore.getState().items.find((i) => i.id === id) as { startDate?: string }).startDate;

    it('snoozes each item from its own date', () => {
      seedStore([
        task({ id: 't1', title: 'One', startDate: TODAY }),
        task({ id: 't2', title: 'Two', startDate: '2026-03-20' }),
      ]);
      entityArg('items.snooze').runMany(ctx, ['t1', 't2']);
      expect([dateOf('t1'), dateOf('t2')]).toEqual(['2026-03-11', '2026-03-21']);
    });

    it('carries an overdue item to tomorrow, never to another past day', () => {
      seedStore([task({ id: 'late', title: 'Late', startDate: '2026-03-02' })]);
      entityArg('items.snooze').runMany(ctx, ['late']);
      expect(dateOf('late')).toBe('2026-03-11');
    });

    it('offers only what the rows may carry', () => {
      seedStore([
        task({ id: 'once', title: 'File taxes', startDate: TODAY }),
        // Its startDate is the series anchor: moving it rewrites the series.
        task({ id: 'series', title: 'Water plants', startDate: '2026-03-01', repeatFrequency: 'daily' }),
        // Neither verb clears inProjectBlock, so it would land nowhere visible.
        task({ id: 'block', title: 'Deep work', startDate: TODAY, inProjectBlock: true }),
        // No day to put off from — that is Schedule, not Snooze.
        task({ id: 'undated', title: 'Someday' }),
        task({ id: 'done', title: 'Done', startDate: TODAY, status: 'completed' }),
      ]);
      expect(picks('items.snooze')).toEqual(['once']);
    });
  });

  it('labels a batch complete the way the bulk bar does', () => {
    seedStore([task({ id: 't1', title: 'One' }), task({ id: 't2', title: 'Two' })]);
    entityArg('items.complete').runMany(ctx, ['t1', 't2']);
    expect(getActionLog()[0]).toMatchObject({ label: 'Complete items (2)', batch: 2 });
    expect(usePlannerStore.getState().items.every((i) => i.status === 'completed')).toBe(true);
  });

  it('resets streaks without touching completion history', () => {
    seedStore([
      habit({ id: 'h1', title: 'Stretch', streak: 4, completedDates: ['2026-03-09'] }),
      habit({ id: 'h2', title: 'Read', streak: 2, completedDates: ['2026-03-08'] }),
    ]);
    entityArg('items.resetStreak').runMany(ctx, ['h1', 'h2']);
    const habits = usePlannerStore.getState().items as { streak: number; completedDates: string[] }[];
    expect(habits.map((h) => h.streak)).toEqual([0, 0]);
    expect(habits.map((h) => h.completedDates)).toEqual([['2026-03-09'], ['2026-03-08']]);
  });

  describe('delete', () => {
    const original = useUIStore.getState().confirm;
    let confirm: ReturnType<typeof vi.fn<typeof original>>;
    beforeEach(() => {
      confirm = vi.fn<typeof original>();
      useUIStore.setState({ confirm });
      return () => useUIStore.setState({ confirm: original });
    });
    const request = () =>
      confirm.mock.calls[0][0] as { title: string; description: string; onConfirm: () => void };

    it('asks ONCE for the whole selection, and says it can be undone', () => {
      seedStore([
        task({ id: 't1', title: 'One' }),
        task({ id: 't2', title: 'Two' }),
        habit({ id: 'h1', title: 'Stretch' }),
      ]);
      entityArg('items.delete').runMany(ctx, ['t1', 't2', 'h1']);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(request().title).toBe('Delete 3 items?');
      expect(request().description).toContain('completion history');
      expect(request().description).toContain('undo');
      expect(request().description).not.toContain('cannot be undone');
    });

    it('deletes only what is still there when confirmed', () => {
      seedStore([
        task({ id: 't1', title: 'One' }),
        task({ id: 't2', title: 'Two' }),
        task({ id: 't3', title: 'Three' }),
      ]);
      const deleteItems = vi.spyOn(usePlannerStore.getState(), 'deleteItems');
      entityArg('items.delete').runMany(ctx, ['t1', 't2', 't3']);
      // Deleted elsewhere while the prompt was up.
      usePlannerStore.setState({
        items: usePlannerStore.getState().items.filter((i) => i.id !== 't2'),
      });
      request().onConfirm();
      expect(deleteItems).toHaveBeenCalledWith(['t1', 't3']);
      deleteItems.mockRestore();
    });

    it('does not double-delete a subtask marked with its parent', () => {
      seedStore([
        task({ id: 'parent', title: 'Parent' }),
        task({ id: 'child', title: 'Child', parentItemId: 'parent' }),
      ]);
      entityArg('items.delete').runMany(ctx, ['parent', 'child']);
      request().onConfirm();
      expect(usePlannerStore.getState().items).toEqual([]);
      expect(getActionLog()[0].label).toBe('Delete items (2)');
    });
  });

  it('resolves marks in input order, dropping the deleted and the ineligible', () => {
    seedStore([
      task({ id: 'a', title: 'A' }),
      task({ id: 'b', title: 'B' }),
      task({ id: 'done', title: 'Done', status: 'completed' }),
    ]);
    const resolved = entityArg('items.complete').resolve(['b', 'gone', 'done', 'a'], ctx);
    expect(resolved.map((o) => o.value)).toEqual(['b', 'a']);
  });
});

describe('dynamic commands', () => {
  it('adds one Add ‹type› per hydrated custom type, and drops it on delete', () => {
    expect(resolveCommands(ctx).some((c) => c.id === 'create.type.goal')).toBe(false);

    seedStore([], [typeDef('goal')]);
    const goal = findCommand('create.type.goal', ctx);
    expect(goal?.label).toBe('Add goal');
    expect(goal?.group).toBe('create');
    expect(matchCommands('goal', ctx)[0].command.id).toBe('create.type.goal');

    seedStore([], []);
    expect(findCommand('create.type.goal', ctx)).toBeUndefined();
  });

  it('does not let a user-named type steal an alias another command promised', () => {
    // "review" is the end-of-day ritual's alias. A type of that name gets a
    // row and keywords, but not the token.
    seedStore([], [typeDef('review')]);
    expect(findCommand('create.type.review', ctx)?.aliases).toBeUndefined();
    expect(matchCommands('review', ctx)[0].command.id).toBe('rituals.eod');

    seedStore([], [typeDef('goal')]);
    expect(findCommand('create.type.goal', ctx)?.aliases).toEqual(['goal']);
  });

  it('keeps row values unique once dynamic commands and items are in play', () => {
    seedStore([task({ id: 't1', title: 'Write spec' })], [typeDef('goal'), typeDef('idea')]);
    for (const query of ['', 'a', 'add', 'goal', 'complete', 'set']) {
      const values = matchCommands(query, ctx).map((r) => r.value);
      expect(new Set(values).size, `duplicate row value for query "${query}"`).toBe(values.length);
    }
  });
});

function typeDef(name: string): ItemTypeDef {
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return { id: `type-${name}`, name, label, labelPlural: `${label}s` };
}

const MAC = true;
const PC = false;

describe('key matching', () => {
  it('accepts the platform modifier whichever token a binding shipped with', () => {
    // Bindings were authored inconsistently: undo as ['ctrl','z'], settings as
    // ['meta'','']. Both have to work on both platforms.
    expect(matchesBinding(pressedKeys(keyEvent('z', { meta: true }), MAC), ['ctrl', 'z'])).toBe(
      true
    );
    expect(matchesBinding(pressedKeys(keyEvent('z', { ctrl: true }), PC), ['ctrl', 'z'])).toBe(true);
    expect(matchesBinding(pressedKeys(keyEvent(',', { meta: true }), MAC), ['meta', ','])).toBe(
      true
    );
    expect(matchesBinding(pressedKeys(keyEvent(',', { ctrl: true }), PC), ['meta', ','])).toBe(true);
  });

  it('leaves Control alone on macOS so native text bindings survive', () => {
    // ⌃K is "kill to end of line" in every macOS text field, and ⌘K is
    // allowInInput — folding them together would swallow it.
    expect(matchesBinding(pressedKeys(keyEvent('k', { ctrl: true }), MAC), ['meta', 'k'])).toBe(
      false
    );
    expect(matchesBinding(pressedKeys(keyEvent('k', { meta: true }), MAC), ['meta', 'k'])).toBe(
      true
    );
    // On Windows there is no such convention, so Ctrl is the modifier.
    expect(matchesBinding(pressedKeys(keyEvent('k', { ctrl: true }), PC), ['meta', 'k'])).toBe(true);
  });

  it('distinguishes redo from undo', () => {
    // e.key is the uppercase letter when Shift is held with a modifier, so
    // without the alphanumeric rule this collapsed onto undo.
    const redo = pressedKeys(keyEvent('Z', { ctrl: true, shift: true }), PC);
    expect(matchesBinding(redo, ['ctrl', 'shift', 'z'])).toBe(true);
    expect(matchesBinding(redo, ['ctrl', 'z'])).toBe(false);

    const undo = pressedKeys(keyEvent('z', { ctrl: true }), PC);
    expect(matchesBinding(undo, ['ctrl', 'z'])).toBe(true);
    expect(matchesBinding(undo, ['ctrl', 'shift', 'z'])).toBe(false);
  });

  it('does not count Shift for a character Shift produced', () => {
    // '?' arrives as Shift+/, so adding 'shift' would stop ['?'] matching.
    expect(matchesBinding(pressedKeys(keyEvent('?', { shift: true }), PC), ['?'])).toBe(true);
  });

  it('matches bare single-key bindings', () => {
    expect(matchesBinding(pressedKeys(keyEvent('n'), PC), ['n'])).toBe(true);
    expect(matchesBinding(pressedKeys(keyEvent('Backspace'), PC), ['backspace'])).toBe(true);
    // A modifier held means it is no longer the bare binding.
    expect(matchesBinding(pressedKeys(keyEvent('n', { meta: true }), PC), ['n'])).toBe(false);
  });

  it('opts exactly the sweepable shortcuts into key auto-repeat', () => {
    // Repeat is opt-in because holding a key must not reopen a dialog thirty
    // times. These four are the ones where holding IS the gesture: rewinding
    // history, and sweeping the week column ladder.
    const repeatable = STATIC_COMMANDS.filter((c) => c.shortcut?.repeatable).map(
      (c) => c.shortcut!.id
    );
    expect(repeatable.sort()).toEqual([
      'redo',
      'undo',
      'week_columns_narrower',
      'week_columns_wider',
    ]);
  });

  it('labels ctrl and meta as the platform modifier, matching what they match', () => {
    expect(formatKeys(['ctrl', 'z'], true)).toEqual(['⌘', 'Z']);
    expect(formatKeys(['meta', 'z'], false)).toEqual(['Ctrl', 'Z']);
  });
});

describe('chordLabel', () => {
  it('names a binding the way a sentence does: "Ctrl+J" off a Mac, "⌘J" on one', () => {
    expect(chordLabel(['meta', 'j'], PC)).toBe('Ctrl+J');
    expect(chordLabel(['meta', 'j'], MAC)).toBe('⌘J');
    // Modifier-first whatever order the binding was stored in (a recorder sorts it).
    expect(chordLabel(['j', 'mod'], PC)).toBe('Ctrl+J');
    expect(chordLabel(['k', 'mod', 'shift'], PC)).toBe('Ctrl+Shift+K');
    expect(chordLabel(['k', 'mod', 'shift'], MAC)).toBe('⌘⇧K');
  });
});

/* ── the right rail (AI step 2a, C2) ────────────────────────────────────── */

describe('the right rail', () => {
  let unseed: () => void = () => {};
  const toggle = () => commandById('workspace.toggleChat');
  const binding = () => toggle().shortcut!;

  beforeEach(() => {
    unseed = seedAI(CONNECTED_MODEL);
    seedStore([]);
    useRailStore.getState().reset();
    useSidebarStore.setState({ askOpen: false, leftSidebarOpen: false });
    useUIStore.setState({ activeDialog: null, displacedItemId: null });
    useProposalStore.setState({ status: 'idle', lastRequest: null });
  });
  afterEach(() => {
    unseed();
    useProposalStore.setState({ status: 'idle', lastRequest: null });
  });

  describe('Ctrl+J (toggle_right_sidebar, re-defaulted)', () => {
    it('keeps its frozen id and is now Ctrl+J, ⌘J on a Mac', () => {
      expect(binding().id).toBe('toggle_right_sidebar');
      expect(binding().keys).toEqual(['meta', 'j']);
      expect(binding().allowInInput).toBe(true);
      expect(matchesBinding(pressedKeys(keyEvent('j', { ctrl: true }), PC), binding().keys)).toBe(true);
      expect(matchesBinding(pressedKeys(keyEvent('j', { meta: true }), MAC), binding().keys)).toBe(true);
      // ⌘] is the browser's Forward again.
      expect(matchesBinding(pressedKeys(keyEvent(']', { meta: true }), MAC), binding().keys)).toBe(false);
      expect(toggle().label).toBe('Open or close Ask');
    });

    it('runs toggleRail: opens Ask, then closes it', () => {
      toggle().run(ctx);
      expect(useSidebarStore.getState().askOpen).toBe(true);
      expect(useRailStore.getState().summoned).toBe(true);
      toggle().run(ctx);
      expect(useSidebarStore.getState().askOpen).toBe(false);
      expect(useRailStore.getState().summoned).toBe(false);
    });

    // With nothing to answer but setup or a fix offered, the chord opens the
    // setup column (lib/open-chat.ts toggleRail); the palette row stays out of
    // sight, since it is not Ask it opens.
    it('is available, and hidden from the palette, while the gate offers setup or a fix', () => {
      for (const offered of [NOTHING_CONNECTED, KEY_TURNED_DOWN]) {
        unseed();
        unseed = seedAI(offered);
        expect(toggle().availableWhen!(ctx)).toBe(true);
        expect((toggle().hidden as (c: CommandContext) => boolean)(ctx)).toBe(true);
      }
    });

    // The setup column is the desktop rail's. On the phone shell the chord
    // would only arm a summon nothing draws, which springs the column open
    // unasked once the window widens; so there it is consumed and inert.
    it('offers setup or a fix only on the desktop shell', () => {
      const phone = { ...ctx, isMobile: true };
      for (const offered of [NOTHING_CONNECTED, KEY_TURNED_DOWN]) {
        unseed();
        unseed = seedAI(offered);
        expect(toggle().availableWhen!(phone)).toBe(false);
      }
      unseed();
      unseed = seedAI(CONNECTED_MODEL);
      expect(toggle().availableWhen!(phone)).toBe(true);
    });

    it('is unavailable, and hidden, with nothing offered', () => {
      for (const nothing of [AI_HIDDEN, { ...KEY_TURNED_DOWN, aiHidden: true }, { phase: 'error' as const }, undefined]) {
        unseed();
        unseed = seedAI(nothing);
        expect(toggle().availableWhen!(ctx)).toBe(false);
        expect((toggle().hidden as (c: CommandContext) => boolean)(ctx)).toBe(true);
      }
    });
  });

  describe('Ctrl+\\ (focus_item_panel, retargeted)', () => {
    const focus = () => commandById('workspace.focusItemPanel');

    it('keeps its id and keys, and says where it works', () => {
      expect(focus().shortcut).toMatchObject({ id: 'focus_item_panel', keys: ['meta', '\\'] });
      expect(focus().shortcut!.context).toContain('item panel is open');
      expect(focus().shortcut!.context).toContain('Ask');
    });

    it('an item open: into the item', () => {
      useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } as never } });
      const before = useUIStore.getState().itemPanelFocusToken;
      focus().run(ctx);
      expect(useUIStore.getState().itemPanelFocusToken).toBe(before + 1);
      expect(useRailStore.getState().pendingFocus).toBeNull();
    });

    it("Ask showing: into Ask's box", () => {
      useSidebarStore.setState({ askOpen: true });
      const before = useUIStore.getState().itemPanelFocusToken;
      focus().run(ctx);
      expect(useRailStore.getState().pendingFocus).toEqual({ target: 'composer' });
      expect(useUIStore.getState().itemPanelFocusToken).toBe(before);
    });

    it("Ask showing History, which has no box: into History's search", () => {
      useSidebarStore.setState({ askOpen: true });
      useRailStore.getState().push('desktop', { kind: 'history' });
      focus().run(ctx);
      expect(useRailStore.getState().pendingFocus).toEqual({ target: 'history-search' });
    });

    it('neither: nothing', () => {
      const before = useUIStore.getState().itemPanelFocusToken;
      focus().run(ctx);
      expect(useRailStore.getState().pendingFocus).toBeNull();
      expect(useUIStore.getState().itemPanelFocusToken).toBe(before);
    });
  });

  describe('"Pick things back up"', () => {
    const catchUp = () => commandById('rituals.catchUp');

    it('with chat: flushes and closes the item, opens Ask at home, then asks, so the card lands where it is seen', () => {
      const order: string[] = [];
      const off = registerItemPanelFlush(() => order.push('flush'));
      const unsub = useProposalStore.subscribe((s, prev) => {
        if (s.lastRequest !== prev.lastRequest) order.push('request');
      });
      useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } as never } });
      useRailStore.getState().push('desktop', { kind: 'history' });

      catchUp().run(ctx);

      expect(order).toEqual(['flush', 'request']);
      expect(useUIStore.getState().activeDialog).toBeNull();
      expect(useRailStore.getState().stacks.desktop).toEqual([]);
      expect(useSidebarStore.getState().askOpen).toBe(true);
      expect(useProposalStore.getState().lastRequest).toMatchObject({ intent: 'catch-up', surface: 'chat' });
      unsub();
      off();
    });

    it('with nothing to answer: the item stays, the dock is revealed, and the card still comes', () => {
      unseed();
      unseed = seedAI(NOTHING_CONNECTED);
      useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } as never } });
      catchUp().run(ctx);
      expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
      expect(useSidebarStore.getState().leftSidebarOpen).toBe(true);
      expect(useSidebarStore.getState().askOpen).toBe(false);
      expect(useProposalStore.getState().lastRequest).toMatchObject({ intent: 'catch-up' });
    });
  });
});

/* ── Ctrl+Z and the undo strip ──────────────────────────────────────────── */

// The strip's row and Ctrl+Z are one offer. A row with its own take-back
// ("AI is off" · Undo, lib/no-ai.ts) is what Ctrl+Z takes back while it shows.
describe('Ctrl+Z (history.undo) and the strip', () => {
  const real = usePlannerStore.getState();
  const plannerUndo = vi.fn();
  const undo = () => commandById('history.undo');

  beforeEach(() => {
    plannerUndo.mockReset();
    usePlannerStore.setState({ canUndo: true, undo: plannerUndo } as never);
    useUndoStripStore.setState({ entry: null });
  });
  afterEach(() => {
    usePlannerStore.setState({ canUndo: real.canUndo, undo: real.undo } as never);
    useUndoStripStore.setState({ entry: null });
  });

  it("takes back the row's own Undo, never the planner action from before it", () => {
    const own = vi.fn();
    useUndoStripStore.getState().show({ id: 'ai-off-1', label: 'AI is off.', durationMs: 5000, onUndo: own });
    undo().run(ctx);
    expect(own).toHaveBeenCalledTimes(1);
    expect(plannerUndo).not.toHaveBeenCalled();
    expect(useUndoStripStore.getState().entry).toBeNull();
    // The row gone, Ctrl+Z is the planner's again.
    undo().run(ctx);
    expect(plannerUndo).toHaveBeenCalledTimes(1);
  });

  it('is available for such a row with nothing in the planner to undo, and not without one', () => {
    usePlannerStore.setState({ canUndo: false } as never);
    expect(undo().availableWhen!(ctx)).toBe(false);
    useUndoStripStore.getState().show({ id: 'ai-off-2', label: 'AI is off.', durationMs: 5000, onUndo: vi.fn() });
    expect(undo().availableWhen!(ctx)).toBe(true);
  });

  it("leaves an action-log row's Ctrl+Z to the planner, as before", () => {
    useUndoStripStore.getState().show({ id: 'log-1', label: 'Delete task: Swim', durationMs: 5000 });
    undo().run(ctx);
    expect(plannerUndo).toHaveBeenCalledTimes(1);
  });
});

/* ── Ask hands off to Make (mods PR 7) ───────────────────────────────────── */

describe('make.write: "Write a recipe with AI"', () => {
  const write = () => commandById('make.write');

  it('shows only with a connected model (canMake), never for OpenClaw alone', () => {
    for (const [seed, shown] of [
      [CONNECTED_MODEL, true],
      [OPENCLAW_PLUGIN, false],
      [{ ...CONNECTED_MODEL, openclaw: { gateway: true, agent: true, agentId: 'a' }, choice: 'openclaw' as const }, false],
      [KEY_TURNED_DOWN, false],
      [AI_HIDDEN, false],
      [{ ...CONNECTED_MODEL, aiHidden: true }, false],
      [{ phase: 'error' as const }, false],
      [undefined, false],
    ] as const) {
      const unseed = seedAI(seed);
      try {
        expect(write().availableWhen!(ctx)).toBe(shown);
        expect((write().hidden as (c: CommandContext) => boolean)(ctx)).toBe(!shown);
      } finally {
        unseed();
      }
    }
  });

  it('opens Make with the Recipe box, and sends nothing; no shortcut id', () => {
    expect(write().shortcut).toBeUndefined();
    const navigate = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const unseed = seedAI(CONNECTED_MODEL);
    try {
      write().run({ ...ctx, navigate });
      expect(navigate).toHaveBeenCalledWith('/settings/make?write=recipe');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      unseed();
      fetchSpy.mockRestore();
    }
  });
});

/* ── the doors into setup (AI setup PR 5) ──────────────────────────────── */

// Ask AI's place while nothing answers: "Set up AI" while the gate invites,
// "Fix AI" while a saved key needs attention, and nothing anywhere else.
describe('ai.setup and ai.fix: "Set up AI" and "Fix AI"', () => {
  const setup = () => commandById('ai.setup');
  const fix = () => commandById('ai.fix');
  const phone: CommandContext = { ...ctx, isMobile: true };
  let unseed: () => void = () => {};

  beforeEach(() => {
    useRailStore.getState().reset();
    useSidebarStore.setState({ askOpen: false });
    useUIStore.setState({ activeDialog: null, displacedItemId: null });
    useMobileNavStore.setState({ activeTab: 'today' });
  });
  afterEach(() => {
    unseed();
    unseed = () => {};
  });

  it('shows each only in its own state of the gate, on desktop and on the phone', () => {
    for (const [label, seed, offered] of [
      ['nothing connected', NOTHING_CONNECTED, 'setup'],
      ['a key turned down', KEY_TURNED_DOWN, 'fix'],
      ['No AI', AI_HIDDEN, null],
      ['a key turned down, and No AI', { ...KEY_TURNED_DOWN, aiHidden: true }, null],
      ['the server cannot say whether AI is hidden', { ...NOTHING_CONNECTED, aiHidden: null }, null],
      ['chat Off on this device', { ...NOTHING_CONNECTED, choice: 'none' as const }, null],
      ['a connected model', CONNECTED_MODEL, null],
      ['OpenClaw answering', OPENCLAW_PLUGIN, null],
      ['the status read failed', { phase: 'error' as const }, null],
      ['the status unknown', undefined, null],
    ] as const) {
      unseed();
      unseed = seedAI(seed);
      for (const c of [ctx, phone]) {
        const where = `${label}, ${c.isMobile ? 'phone' : 'desktop'}`;
        expect(setup().availableWhen!(c), where).toBe(offered === 'setup');
        expect((setup().hidden as (x: CommandContext) => boolean)(c), where).toBe(offered !== 'setup');
        expect(fix().availableWhen!(c), where).toBe(offered === 'fix');
        expect((fix().hidden as (x: CommandContext) => boolean)(c), where).toBe(offered !== 'fix');
        const ids = matchCommands('', c).map((r) => r.command.id);
        expect(ids.includes('ai.setup'), where).toBe(offered === 'setup');
        expect(ids.includes('ai.fix'), where).toBe(offered === 'fix');
      }
    }
  });

  it('sits where Ask AI sits, says "open", wears the unlit mark, and owns no shortcut', () => {
    for (const command of [setup(), fix()]) {
      expect(command.group).toBe('rituals');
      expect(command.verb).toBe('open');
      expect(command.icon).toBe(AskMarkUnlitIcon);
      // Palette only: the frozen shortcut list above stays as it is.
      expect(command.shortcut).toBeUndefined();
      expect(STATIC_COMMANDS.includes(command)).toBe(true);
    }
    expect(setup().label).toBe('Set up AI');
    expect(fix().label).toBe('Fix AI');
    // Declared right after Ask AI, so `/` lists them in its place.
    const order = STATIC_COMMANDS.map((c) => c.id);
    const chat = order.indexOf('rituals.chat');
    expect(order.slice(chat, chat + 3)).toEqual(['rituals.chat', 'ai.setup', 'ai.fix']);
  });

  it('is what the old words and its own find while invited', () => {
    unseed = seedAI(NOTHING_CONNECTED);
    for (const q of ['setup', 'connect']) expect(matchCommands(q, ctx)[0].command.id).toBe('ai.setup');
    for (const q of ['ai', 'ask', 'chat', 'set up']) {
      expect(matchCommands(q, ctx).map((r) => r.command.id)).toContain('ai.setup');
    }
    unseed();
    unseed = seedAI(KEY_TURNED_DOWN);
    expect(matchCommands('fix', ctx)[0].command.id).toBe('ai.fix');
  });

  it('opens the setup column on desktop: open only, never kept open, and an open item closes', () => {
    unseed = seedAI(NOTHING_CONNECTED);
    useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id: 'i1' } as never } });
    setup().run(ctx);
    expect(useRailStore.getState().summoned).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(useRailStore.getState().pendingFocus).toBeNull();
    expect(useUIStore.getState().activeDialog).toBeNull();
    // A second run leaves it showing: a door, not a toggle.
    setup().run(ctx);
    expect(useRailStore.getState().summoned).toBe(true);
  });

  it('opens the fix the same way while a key needs attention', () => {
    unseed = seedAI(KEY_TURNED_DOWN);
    fix().run(ctx);
    expect(useRailStore.getState().summoned).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(false);
  });

  // The phone's palette (Ctrl+K and `/` focus the dock's omnibar there) lists
  // these too, and the Ask tab holds the setup page while nothing answers.
  it('on the phone, shows the Ask tab and never summons the desktop column', () => {
    for (const [seed, command] of [
      [NOTHING_CONNECTED, setup],
      [KEY_TURNED_DOWN, fix],
    ] as const) {
      unseed();
      unseed = seedAI(seed);
      useMobileNavStore.setState({ activeTab: 'today' });
      expect(matchCommands('', phone).map((r) => r.command.id)).toContain(command().id);
      command().run(phone);
      expect(useMobileNavStore.getState().activeTab).toBe('chat');
      expect(useRailStore.getState().summoned).toBe(false);
    }
  });
});
