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

const drop = vi.hoisted(() => ({ isOver: false, activeId: null as string | null, disabled: [] as boolean[] }));
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
  };
});
vi.mock('@/lib/db', () => ({ updateItem: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { AtlasCardDrop } from '@/components/views/atlas/atlas-card-drop';
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
  usePlannerStore.setState({
    items: [task({ id: 'a', title: 'One' }), task({ id: 'kid', parentItemId: 'a' } as never)],
    projects: [],
    routines: [routine(R, ['in'], { name: 'Morning' }), routine('r2', ['a'], { name: 'Evening' })],
    seasons: [],
    goals: [],
  } as never);
  useAtlasUiStore.setState({ sheet: null });
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
  it("a card's rows drag under their card's id; the focus sheet's rows do not (the card under it owns that id)", () => {
    expect(readFileSync('components/views/atlas/atlas-card.tsx', 'utf8')).toMatch(/drag=\{card\.kind\}\s+containerId=\{card\.id\}/);
    expect(readFileSync('components/views/atlas/atlas-focus-sheet.tsx', 'utf8')).not.toMatch(/\bdrag=/);
    const row = readFileSync('components/views/atlas/atlas-row.tsx', 'utf8');
    expect(row).toMatch(/useDraggable\(\{\s*id: atlasRowDragId\(/);
    // A drop must never open the item: the click after a drag is swallowed.
    expect(row).toMatch(/if \(dnd\?\.wasDragged\.current\) return;/);
  });
});
