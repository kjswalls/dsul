import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useCommandShortcuts } from '@/hooks/use-command-shortcuts';
import { useSelectionStore } from '@/lib/selection-store';
import { useUIStore } from '@/lib/ui-store';
import {
  STATIC_COMMANDS,
  PREVIEW_CHROME_IDS,
  PREVIEW_GATED_GROUPS,
  PREVIEW_GATED_IDS,
  gatedDuringPreview,
  heldByPreview,
  isAvailable,
  resolveCommands,
  type Command,
  type CommandContext,
} from '@/lib/commands';
import { usePlannerStore } from '@/lib/planner-store';
import { useModsStore } from '@/lib/mods-store';
import { useUndoStripStore } from '@/lib/undo-strip-store';
import type { UserMod } from '@/lib/mods/schema';
import { enableGoalsAndOrganize } from './support/extensions';
import type { Goal, Item, ItemTypeDef, Routine, Season } from '@/lib/planner-types';

/**
 * The palette's half of the look-only preview (lib/commands/types.ts).
 *
 * While the planner shows last session's cached rows, every command that acts
 * on planner rows is greyed in the palette and refused by its shortcut — the
 * store's write barrier would refuse the write anyway, and a row that silently
 * does nothing reads as broken. Chrome (view, go to, settings, the console
 * doors) stays live: none of it writes a row, and the doors' dialogs are
 * deferred by ui-store until the data is real.
 *
 * The gate is a GROUP rule because availability defaults to true. The table
 * below freezes the classification of every static command, so a command
 * moved between groups, or a new one, has to be classified out loud here.
 */

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u1',
  isMobile: false,
};

/** Every STATIC_COMMANDS id → gated while previewing. Inline on purpose: add, never derive. */
const GATED_DURING_PREVIEW: Record<string, boolean> = {
  'create.task': true,
  'create.habit': true,
  'create.bulk': true,
  'create.goal': true,
  'create.routine': true,
  'create.season': true,
  'create.project': true,
  'items.complete': true,
  'items.delete': true,
  'items.snooze': true,
  'items.skip': true,
  'items.resetStreak': true,
  'items.leaveProjectBlock': true,
  'items.pause': true,
  'items.resume': true,
  'items.priority.low': true,
  'items.priority.medium': true,
  'items.priority.high': true,
  'items.bucket.anytime': true,
  'items.bucket.morning': true,
  'items.bucket.afternoon': true,
  'items.bucket.evening': true,
  'goto.today': false,
  'goto.tomorrow': false,
  'goto.yesterday': false,
  'goto.next': false,
  'goto.previous': false,
  'goto.braindump': false,
  'goto.todayTab': false,
  // The tray triages cached rows.
  'goto.overdue': true,
  'view.layout': false,
  'view.typeFilter': false,
  'view.groupBy': false,
  'view.filterProject': false,
  'view.clearFilters': false,
  'view.scopeDay': false,
  'view.scopeWeek': false,
  'view.toggleScope': false,
  'view.zen': false,
  'view.weekColumnsWider': false,
  'view.weekColumnsNarrower': false,
  'view.weekColumnsReset': false,
  'rituals.chat': true,
  'rituals.catchUp': true,
  'rituals.planDay': true,
  // Ask's two doors (#382) ride their group, as rituals.chat does.
  'ask.newChat': true,
  'ask.history': true,
  // Opens Settings → Make with its box focused: chrome in the 'mods' group (PREVIEW_CHROME_IDS).
  'make.write': false,
  'rituals.eod': true,
  'workspace.toggleChat': false,
  'workspace.toggleSidebar': false,
  'workspace.focusItemPanel': false,
  'workspace.focusOmnibar': false,
  'workspace.openCommandLauncher': false,
  'workspace.focusCapture': false,
  // ⌘A reads row ids from the DOM, inert or not.
  'workspace.selectAll': true,
  'settings.darkMode': false,
  'settings.theme': false,
  'settings.showCompleted': false,
  'settings.showPaused': false,
  'settings.timeFormat': false,
  'settings.typeface': false,
  'settings.animations': false,
  'settings.morningCheck': false,
  'settings.eodReview': false,
  // Switches off what a person made (user_mods), never a planner row: the safety switch stays live.
  'settings.modsOff': false,
  'history.undo': true,
  'history.redo': true,
  'app.settings': false,
  // The console doors: what they open is deferred (lib/ui-store.ts), not refused here.
  'app.extensions': false,
  'app.categories': false,
  'app.collections': false,
  'app.goals': false,
  'app.shortcuts': false,
  'app.feedback': false,
};

const task = (id: string, title: string): Item =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: false, order: 0, completedDates: [] }) as Item;

