import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { STATIC_COMMANDS, findCommand, matchCommands, type CommandContext } from '@/lib/commands';
import { useCanvasWide, useViewStore, useWeekScaleShown } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { ATLAS_LAYOUT_OPTIONS, SCOPE_OPTIONS, groupBySupport, scopeOptionsFor } from '@/lib/view-options';
import { stepScope } from '@/lib/nav-commands';
import { ATLAS_COPY } from '@/lib/atlas-copy';

/**
 * The 'atlas' ViewScope's plumbing (design PR1a): the store, the options, the
 * header row's far end, the date step, and the registry gates.
 */

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'test-user',
  isMobile: false,
};
const mobile: CommandContext = { ...ctx, isMobile: true };

const cmd = (id: string) => {
  const c = STATIC_COMMANDS.find((x) => x.id === id);
  if (!c) throw new Error(`no command ${id}`);
  return c;
};
const available = (id: string, c: CommandContext = ctx) => cmd(id).availableWhen?.(c) ?? true;

beforeEach(() => {
  useViewStore.setState({ scope: 'day', layout: 'buckets', atlasLayout: 'map' });
  usePlannerStore.setState({ selectedDate: new Date('2026-03-10T12:00:00Z'), viewMode: 'day' });
});
afterEach(() => {
  vi.restoreAllMocks();
  useViewStore.setState({ scope: 'day' });
  useUIStore.setState({ activeDialog: null });
});

describe('the store', () => {
  it('switches to atlas without mirroring into planner-store (D1)', () => {
    const setViewMode = vi.spyOn(usePlannerStore.getState(), 'setViewMode');
    useViewStore.getState().setScope('atlas');
    expect(useViewStore.getState().scope).toBe('atlas');
    expect(setViewMode).not.toHaveBeenCalled();
    expect(usePlannerStore.getState().viewMode).toBe('day');
  });

  it('still mirrors day and week', () => {
    const setViewMode = vi.spyOn(usePlannerStore.getState(), 'setViewMode');
    useViewStore.getState().setScope('week');
    expect(setViewMode).toHaveBeenCalledWith('week');
  });

  it('keeps the Day/Week layout across a trip to Atlas (D2)', () => {
    useViewStore.setState({ layout: 'schedule' });
    useViewStore.getState().setScope('atlas');
    useViewStore.getState().setAtlasLayout('map');
    useViewStore.getState().setScope('day');
    expect(useViewStore.getState().layout).toBe('schedule');
  });

  it('is wide on atlas but shows no week scale (D7)', () => {
    useViewStore.setState({ scope: 'atlas' });
    expect(renderHook(() => useCanvasWide()).result.current).toBe(true);
    expect(renderHook(() => useWeekScaleShown()).result.current).toBe(false);
    useViewStore.setState({ scope: 'week', layout: 'schedule' });
    expect(renderHook(() => useCanvasWide()).result.current).toBe(true);
    expect(renderHook(() => useWeekScaleShown()).result.current).toBe(true);
    useViewStore.setState({ scope: 'day' });
    expect(renderHook(() => useCanvasWide()).result.current).toBe(false);
    expect(renderHook(() => useWeekScaleShown()).result.current).toBe(false);
  });
});

describe('the options', () => {
  it('lists Atlas third, labelled exactly "Atlas"', () => {
    expect(SCOPE_OPTIONS.map((o) => o.value)).toEqual(['day', 'week', 'atlas']);
    expect(SCOPE_OPTIONS[2].label).toBe('Atlas');
    expect(SCOPE_OPTIONS[2].label).toBe(ATLAS_COPY.name);
  });

  it('never offers Atlas on the phone', () => {
    expect(scopeOptionsFor(true).map((o) => o.value)).toEqual(['day', 'week']);
    expect(scopeOptionsFor(false).map((o) => o.value)).toEqual(['day', 'week', 'atlas']);
  });

  it('ships Your map alone in PR1', () => {
    expect(ATLAS_LAYOUT_OPTIONS.map((o) => o.value)).toEqual(['map']);
    expect(ATLAS_LAYOUT_OPTIONS[0].label).toBe(ATLAS_COPY.layoutMap);
  });

  it('honours no grouping on atlas', () => {
    expect(groupBySupport('atlas', 'buckets', 'project').honoured).toBe(false);
    expect(groupBySupport('atlas', 'buckets', 'none').honoured).toBe(true);
  });
});

