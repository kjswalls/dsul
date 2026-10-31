import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';

/**
 * An Atlas card as a drop target (components/views/atlas/atlas-card-drop.tsx)
 * and a card's rows as drag sources (atlas-row.tsx), PR4:
 * - the droppable carries the contract's markers (data-dnd-id, -over, -acts);
 * - it lights lime only when the drop would write, says "Drop to file in …",
 *   "Already here", or the refusal's reason, and is off under the focus sheet;
 * - the ring is its own element and nothing on it is an opacity;
 * - a card's rows register an `atlasrow:` draggable; the focus sheet's do not.
 */

const drop = vi.hoisted(() => ({
  isOver: false,
  activeId: null as string | null,
  disabled: [] as boolean[],
  dragIds: [] as string[],
  dragging: false,
  pointerDowns: 0,
  ctxActive: null as { id: string } | null,
  measured: [] as unknown[][],
}));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    useDroppable: (args: { id: string; disabled?: boolean }) => {
      drop.disabled.push(!!args.disabled);
      return {
        isOver: drop.isOver,
        active: drop.activeId ? { id: drop.activeId } : null,
        setNodeRef: () => {},
        node: { current: null },
        over: null,
        rect: { current: null },
      };
    },
    useDraggable: (args: { id: string }) => {
      drop.dragIds.push(args.id);
      return {
        isDragging: drop.dragging,
        setNodeRef: () => {},
        listeners: { onPointerDown: () => void drop.pointerDowns++ },
        attributes: {},
        transform: null,
        node: { current: null },
        active: null,
        over: null,
      };
    },
    useDndContext: () => ({
      active: drop.ctxActive,
      droppableContainers: new Map([
        ['sidebar', {}],
        [`atlas:routine:22222222-2222-4222-8222-222222222222`, {}],
      ]),
      measureDroppableContainers: (ids: unknown[]) => void drop.measured.push(ids),
    }),
  };
});
const ui = vi.hoisted(() => ({ openEditFor: vi.fn(), space: false }));
vi.mock('@/components/views/atlas/atlas-surface', () => ({ atlasSpaceHeld: () => ui.space }));
vi.mock('@/lib/ui-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/ui-store')>();
  return { ...actual, openEditFor: ui.openEditFor };
});
vi.mock('@/lib/db', () => ({ updateItem: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { act, fireEvent } from '@testing-library/react';
import { AtlasCardDrop, AtlasDropRemeasure } from '@/components/views/atlas/atlas-card-drop';
import { AtlasRow } from '@/components/views/atlas/atlas-row';
import { atlasMissMessage } from '@/components/shell/app-shell';
import { usePlannerStore } from '@/lib/planner-store';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { useSelectionStore } from '@/lib/selection-store';
import { atlasRowDragId } from '@/lib/dnd/atlas-ids';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { routine, task } from './helpers/atlas-fixtures';

const R = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  drop.isOver = false;
  drop.activeId = null;
  drop.disabled = [];
  drop.dragIds = [];
  drop.dragging = false;
  drop.pointerDowns = 0;
  drop.ctxActive = null;
  drop.measured = [];
  ui.openEditFor.mockClear();
  ui.space = false;
  usePlannerStore.setState({
    items: [task({ id: 'a', title: 'One' }), task({ id: 'kid', parentItemId: 'a' } as never)],
    projects: [],
    routines: [routine(R, ['in'], { name: 'Morning' }), routine('r2', ['a'], { name: 'Evening' })],
    seasons: [],
    goals: [],
  } as never);
  useAtlasUiStore.setState({ sheet: null, camera: { x: 0, y: 0, z: 1 } });
  useSelectionStore.getState().clear();
});
afterEach(cleanup);

const zone = () => document.querySelector<HTMLElement>('[data-testid="atlas-card-drop"]')!;
const hint = () => document.querySelector('[data-testid="atlas-card-drop-hint"]')?.textContent ?? null;
const mount = () => render(<AtlasCardDrop kind="routine" id={R} name="Morning" />);

describe('AtlasCardDrop', () => {
  it('carries the contract markers at rest, with no hint and no ring', () => {
    mount();
    expect(zone().dataset).toMatchObject({ dndId: `atlas:routine:${R}`, dndOver: 'false', dndActs: 'false' });
    expect(zone().className).not.toContain('atlas-drop-ring');
    expect(hint()).toBeNull();
  });

  it('lights lime and says where it files while a braindump row is over it', () => {
    drop.isOver = true;
    drop.activeId = 'a';
    mount();
    expect(zone().dataset).toMatchObject({ dndOver: 'true', dndActs: 'true' });
    expect(zone().className).toContain('atlas-drop-ring');
    expect(hint()).toBe(ATLAS_COPY.dropToFile('Morning'));
  });

  it('a row already in it reads "Already here" and does not light', () => {
    usePlannerStore.setState({ items: [task({ id: 'in' })] } as never);
    drop.isOver = true;
    drop.activeId = atlasRowDragId('routine', R, 'in');
    mount();
    expect(zone().dataset.dndActs).toBe('false');
    expect(zone().className).not.toContain('atlas-drop-ring');
    expect(hint()).toBe(ATLAS_COPY.alreadyHere);
  });

  it('a refusal shows its reason', () => {
    drop.isOver = true;
    drop.activeId = 'kid';
    mount();
    expect(zone().dataset.dndActs).toBe('false');
    expect(hint()).toBe(ATLAS_COPY.subtaskStays);
  });

  it('a multi-selection is judged as the group the shell will file', () => {
    useSelectionStore.getState().replace(['kid', 'a']);
    drop.isOver = true;
    drop.activeId = 'kid';
    mount();
    // The subtask alone would refuse; the group files 'a'.
    expect(zone().dataset.dndActs).toBe('true');
  });

  it('is disabled while the focus sheet is open', () => {
    useAtlasUiStore.setState({ sheet: { kind: 'routine', id: R, from: null } } as never);
    mount();
    expect(drop.disabled.at(-1)).toBe(true);
  });

  it('draws the ring on its own element, with no opacity anywhere (the accent rule)', () => {
    const src = readFileSync('components/views/atlas/atlas-card-drop.tsx', 'utf8');
    expect(src).not.toMatch(/opacity-|opacity:|opacity\s*\}/);
    const css = readFileSync('app/globals.css', 'utf8');
    const rule = css.slice(css.indexOf('.atlas-drop-ring {'), css.indexOf('/* The braindump\'s landing slot'));
    expect(rule).toContain('var(--primary)');
    expect(rule).not.toMatch(/opacity\s*:/);
    // Reduced motion stops the breath.
    expect(css).toMatch(/\[data-reduce-motion='true'\] \.atlas-drop-ring/);
  });
});