const ERRAND: ItemTypeDef = { id: 'type-errand', name: 'errand', label: 'Errand', labelPlural: 'Errands' };
const ROUTINE: Routine = { id: 'r1', name: 'Morning', itemIds: [] } as Routine;
const LIVE: Season = { id: 's1', name: 'Summer', state: 'active', itemIds: [], routineIds: [] } as Season;
const OFF: Season = { id: 's2', name: 'Winter', state: 'paused', itemIds: [], routineIds: [] } as Season;
const GOAL: Goal = { id: 'g1', name: 'Learn Chinese', state: 'active' } as Goal;

function seed(isPreview: boolean) {
  const items = [task('t1', 'Write report')];
  usePlannerStore.setState({
    userId: 'u1',
    isLoading: isPreview,
    isPreview,
    error: null,
    loadFailedUserId: null,
    userTimezone: 'UTC',
    selectedDate: new Date('2026-03-10T12:00:00Z'),
    items,
    tasks: items as never,
    habits: [] as never,
    itemTypes: [ERRAND],
    routines: [ROUTINE],
    seasons: [LIVE, OFF],
    goals: [GOAL],
    collectionsAvailable: true,
    goalsAvailable: true,
    canUndo: true,
    canRedo: true,
  } as never);
}

const providerCommands = (): Command[] =>
  resolveCommands(ctx).filter((command) => !STATIC_COMMANDS.includes(command));

beforeEach(() => {
  enableGoalsAndOrganize();
  seed(false);
});
afterEach(() => {
  usePlannerStore.setState({ isPreview: false, isLoading: false } as never);
  useModsStore.setState({ available: false, loaded: false, safeMode: false, rows: [] });
  useUndoStripStore.setState({ entry: null } as never);
});

/** A switched-on recipe run from ⌘K (lib/commands/registry.ts recipeCommands). */
const RECIPE: UserMod = {
  id: 'mod-1',
  userId: 'u1',
  kind: 'recipe',
  slug: 'reset',
  name: 'Reset',
  enabled: true,
  manifest: { version: 1, trigger: { on: 'command' }, filters: {}, steps: [{ do: 'toast', text: 'x' }] },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
} as UserMod;

describe('the preview classification of the command registry', () => {
  it('is frozen for every static command', () => {
    const actual = Object.fromEntries(STATIC_COMMANDS.map((c) => [c.id, gatedDuringPreview(c)]));
    expect(actual).toEqual(GATED_DURING_PREVIEW);
  });

  it('gates exactly the five data groups plus two ids, less one chrome id', () => {
    expect([...PREVIEW_GATED_GROUPS].sort()).toEqual(['create', 'history', 'items', 'mods', 'rituals']);
    expect([...PREVIEW_GATED_IDS].sort()).toEqual(['goto.overdue', 'workspace.selectAll']);
    expect([...PREVIEW_CHROME_IDS]).toEqual(['make.write']);
  });
});

