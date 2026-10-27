// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ItemNote } from '@/lib/item-notes';

/**
 * Notes on the timeline with no AI (components/planner/item-notes.tsx inside
 * ItemTimeline): a saved note's row, Move to Notes, editing, the delete
 * confirm, a pending note's menu, the "Show all" fold, and Escape
 * through the item's Escape ladder in the modal, the drawer and the panel.
 */

const api = vi.hoisted(() => ({
  listItemNotes: vi.fn(),
  getItemNote: vi.fn(),
  insertItemNote: vi.fn(),
  updateItemNoteBody: vi.fn(),
  deleteItemNote: vi.fn(),
}));
vi.mock('@/lib/item-notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/item-notes')>()),
  ...api,
}));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchTrashedNames: vi.fn(async () => ({ projects: [] })),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
}));
vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order', 'in', 'is', 'limit']) b[k] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return { from: () => b, storage: { from: () => ({}) } };
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
}));
const mobile = vi.hoisted(() => ({ current: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.current }));

import { ItemTimeline } from '@/components/planner/item-timeline';
import { ItemDialog } from '@/components/planner/item-dialog';
import { clearItemNotesState, useItemNotesStore } from '@/lib/item-notes-store';
import { useRailStore } from '@/lib/rail-store';
import { usePlannerStore } from '@/lib/planner-store';
import { seedAI, NOTHING_CONNECTED } from './helpers/ai-fixtures';
import type { TaskItem } from '@/lib/planner-types';

const ITEM: TaskItem = {
  type: 'task',
  id: 'i1',
  title: 'Call the dentist',
  status: 'pending',
  isScheduled: false,
  order: 0,
};

const note = (id: string, over: Partial<ItemNote> = {}): ItemNote => ({
  id,
  itemId: 'i1',
  body: `Note ${id}`,
  createdAt: new Date(new Date().setHours(9, 0, 0, 0)).toISOString(),
  editedAt: null,
  pinnedAt: null,
  ...over,
});
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

let unseed = () => {};
beforeEach(() => {
  unseed = seedAI(NOTHING_CONNECTED);
  for (const f of Object.values(api)) f.mockReset();
  api.listItemNotes.mockResolvedValue([]);
  api.insertItemNote.mockImplementation(async ({ id, body }: { id: string; body: string }) => ({
    ok: true,
    note: note(id, { body, createdAt: new Date().toISOString() }),
  }));
  api.deleteItemNote.mockResolvedValue(true);
  api.updateItemNoteBody.mockResolvedValue({ ok: true, editedAt: new Date().toISOString() });
  mobile.current = false;
});
afterEach(() => {
  cleanup();
  unseed();
  clearItemNotesState();
  useRailStore.getState().reset();
});

const timeline = async (notes: ItemNote[] = []) => {
  api.listItemNotes.mockResolvedValue(notes);
  const view = render(<ItemTimeline item={ITEM} />);
  await act(async () => {});
  return view;
};

const openMenu = (scope: HTMLElement) => {
  fireEvent.pointerDown(within(scope).getByTestId('item-note-menu'), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  });
};
const pick = (testId: string) => fireEvent.click(screen.getByTestId(testId));

