// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ItemNote } from '@/lib/item-notes';

/**
 * Notes on the timeline with no AI (components/planner/item-notes.tsx inside
 * ItemTimeline): the Note box, a saved note's row, pinning, editing, the
 * delete confirm, a pending note's menu, the "Show all" fold, and Escape
 * through the item's Escape ladder in the modal, the drawer and the panel.
 */

const api = vi.hoisted(() => ({
  listItemNotes: vi.fn(),
  getItemNote: vi.fn(),
  insertItemNote: vi.fn(),
  updateItemNoteBody: vi.fn(),
  pinItemNote: vi.fn(),
  unpinItemNote: vi.fn(),
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
  let pins = 0;
  api.pinItemNote.mockImplementation(async () => ({
    ok: true,
    pinnedAt: new Date(Date.now() + ++pins * 1000).toISOString(),
  }));
  api.unpinItemNote.mockResolvedValue({ ok: true });
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

describe('the Note box with no AI', () => {
  it('is drawn alone on an item with no history: no heading and no switch', async () => {
    await timeline();
    expect(screen.getByTestId('item-note-box')).toBeInTheDocument();
    expect(screen.queryByText('Timeline')).toBeNull();
    expect(screen.queryByTestId('box-mode-ask')).toBeNull();
    expect(screen.queryByTestId('box-mode-note')).toBeNull();
  });

  it('is not drawn before the first read answers, nor without 082, and the section is null', async () => {
    const read = deferred<unknown>();
    api.listItemNotes.mockReturnValue(read.promise);
    const first = render(<ItemTimeline item={ITEM} />);
    await act(async () => {});
    expect(screen.queryByTestId('item-note-box')).toBeNull();
    first.unmount();
    clearItemNotesState();
    api.listItemNotes.mockResolvedValue('unavailable');
    const { container } = render(<ItemTimeline item={ITEM} />);
    await act(async () => {});
    expect(screen.queryByTestId('item-note-box')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('saves on Enter, and the note shows as a row, its body in serif', async () => {
    await timeline();
    const field = screen.getByTestId('item-note-input');
    fireEvent.change(field, { target: { value: 'Bring the insurance card' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(api.insertItemNote).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'i1', body: 'Bring the insurance card' })
    );
    const row = screen.getByTestId('item-timeline-note');
    expect(row).toHaveTextContent('You · note');
    const body = within(row).getByText('Bring the insurance card');
    expect(body.className).toContain('font-serif');
    expect(useRailStore.getState().drafts['note:i1']).toBeUndefined();
  });
});

describe('pinning', () => {
  it('Pin to top moves a note onto the card and out of the stream', async () => {
    await timeline([note('a')]);
    openMenu(rowOf('a'));
    await act(async () => pick('item-note-pin'));
    expect(rows()).toHaveLength(0);
    const card = screen.getByTestId('item-note-pinned');
    expect(card).toHaveTextContent('Note · pinned');
    expect(card).toHaveTextContent('Note a');
  });

  it('an item whose only history is a pinned note draws the card and its menu, and no empty line; Unpin brings the row back', async () => {
    await timeline([note('a', { pinnedAt: new Date().toISOString() })]);
    const card = screen.getByTestId('item-note-pinned');
    expect(within(card).getByTestId('item-note-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('item-timeline-empty')).toBeNull();
    expect(screen.queryByText('No changes yet.')).toBeNull();
    openMenu(card);
    await act(async () => pick('item-note-unpin'));
    expect(screen.queryByTestId('item-note-pinned')).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('pinning a second note replaces the first, which goes back to the stream', async () => {
    await timeline([note('a', { pinnedAt: new Date().toISOString() }), note('b')]);
    openMenu(rowOf('b'));
    await act(async () => pick('item-note-pin'));
    expect(screen.getByTestId('item-note-pinned')).toHaveTextContent('Note b');
    expect(rows().map((r) => r.getAttribute('data-note-id'))).toEqual(['a']);
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

describe('editing while the pin moves', () => {
  const startEdit = async (scope: HTMLElement) => {
    openMenu(scope);
    await act(async () => pick('item-note-edit'));
    return screen.getByTestId('item-note-editor').querySelector('textarea')!;
  };

  it('a different note pinned elsewhere never takes over the pinned card’s open editor', async () => {
    const at = new Date().toISOString();
    await timeline([note('a', { pinnedAt: at }), note('b')]);
    const field = await startEdit(screen.getByTestId('item-note-pinned'));
    fireEvent.change(field, { target: { value: 'half of a' } });
    // Another device pins b: the next read says so.
    act(() =>
      useItemNotesStore.setState((s) => ({
        byItem: {
          i1: {
            status: 'ready',
            notes: s.byItem.i1!.notes.map((n) => ({ ...n, pinnedAt: n.id === 'b' ? at : null })),
          },
        },
      }))
    );
    const card = screen.getByTestId('item-note-pinned');
    expect(card).toHaveAttribute('data-note-id', 'b');
    expect(within(card).queryByTestId('item-note-editor')).toBeNull();
    expect(card).toHaveTextContent('Note b');
    expect(api.updateItemNoteBody).not.toHaveBeenCalled();
  });

  it('hides the note’s menu while it is being edited or confirmed, so it cannot be pinned out from under the editor', async () => {
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
    await timeline();
    const answer = deferred<unknown>();
    api.insertItemNote.mockReturnValue(answer.promise);
    const field = screen.getByTestId('item-note-input');
    fireEvent.change(field, { target: { value: 'on its way' } });
    await act(async () => fireEvent.keyDown(field, { key: 'Enter' }));
    const menu = within(screen.getByTestId('item-timeline-note')).getByTestId('item-note-menu');
    expect(menu).toBeDisabled();
    expect(menu).toHaveAttribute('aria-disabled', 'true');
    const id = Object.keys(useItemNotesStore.getState().pending)[0];
    await act(async () => answer.resolve({ ok: true, note: note(id, { body: 'on its way' }) }));
    expect(within(screen.getByTestId('item-timeline-note')).getByTestId('item-note-menu')).toBeEnabled();
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
