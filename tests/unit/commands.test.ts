import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STATIC_COMMANDS,
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
import { useUIStore } from '@/lib/ui-store';
import type { Item, ItemTypeDef } from '@/lib/planner-types';

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
    const mobile = matchCommands('', { ...ctx, isMobile: true }).map((r) => r.command.id);
    expect(mobile).not.toContain('view.scopeWeek');
    expect(mobile).not.toContain('workspace.toggleChat');

    const desktop = matchCommands('', ctx).map((r) => r.command.id);
    expect(desktop).not.toContain('goto.todayTab');
    // Never a row on either platform — it would hide the palette itself.
    expect(desktop).not.toContain('workspace.toggleSidebar');
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

  it('snoozes each item from its own date', () => {
    seedStore([
      task({ id: 't1', title: 'One', startDate: TODAY }),
      task({ id: 't2', title: 'Two', startDate: '2026-03-20' }),
    ]);
    entityArg('items.snooze').runMany(ctx, ['t1', 't2']);
    const dates = usePlannerStore.getState().items.map((i) => ('startDate' in i ? i.startDate : null));
    expect(dates).toEqual(['2026-03-11', '2026-03-21']);
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