const rows = () => screen.queryAllByTestId('item-timeline-note');
const rowOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="item-timeline-note"][data-note-id="${id}"]`)!;

describe('an old note', () => {
  it('draws no box to write one: the item’s Notes field is where notes go now', async () => {
    await timeline([note('a')]);
    expect(rows()).toHaveLength(1);
    expect(screen.queryByTestId('item-note-box')).toBeNull();
    expect(screen.queryByTestId('item-note-input')).toBeNull();
    expect(screen.queryByTestId('item-note-pinned')).toBeNull();
  });

  it('draws nothing before the first read answers, nor without 082', async () => {
    const read = deferred<unknown>();
    api.listItemNotes.mockReturnValue(read.promise);
    const first = render(<ItemTimeline item={ITEM} />);
    await act(async () => {});
    expect(rows()).toHaveLength(0);
    first.unmount();
    clearItemNotesState();
    api.listItemNotes.mockResolvedValue('unavailable');
    const { container } = render(<ItemTimeline item={ITEM} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('shows as a row with you as its author, its body in sans', async () => {
    await timeline([note('a', { body: 'Bring the insurance card' })]);
    const row = rowOf('a');
    expect(row).toHaveTextContent('You · note');
    expect(within(row).getByText('Bring the insurance card').className).toContain('font-sans');
  });

  it('keeps a once-pinned note in the stream, with no pin in its menu', async () => {
    await timeline([note('a', { pinnedAt: new Date().toISOString() })]);
    expect(rows()).toHaveLength(1);
    openMenu(rowOf('a'));
    expect(screen.queryByTestId('item-note-pin')).toBeNull();
    expect(screen.queryByTestId('item-note-unpin')).toBeNull();
  });

  it('Move to Notes puts its words after the description and takes it off the timeline', async () => {
    const updateTask = vi.fn();
    usePlannerStore.setState({ items: [{ ...ITEM, notes: 'Ask about the crown' }], updateTask } as never);
    await timeline([note('a', { body: 'Bring the insurance card' })]);
    openMenu(rowOf('a'));
    await act(async () => pick('item-note-move'));
    expect(updateTask).toHaveBeenCalledWith('i1', { notes: 'Ask about the crown\n\nBring the insurance card' });
    expect(api.deleteItemNote).toHaveBeenCalledWith('a');
    expect(rows()).toHaveLength(0);
  });
});

describe('editing', () => {
  const startEdit = async (id = 'a') => {
    openMenu(rowOf(id));
    await act(async () => pick('item-note-edit'));
    return screen.getByTestId('item-note-editor').querySelector('textarea')!;
  };

  it('Save shows edited, and the editor stays open while the save is on its way', async () => {
    await timeline([note('a')]);
    const answer = deferred<unknown>();
    api.updateItemNoteBody.mockReturnValue(answer.promise);
    const field = await startEdit();
    fireEvent.change(field, { target: { value: 'Note a, longer now' } });
    await act(async () => pick('item-note-save'));
    expect(screen.getByTestId('item-note-editor')).toBeInTheDocument();
    expect(field).toHaveAttribute('readonly');
    await act(async () => answer.resolve({ ok: true, editedAt: new Date().toISOString() }));
    expect(screen.queryByTestId('item-note-editor')).toBeNull();
    expect(rowOf('a')).toHaveTextContent('edited');
    expect(rowOf('a')).toHaveTextContent('Note a, longer now');
  });

  it.each(['failed', 'conflict', 'gone'] as const)(
    'stays open with the new text when the save is %s',
    async (refusal) => {
      await timeline([note('a')]);
      api.updateItemNoteBody.mockResolvedValue({ ok: false, refusal });
      const field = await startEdit();
      fireEvent.change(field, { target: { value: 'my new words' } });
      await act(async () => pick('item-note-save'));
      const editor = screen.getByTestId('item-note-editor');
      expect(editor.querySelector('textarea')).toHaveValue('my new words');
    }
  );

  it('a lost note’s Cancel takes it off the screen', async () => {
    await timeline([note('a')]);
    api.updateItemNoteBody.mockResolvedValue({ ok: false, refusal: 'gone' });
    const field = await startEdit();
    fireEvent.change(field, { target: { value: 'my new words' } });
    await act(async () => pick('item-note-save'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('item-note-editor')).toBeNull();
    expect(rows()).toHaveLength(0);
  });
});

describe('editing and its menu', () => {
  const startEdit = async (scope: HTMLElement) => {
    openMenu(scope);
    await act(async () => pick('item-note-edit'));
    return screen.getByTestId('item-note-editor').querySelector('textarea')!;
  };

  it('hides the note’s menu while it is being edited or confirmed, so it cannot be moved out from under the editor', async () => {
    await timeline([note('a')]);
    await startEdit(rowOf('a'));
    expect(within(rowOf('a')).queryByTestId('item-note-menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    openMenu(rowOf('a'));
    await act(async () => pick('item-note-delete'));
    expect(within(rowOf('a')).queryByTestId('item-note-menu')).toBeNull();
  });

  it('a lost note goes from the store once its editor is gone, when the item closes without Cancel', async () => {
    const view = await timeline([note('a')]);
    api.updateItemNoteBody.mockResolvedValue({ ok: false, refusal: 'gone' });
    const field = await startEdit(rowOf('a'));
    fireEvent.change(field, { target: { value: 'my new words' } });
    await act(async () => pick('item-note-save'));
    expect(useItemNotesStore.getState().lost.a).toBe(true);
    view.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useItemNotesStore.getState().lost.a).toBeUndefined();
    expect(useItemNotesStore.getState().byItem.i1?.notes ?? []).toHaveLength(0);
  });
});

describe('deleting', () => {
  it('Delete, then Keep, leaves it; Delete, then Delete, removes it', async () => {
    await timeline([note('a')]);
    openMenu(rowOf('a'));
    await act(async () => pick('item-note-delete'));
    expect(rowOf('a')).toHaveTextContent('Delete this note?');
    fireEvent.click(screen.getByTestId('item-note-keep'));
    expect(screen.queryByTestId('item-note-confirm')).toBeNull();
    expect(rows()).toHaveLength(1);
    openMenu(rowOf('a'));
    await act(async () => pick('item-note-delete'));
    await act(async () => pick('item-note-confirm'));
    expect(api.deleteItemNote).toHaveBeenCalledWith('a');
    expect(rows()).toHaveLength(0);
  });
});

describe('a pending note and a long one', () => {
  it('disables the menu of a note whose insert has not answered', async () => {
    await timeline([note('a')]);
    act(() => useItemNotesStore.setState({ pending: { a: true } }));
    const menu = within(rowOf('a')).getByTestId('item-note-menu');
    expect(menu).toBeDisabled();
    expect(menu).toHaveAttribute('aria-disabled', 'true');
    act(() => useItemNotesStore.setState({ pending: {} }));
    expect(within(rowOf('a')).getByTestId('item-note-menu')).toBeEnabled();
  });

  it('clamps a 600-character note under Show all', async () => {
    await timeline([note('a', { body: 'x'.repeat(600) })]);
    const body = within(rowOf('a')).getByTestId('item-note-body');
    expect(body.className).toContain('line-clamp-8');
    fireEvent.click(screen.getByTestId('item-note-more'));
    expect(screen.getByTestId('item-note-more')).toHaveTextContent('Show less');
    expect(body.className).not.toContain('line-clamp-8');
  });
});

describe('Escape through the item’s ladder', () => {
  const surfaces = [
    [
      'the modal (Radix Dialog)',
      () => <ItemDialog state={{ mode: 'edit', item: ITEM }} onOpenChange={onOpenChange} />,
      false,
    ],
    ['the drawer (vaul)', () => <ItemDialog state={{ mode: 'edit', item: ITEM }} onOpenChange={onOpenChange} />, true],
    [
      'the desktop panel',
      () => <ItemDialog presentation="panel" state={{ mode: 'edit', item: ITEM }} onOpenChange={onOpenChange} />,
      false,
    ],
  ] as const;
  const onOpenChange = vi.fn();

  beforeEach(() => {
    onOpenChange.mockReset();
    usePlannerStore.setState({ items: [ITEM] } as never);
  });

  it.each(surfaces)('in %s, cancels the edit and leaves the item open', async (_, ui, isMobile) => {
    mobile.current = isMobile;
    api.listItemNotes.mockResolvedValue([note('a')]);
    render(ui());
    await act(async () => {});
    await act(async () => {});
    openMenu(rowOf('a'));
    await act(async () => pick('item-note-edit'));
    const field = screen.getByTestId('item-note-editor').querySelector('textarea')!;
    field.focus();
    fireEvent.change(field, { target: { value: 'half an edit' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByTestId('item-note-editor')).toBeNull();
    expect(rowOf('a')).toHaveTextContent('Note a');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId('item-dialog')).toBeInTheDocument();
  });

  it.each(surfaces)('in %s, Escape on the delete confirm means Keep', async (_, ui, isMobile) => {
    mobile.current = isMobile;
    api.listItemNotes.mockResolvedValue([note('a')]);
    render(ui());
    await act(async () => {});
    await act(async () => {});
    openMenu(rowOf('a'));
    await act(async () => pick('item-note-delete'));
    const keep = screen.getByTestId('item-note-keep');
    keep.focus();
    fireEvent.keyDown(keep, { key: 'Escape' });
    expect(screen.queryByTestId('item-note-confirm')).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(api.deleteItemNote).not.toHaveBeenCalled();
  });
});