describe('which rows drag', () => {
  const member = { item: task({ id: 'a', title: 'One' }), state: 'open', todayState: undefined } as never;
  const row = (extra: Record<string, unknown> = {}) => (
    <AtlasRow member={member} cardKey="routine:r2" cardRowIds={['a']} todayStr="2026-03-10" milestoneIds={new Set()} {...extra} />
  );
  const rowEl = () => document.querySelector<HTMLElement>('[data-testid="atlas-row"]')!;

  it("a card's row registers its card's `atlasrow:` id; a row with no card (the focus sheet's) registers none", () => {
    render(row({ drag: 'routine', containerId: 'r2' }));
    expect(drop.dragIds).toEqual([atlasRowDragId('routine', 'r2', 'a')]);
    cleanup();
    drop.dragIds = [];
    render(row());
    expect(drop.dragIds).toEqual([]);
    expect(readFileSync('components/views/atlas/atlas-focus-sheet.tsx', 'utf8')).not.toMatch(/\bdrag=/);
  });

  it('the click a drop leaves behind does not open the item; the next click does', async () => {
    drop.dragging = true;
    const view = render(row({ drag: 'routine', containerId: 'r2' }));
    drop.dragging = false;
    view.rerender(row({ drag: 'routine', containerId: 'r2', cardRowIds: ['a', 'x'] }));
    fireEvent.click(rowEl());
    expect(ui.openEditFor).not.toHaveBeenCalled();
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(rowEl());
    expect(ui.openEditFor).toHaveBeenCalledTimes(1);
  });

  it('Space held: the press goes to the board\'s pan, never to the row\'s drag', () => {
    render(row({ drag: 'routine', containerId: 'r2' }));
    fireEvent.pointerDown(rowEl());
    expect(drop.pointerDowns).toBe(1);
    ui.space = true;
    fireEvent.pointerDown(rowEl());
    expect(drop.pointerDowns).toBe(1);
  });
});

describe('the camera during a drag', () => {
  it('a camera change mid-drag re-measures the cards (only the atlas ids), once per frame', async () => {
    drop.ctxActive = { id: 'a' };
    render(<AtlasDropRemeasure />);
    act(() => {
      useAtlasUiStore.setState({ camera: { x: 40, y: 0, z: 1 } });
      useAtlasUiStore.setState({ camera: { x: 80, y: 0, z: 1 } });
    });
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(drop.measured).toEqual([[`atlas:routine:${R}`]]);
  });

  it('with no drag, a camera change measures nothing', async () => {
    render(<AtlasDropRemeasure />);
    act(() => useAtlasUiStore.setState({ camera: { x: 40, y: 0, z: 1 } }));
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(drop.measured).toEqual([]);
  });

  it('the hint counter-scales by the zoom, so it reads at its own size', () => {
    useAtlasUiStore.setState({ camera: { x: 0, y: 0, z: 0.5 } });
    drop.isOver = true;
    drop.activeId = 'a';
    mount();
    expect(document.querySelector<HTMLElement>('[data-testid="atlas-card-drop-hint"]')!.style.scale).toBe('2');
  });
});

describe('a release on the board with no card under it', () => {
  it('says to drop it on a card; in the far zoom, to zoom in', () => {
    expect(atlasMissMessage()).toBe(ATLAS_COPY.dropOnCard);
    useAtlasUiStore.setState({ camera: { x: 0, y: 0, z: 0.3 } });
    expect(atlasMissMessage()).toBe(ATLAS_COPY.zoomInToFile);
  });

  it('says nothing under the focus sheet or while previewing (every card is off then)', () => {
    useAtlasUiStore.setState({ sheet: { kind: 'routine', id: R, from: null } } as never);
    expect(atlasMissMessage()).toBeNull();
    useAtlasUiStore.setState({ sheet: null });
    usePlannerStore.setState({ isPreview: true } as never);
    try {
      expect(atlasMissMessage()).toBeNull();
    } finally {
      usePlannerStore.setState({ isPreview: false } as never);
    }
  });
});