describe('stepScope', () => {
  it('is a no-op on atlas', () => {
    useViewStore.setState({ scope: 'atlas' });
    const before = usePlannerStore.getState().selectedDate.getTime();
    stepScope(1);
    stepScope(-1);
    stepScope(1);
    expect(usePlannerStore.getState().selectedDate.getTime()).toBe(before);
  });
});

describe('the registry', () => {
  it('adds view.scopeAtlas, desktop only, with its words from atlas-copy', () => {
    const c = cmd('view.scopeAtlas');
    expect(c.label).toBe(ATLAS_COPY.switchTo);
    const hidden = (x: CommandContext) => (typeof c.hidden === 'function' ? c.hidden(x) : !!c.hidden);
    expect(hidden(mobile)).toBe(true);
    expect(hidden(ctx)).toBe(false);
    expect(available('view.scopeAtlas', mobile)).toBe(false);
    expect(matchCommands('', mobile).map((r) => r.command.id)).not.toContain('view.scopeAtlas');
    c.run(ctx);
    expect(useViewStore.getState().scope).toBe('atlas');
  });

  it('carries no new shortcut id', () => {
    expect(cmd('view.scopeAtlas').shortcut).toBeUndefined();
  });

  it('gates the day-only commands off atlas', () => {
    const gated = [
      'goto.next',
      'goto.previous',
      'view.layout',
      'view.typeFilter',
      'view.groupBy',
      'view.filterProject',
      'view.clearFilters',
      'view.zen',
    ];
    usePlannerStore.setState({ projects: [{ id: 'p1', name: 'Work', emoji: '' }] as never });
    useViewStore.setState({ canvasFilters: { ...useViewStore.getState().canvasFilters, priorities: ['high'] } as never });
    for (const id of gated) expect(available(id), `${id} on day`).toBe(true);
    useViewStore.setState({ scope: 'atlas' });
    for (const id of gated) expect(available(id), `${id} on atlas`).toBe(false);
  });

  it('v goes back to Day from atlas, and says so', () => {
    useViewStore.setState({ scope: 'atlas' });
    const c = cmd('view.toggleScope');
    expect(c.dynamicLabel?.(ctx)).toBe('Switch to Day view');
    c.run(ctx);
    expect(useViewStore.getState().scope).toBe('day');
    c.run(ctx);
    expect(useViewStore.getState().scope).toBe('week');
    c.run(ctx);
    expect(useViewStore.getState().scope).toBe('day');
  });

  it('a date command from atlas goes to that day', () => {
    for (const id of ['goto.today', 'goto.tomorrow', 'goto.yesterday']) {
      useViewStore.setState({ scope: 'atlas' });
      findCommand(id, ctx)!.run(ctx);
      expect(useViewStore.getState().scope, id).toBe('day');
    }
  });

  it('adds a task from atlas exactly as from day: undated, organizers shown', () => {
    useViewStore.setState({ scope: 'atlas' });
    cmd('create.task').run(ctx);
    const dialog = useUIStore.getState().activeDialog as { type: string; date?: Date } | null;
    expect(dialog?.type).toBe('add');
    expect(dialog?.date).toBeUndefined();
    useViewStore.setState({ scope: 'day' });
    cmd('create.task').run(ctx);
    expect((useUIStore.getState().activeDialog as { date?: Date }).date).toBeUndefined();
  });

  it('setScope(atlas) moves the hidden selected day to today, so palette verbs and the status bar act on today', () => {
    usePlannerStore.setState({ selectedDate: new Date(2020, 0, 2, 12) });
    useViewStore.getState().setScope('atlas');
    const sel = usePlannerStore.getState().selectedDate;
    expect(Math.abs(sel.getTime() - Date.now())).toBeLessThan(5000);
    useViewStore.getState().setScope('day');
  });
});
