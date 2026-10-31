// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DragMoveEvent, DragStartEvent } from '@dnd-kit/core';

/**
 * The shell's Atlas entry points (components/shell/app-shell.tsx), driven as
 * the shell runs them: a multi-selection dropped on a card files ALL of it, not
 * only the grabbed row, as one undo; a lone row is left to the single drop; and
 * an `atlasrow:` id is normalised to its item at drag start, so the drag store
 * (and with it the ghost, which looks the item up by the store's id) finds it.
 */

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    fetchRoutines: vi.fn(async () => []),
    fetchSeasons: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
    createItem: vi.fn(async () => {}),
    updateItem: vi.fn(async () => {}),
    updateGoal: vi.fn(async () => {}),
    updateRoutine: vi.fn(async () => {}),
    updateSeason: vi.fn(async () => {}),
    recordCheckin: vi.fn(),
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('@/lib/completion-confetti', () => ({ celebrateCompletion: vi.fn() }));

import { toast } from 'sonner';
import { beginDrag, fileSelectionOnAtlas, trackReorder } from '@/components/shell/app-shell';
import { getActionLog, usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore } from '@/lib/selection-store';
import { useDragStore } from '@/lib/drag-store';
import { atlasCardDropId, atlasRowDragId, atlasSourceOf } from '@/lib/dnd/atlas-ids';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import * as db from '@/lib/db';
import { TODAY, routine, task } from './helpers/atlas-fixtures';

const store = () => usePlannerStore.getState();

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue([
    task({ id: 'a', title: 'One' }),
    task({ id: 'b', title: 'Two' }),
    task({ id: 'kid', title: 'Sub', parentItemId: 'a' } as never),
  ]);
  vi.mocked(db.fetchRoutines).mockResolvedValue([routine('r1', [], { name: 'Morning' }), routine('r2', ['a'], { name: 'Evening' })]);
  await store().initializeStore('user-1');
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
  useSelectionStore.getState().clear();
});
afterEach(() => useDragStore.getState().endDrag());

describe('a multi-selection dropped on an Atlas card', () => {
  it('files every selected item, one undo, and clears the selection', () => {
    useSelectionStore.getState().replace(['a', 'b']);
    const entries = getActionLog().length;
    expect(fileSelectionOnAtlas(atlasCardDropId('routine', 'r1'), 'a', null)).toBe(true);
    expect(store().routines.find((r) => r.id === 'r1')!.itemIds).toEqual(['a', 'b']);
    expect(getActionLog().length).toBe(entries + 1);
    expect(useSelectionStore.getState().selectedIds.size).toBe(0);
    store().undo();
    expect(store().routines.find((r) => r.id === 'r1')!.itemIds).toEqual([]);
  });

  it('moves the selection off the card it came from', () => {
    useSelectionStore.getState().replace(['a', 'b']);
    const source = atlasSourceOf(atlasRowDragId('routine', 'r2', 'a'));
    fileSelectionOnAtlas(atlasCardDropId('routine', 'r1'), 'a', source);
    expect(store().routines.find((r) => r.id === 'r2')!.itemIds).toEqual([]);
    expect(store().routines.find((r) => r.id === 'r1')!.itemIds).toEqual(['a', 'b']);
  });

  it('a selection none of which can join says why and keeps the selection', () => {
    useSelectionStore.getState().replace(['kid', 'a']);
    // 'a' is already in r2 and the subtask can not be collected.
    expect(fileSelectionOnAtlas(atlasCardDropId('routine', 'r2'), 'kid', null)).toBe(true);
    expect(toast).toHaveBeenCalledWith(ATLAS_COPY.subtaskStays);
    expect(useSelectionStore.getState().selectedIds.size).toBe(2);
  });

  it('a lone row, or any other target, is left to the shell', () => {
    useSelectionStore.getState().replace(['a']);
    expect(fileSelectionOnAtlas(atlasCardDropId('routine', 'r1'), 'a', null)).toBe(false);
    useSelectionStore.getState().replace(['a', 'b']);
    expect(fileSelectionOnAtlas('sidebar', 'a', null)).toBe(false);
    // The grabbed row is not in the selection: not a group drop.
    expect(fileSelectionOnAtlas(atlasCardDropId('routine', 'r1'), 'kid', null)).toBe(false);
    expect(store().routines.find((r) => r.id === 'r1')!.itemIds).toEqual([]);
  });
});

describe('an Atlas row id at the shell entry points', () => {
  const pointer = { pointerType: 'mouse', clientX: 10, clientY: 10 } as unknown as Event;

  it('beginDrag stores the item id, so the ghost finds its item', () => {
    beginDrag({ active: { id: atlasRowDragId('routine', 'r2', 'a') }, activatorEvent: pointer } as unknown as DragStartEvent);
    const { activeId } = useDragStore.getState();
    expect(activeId).toBe('a');
    // The ghost's own lookup (components/shell/drag-ghost.tsx).
    expect(store().items.find((i) => i.id === activeId)?.title).toBe('One');
  });

  it('trackReorder never sees an atlasrow id as a row of its own', () => {
    expect(() =>
      trackReorder({
        active: { id: atlasRowDragId('routine', 'r2', 'a') },
        activatorEvent: pointer,
        delta: { x: 5, y: 5 },
      } as unknown as DragMoveEvent),
    ).not.toThrow();
    expect(useDragStore.getState().reorder).toBeNull();
  });
});
