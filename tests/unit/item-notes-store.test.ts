import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemNote } from '@/lib/item-notes';

/**
 * lib/item-notes-store.ts: optimistic writes with rollback, pending rows,
 * the lost-answer read back and the retry id, the put-back into the NOTE
 * draft, merged loads, the epoch, and the preview backstop.
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
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const preview = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/planner-ready', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planner-ready')>()),
  isPlannerPreviewing: () => preview.on,
}));

import { clearItemNotesState, getItemNotesEpoch, saveNoteFrom, useItemNotesStore } from '@/lib/item-notes-store';
import { bindingKey, noteDraftKey, useRailStore } from '@/lib/rail-store';

const note = (id: string, over: Partial<ItemNote> = {}): ItemNote => ({
  id,
  itemId: 'i1',
  body: `body ${id}`,
  createdAt: '2026-10-23T09:00:00.000Z',
  editedAt: null,
  pinnedAt: null,
  ...over,
});
const notes = () => useItemNotesStore.getState().byItem.i1?.notes ?? [];
const seed = (list: ItemNote[]) =>
  useItemNotesStore.setState({ available: true, byItem: { i1: { status: 'ready', notes: list } } });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const store = () => useItemNotesStore.getState();
const ASK_KEY = bindingKey({ kind: 'item', itemId: 'i1' });
const NOTE_KEY = noteDraftKey('i1');

beforeEach(() => {
  clearItemNotesState();
  useRailStore.getState().reset();
  for (const f of Object.values(api)) f.mockReset();
  toast.error.mockReset();
  preview.on = false;
});
afterEach(() => vi.restoreAllMocks());

describe('add', () => {
  it('shows at once, pending, and is removed on failure', async () => {
    seed([]);
    const answer = deferred<unknown>();
    api.insertItemNote.mockReturnValue(answer.promise);
    api.getItemNote.mockResolvedValue(null);
    const done = store().add('i1', 'hello');
    expect(notes().map((n) => n.body)).toEqual(['hello']);
    const id = notes()[0].id;
    expect(store().pending[id]).toBe(true);
    answer.resolve({ ok: false, refusal: 'failed' });
    expect(await done).toBe('failed');
    expect(notes()).toEqual([]);
    expect(store().pending[id]).toBeUndefined();
  });

  it('replaces the row with the server’s on success, keeping where it was placed', async () => {
    seed([]);
    api.insertItemNote.mockImplementation(async ({ id }: { id: string }) => ({
      ok: true,
      note: note(id, { body: 'hello', createdAt: '2026-10-23T12:00:00.000Z' }),
    }));
    expect(await store().add('i1', 'hello', { placedAt: 42 })).toBe(true);
    const [n] = notes();
    expect(n.createdAt).toBe('2026-10-23T12:00:00.000Z');
    expect(store().placedAt[n.id]).toBe(42);
  });

  it('counts a failed insert whose id reads back as saved', async () => {
    seed([]);
    api.insertItemNote.mockResolvedValue({ ok: false, refusal: 'failed' });
    api.getItemNote.mockImplementation(async (id: string) => note(id, { body: 'hello' }));
    expect(await store().add('i1', 'hello')).toBe(true);
    expect(notes()).toHaveLength(1);
    expect(store().retry.i1).toBeUndefined();
  });

  it('remembers one that does not read back, and a re-save of the same body reuses its id', async () => {
    seed([]);
    api.insertItemNote.mockResolvedValue({ ok: false, refusal: 'failed' });
    api.getItemNote.mockResolvedValue(null);
    await store().add('i1', 'hello');
    const kept = store().retry.i1;
    expect(kept.body).toBe('hello');
    await store().add('i1', 'hello');
    expect(api.insertItemNote.mock.calls[1][0].id).toBe(kept.id);
    await store().add('i1', 'something else');
    expect(api.insertItemNote.mock.calls[2][0].id).not.toBe(kept.id);
  });

  it('on gone removes the row and offers Copy note with the body', async () => {
    seed([]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    api.insertItemNote.mockResolvedValue({ ok: false, refusal: 'gone' });
    expect(await store().add('i1', 'keep me')).toBe('gone');
    expect(notes()).toEqual([]);
    const [msg, opts] = toast.error.mock.calls[0];
    expect(msg).toBe('This item was deleted.');
    expect(opts.action.label).toBe('Copy note');
    opts.action.onClick();
    expect(writeText).toHaveBeenCalledWith('keep me');
  });
});

describe('a pending note', () => {
  const pendingNote = async () => {
    seed([]);
    const answer = deferred<unknown>();
    api.insertItemNote.mockReturnValue(answer.promise);
    const done = store().add('i1', 'hello');
    const id = notes()[0].id;
    return { id, answer, done };
  };

  it.each(['pin', 'edit', 'remove'] as const)('refuses %s and sends nothing until the insert answers', async (verb) => {
    const { id, answer, done } = await pendingNote();
    const run = () =>
      verb === 'pin'
        ? store().pin('i1', id)
        : verb === 'edit'
          ? store().edit('i1', id, 'new')
          : store().remove('i1', id);
    expect(await run()).toBe(false);
    expect(api.pinItemNote).not.toHaveBeenCalled();
    expect(api.updateItemNoteBody).not.toHaveBeenCalled();
    expect(api.deleteItemNote).not.toHaveBeenCalled();
    answer.resolve({ ok: true, note: note(id, { body: 'hello' }) });
    await done;
    api.pinItemNote.mockResolvedValue({ ok: true, pinnedAt: '2026-10-23T10:00:00.000Z' });
    api.updateItemNoteBody.mockResolvedValue({ ok: true, editedAt: '2026-10-23T10:00:00.000Z' });
    api.deleteItemNote.mockResolvedValue(true);
    expect(await run()).toBe(true);
  });
});

describe('saveNoteFrom', () => {
  beforeEach(() => {
    seed([]);
    api.insertItemNote.mockResolvedValue({ ok: false, refusal: 'failed' });
    api.getItemNote.mockResolvedValue(null);
  });

  it('puts a failed save back into an empty NOTE draft, in Note mode, never the Ask draft', async () => {
    useRailStore.getState().setDraft(ASK_KEY, 'a question');
    expect(await saveNoteFrom('i1', 'my note')).toBe(false);
    const rail = useRailStore.getState();
    expect(rail.drafts[NOTE_KEY]).toBe('my note');
    expect(rail.drafts[ASK_KEY]).toBe('a question');
    expect(rail.boxModes[ASK_KEY]).toBe('note');
    expect(toast.error).toHaveBeenCalledWith('Couldn’t save your note. It’s back in the box.');
  });

  it('appends after a newline to a note draft that has text', async () => {
    useRailStore.getState().setDraft(NOTE_KEY, 'typed since');
    await saveNoteFrom('i1', 'my note');
    expect(useRailStore.getState().drafts[NOTE_KEY]).toBe('typed since\nmy note');
  });

  it('a save that finds 082 missing offers Copy note and puts nothing in a draft no box shows', async () => {
    api.insertItemNote.mockResolvedValue({ ok: false, refusal: 'unavailable' });
    expect(await saveNoteFrom('i1', 'my note')).toBe(false);
    expect(store().available).toBe(false);
    const rail = useRailStore.getState();
    expect(rail.drafts[NOTE_KEY]).toBeUndefined();
    expect(rail.boxModes[ASK_KEY]).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: expect.objectContaining({ label: 'Copy note' }) })
    );
  });

  it('during the preview puts the text back with no toast and no call', async () => {
    preview.on = true;
    expect(await saveNoteFrom('i1', 'my note')).toBe(false);
    expect(useRailStore.getState().drafts[NOTE_KEY]).toBe('my note');
    expect(api.insertItemNote).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('pin, edit and remove', () => {
  it('pin moves the pin at once, and restores both on failure', async () => {
    seed([note('a', { pinnedAt: '2026-10-22T10:00:00.000Z' }), note('b')]);
    const answer = deferred<unknown>();
    api.pinItemNote.mockReturnValue(answer.promise);
    const done = store().pin('i1', 'b');
    expect(notes().map((n) => !!n.pinnedAt)).toEqual([false, true]);
    answer.resolve({ ok: false, refusal: 'failed' });
    expect(await done).toBe(false);
    expect(notes().map((n) => n.pinnedAt)).toEqual(['2026-10-22T10:00:00.000Z', null]);
    expect(toast.error).toHaveBeenCalledWith('Couldn’t pin that note. Try again.');
  });

  it('edit rolls back on failure and returns the refusal', async () => {
    seed([note('a')]);
    api.updateItemNoteBody.mockResolvedValue({ ok: false, refusal: 'failed' });
    expect(await store().edit('i1', 'a', 'new text')).toBe('failed');
    expect(notes()[0]).toMatchObject({ body: 'body a', editedAt: null });
    expect(api.updateItemNoteBody).toHaveBeenCalledWith('a', 'new text', null);
  });

  it('a conflict rolls back and reloads the item', async () => {
    seed([note('a', { editedAt: '2026-10-22T10:00:00.000Z' })]);
    api.updateItemNoteBody.mockResolvedValue({ ok: false, refusal: 'conflict' });
    api.listItemNotes.mockResolvedValue([note('a', { body: 'their text', editedAt: '2026-10-23T08:00:00.000Z' })]);
    expect(await store().edit('i1', 'a', 'mine')).toBe('conflict');
    expect(api.updateItemNoteBody).toHaveBeenCalledWith('a', 'mine', '2026-10-22T10:00:00.000Z');
    await vi.waitFor(() => expect(notes()[0].body).toBe('their text'));
    expect(toast.error).toHaveBeenCalledWith('This note was changed somewhere else. Your text is still here.');
  });

  it('remove puts the note back at its place on failure', async () => {
    seed([note('a'), note('b'), note('c')]);
    api.deleteItemNote.mockResolvedValue(false);
    expect(await store().remove('i1', 'b')).toBe(false);
    expect(notes().map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('loads', () => {
  it('a load racing an add keeps the added note', async () => {
    seed([]);
    const read = deferred<unknown>();
    api.listItemNotes.mockReturnValue(read.promise);
    api.insertItemNote.mockImplementation(async ({ id }: { id: string }) => ({
      ok: true,
      note: note(id, { body: 'new' }),
    }));
    const loading = store().load('i1');
    await store().add('i1', 'new');
    read.resolve([note('old')]);
    await loading;
    expect(
      notes()
        .map((n) => n.body)
        .sort()
    ).toEqual(['body old', 'new']);
  });

  it('clearItemNotesState drops a load still on its way, and bumps the epoch', async () => {
    const read = deferred<unknown>();
    api.listItemNotes.mockReturnValue(read.promise);
    const loading = store().load('i1');
    const before = getItemNotesEpoch();
    clearItemNotesState();
    expect(getItemNotesEpoch()).toBeGreaterThan(before);
    read.resolve([note('a')]);
    await loading;
    expect(store().byItem.i1).toBeUndefined();
    expect(store().available).toBeNull();
  });

  it('a first read that fails leaves available unknown, so no Note box is drawn on it', async () => {
    api.listItemNotes.mockResolvedValue('failed');
    await store().load('i1');
    expect(store().available).toBeNull();
    expect(store().byItem.i1?.status).toBe('failed');
  });

  it('latches available false on a database without 082', async () => {
    api.listItemNotes.mockResolvedValue('unavailable');
    await store().load('i1');
    expect(store().available).toBe(false);
    await store().load('i1');
    expect(api.listItemNotes).toHaveBeenCalledTimes(1);
  });
});

describe('the preview backstop', () => {
  it('refuses every write with no toast and no call', async () => {
    seed([note('a')]);
    preview.on = true;
    expect(await store().add('i1', 'x')).toBe(false);
    expect(await store().edit('i1', 'a', 'x')).toBe(false);
    expect(await store().pin('i1', 'a')).toBe(false);
    expect(await store().unpin('i1', 'a')).toBe(false);
    expect(await store().remove('i1', 'a')).toBe(false);
    for (const f of Object.values(api)) expect(f).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(1);
  });
});