describe('isAvailable while previewing', () => {
  it('is false for every gated static command, whatever its own availableWhen says', () => {
    seed(true);
    const gated = STATIC_COMMANDS.filter(gatedDuringPreview);
    expect(gated.length).toBeGreaterThan(0);
    for (const command of gated) expect(isAvailable(command, ctx), command.id).toBe(false);
  });

  it('gives a gated command its own answer back once the preview ends', () => {
    // create.task has no availableWhen; history.undo answers canUndo (seeded true).
    const ids = ['create.task', 'history.undo'];
    seed(true);
    for (const id of ids) expect(isAvailable(byId(id), ctx), id).toBe(false);
    seed(false);
    for (const id of ids) expect(isAvailable(byId(id), ctx), id).toBe(true);
  });

  it('leaves every ungated static command exactly as available as it was', () => {
    const ungated = STATIC_COMMANDS.filter((c) => !gatedDuringPreview(c));
    seed(false);
    const before = ungated.map((c) => isAvailable(c, ctx));
    seed(true);
    expect(ungated.map((c) => isAvailable(c, ctx))).toEqual(before);
    // Not vacuous: the chrome rows the preview must leave alone are live.
    for (const id of ['goto.today', 'view.layout', 'settings.darkMode', 'app.collections']) {
      expect(isAvailable(byId(id), ctx), id).toBe(true);
    }
  });

  it('gates the provider commands: custom types, routine and season switches, goal pages', () => {
    seed(true);
    const dynamic = providerCommands();
    const ids = dynamic.map((c) => c.id);
    // One of each family, so a provider that stopped emitting cannot pass this vacuously.
    expect(ids).toEqual(
      expect.arrayContaining([
        'create.type.errand',
        'routine.run.r1',
        'routine.pause.r1',
        'season.pause.s1',
        'season.activate.s2',
        'season.swap.s2',
        'goal.open.g1',
      ])
    );
    for (const command of dynamic) {
      expect(gatedDuringPreview(command), command.id).toBe(true);
      expect(isAvailable(command, ctx), command.id).toBe(false);
    }
  });

  it('gates what a person made: "Run recipe: …" writes through the store, so it waits for the landing', () => {
    // Its engine refuses while the planner has not settled (lib/recipes/engine.ts engineReady), so
    // ungated it would be a row that silently does nothing.
    useModsStore.setState({ available: true, loaded: true, safeMode: false, rows: [RECIPE] });
    seed(true);
    const recipe = providerCommands().find((c) => c.id === 'mod.reset.run');
    expect(recipe?.group).toBe('mods');
    expect(gatedDuringPreview(recipe!)).toBe(true);
    expect(isAvailable(recipe!, ctx)).toBe(false);
    // Write a recipe with AI only opens Settings → Make: live through the preview.
    expect(isAvailable(byId('make.write'), ctx)).toBe(byId('make.write').availableWhen!(ctx));
    seed(false);
    expect(isAvailable(recipe!, ctx)).toBe(true);
  });

  it("keeps Undo live for a strip row with its own take-back, which is not the planner's history", () => {
    const onUndo = () => {};
    seed(true);
    usePlannerStore.setState({ canUndo: true } as never);
    // The planner's own undo: refused, and its key held.
    expect(isAvailable(byId('history.undo'), ctx)).toBe(false);
    expect(heldByPreview(byId('history.undo'), ctx)).toBe(true);
    // "AI is off" · Undo (lib/no-ai.ts): Ctrl+Z is that row's Undo, preview or not.
    useUndoStripStore.setState({ entry: { id: 'ai-off-1', label: 'AI is off.', durationMs: 5000, onUndo } } as never);
    expect(isAvailable(byId('history.undo'), ctx)).toBe(true);
    expect(heldByPreview(byId('history.undo'), ctx)).toBe(false);
    // Redo has no such row: still refused.
    expect(isAvailable(byId('history.redo'), ctx)).toBe(false);
  });

  it('gates nothing when not previewing', () => {
    seed(false);
    expect(isAvailable(byId('create.task'), ctx)).toBe(true);
    for (const command of providerCommands()) expect(isAvailable(command, ctx), command.id).toBe(true);
  });
});

/**
 * The dispatcher's half (hooks/use-command-shortcuts.ts). A shortcut whose
 * command is greyed ONLY by the preview keeps its key: handed back, ⌘A is the
 * browser's own select-all over the whole page, and that blue highlight
 * outlives the landing. A cold load with no preview has always consumed it
 * (the command runs over an empty DOM), so the preview must too.
 */
describe('a gated shortcut while previewing', () => {
  /** Dispatches a keydown on `target` and reports whether the dispatcher claimed it. */
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window): boolean => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    return event.defaultPrevented;
  };

  /** A selectable row, as TaskRow renders one (lib/selection-store.ts selectableIdsInDom). */
  const row = (id: string) => {
    const el = document.createElement('div');
    el.dataset.itemKind = 'task';
    el.dataset.itemId = id;
    document.body.appendChild(el);
  };

  beforeEach(() => {
    useSelectionStore.getState().replace([]);
    renderHook(() => useCommandShortcuts(ctx));
  });
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useSelectionStore.getState().replace([]);
  });

  it('keeps ⌘A from the browser and selects nothing', () => {
    row('t1');
    seed(true);
    expect(press('a', { metaKey: true })).toBe(true);
    expect(useSelectionStore.getState().selectedIds.size).toBe(0);
  });

  it('runs ⌘A as ever once the preview ends', () => {
    row('t1');
    seed(false);
    expect(press('a', { metaKey: true })).toBe(true);
    expect([...useSelectionStore.getState().selectedIds]).toEqual(['t1']);
  });

  it('keeps a bare gated key too (n), and opens nothing — not even a deferred add', () => {
    seed(true);
    expect(press('n')).toBe(true);
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useUIStore.getState().deferredDialog).toBeNull();
  });

  it("hands back a key whose command has nothing to do anyway — the preview is not why (⌘Z, no history)", () => {
    seed(true);
    usePlannerStore.setState({ canUndo: false } as never);
    expect(press('z', { ctrlKey: true })).toBe(false);
  });

  it('leaves ⌘A in a text field to the browser', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    seed(true);
    expect(press('a', { metaKey: true }, input)).toBe(false);
  });
});

function byId(id: string): Command {
  const command = STATIC_COMMANDS.find((c) => c.id === id);
  if (!command) throw new Error(`no such command: ${id}`);
  return command;
}
