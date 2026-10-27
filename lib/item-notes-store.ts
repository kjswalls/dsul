import { useEffect } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import {
  NOTE_COPY,
  cleanNoteBody,
  deleteItemNote,
  getItemNote,
  insertItemNote,
  listItemNotes,
  noteLength,
  noteRefusal,
  updateItemNoteBody,
  type ItemNote,
  type NoteRefusal,
} from '@/lib/item-notes';
import { isPlannerPreviewing } from '@/lib/planner-ready';
import { noteKey, syncSheen } from '@/lib/sync-sheen';

/**
 * Notes on an item, as its timeline shows them (lib/item-notes.ts, migration
 * 082). Memory only, never persisted: the list is the database's, fetched when
 * a view of the item mounts. `available` is null until the first read answers
 * and false once a read says 082 is not applied. No surface writes a new
 * note since the panel tidy, round 3 (the item's description is the one place
 * to write); what was written stays, to read, edit, delete or move into the
 * description.
 *
 * OPTIMISTIC, WITH ROLLBACK. Every write changes the store first and undoes
 * exactly its own change on failure, with a toast from NOTE_COPY. An add shows
 * at once and is `pending` until its insert answers; while it is, its menu and
 * editor are disabled and edit and remove are refused here too, so no
 * write can reach the server before the row exists there. An add that failed
 * with `failed` is read back once by id (its answer may have been lost); one
 * that is truly not there is remembered (`retry`), so a re-save of the same
 * body reuses its id and can never make a second copy.
 *
 * A load MERGES: a note added, edited or removed while a read was on
 * its way (or still in flight when it began) keeps its local state, so a
 * reload never undoes a write that raced it.
 *
 * EPOCH. clearItemNotesState (sign-out, an account switch: lib/local-state.ts
 * RAW_CLEARERS) empties the store and bumps a module epoch; a read or write
 * that started before it drops its answer, so one account's notes never land
 * in the next account's store.
 *
 * THE PREVIEW BACKSTOP. Every write returns false with no toast while the
 * instant planner preview is up (lib/planner-ready.ts): no surface that writes
 * a note can be used then anyway, and this keeps a future one from writing
 * against an item the landing may reveal as deleted.
 *
 * Nothing here is sent to a model or an agent.
 */

type Entry = { status: 'loading' | 'ready' | 'failed'; notes: ItemNote[] };

interface ItemNotesState {
  available: boolean | null;
  byItem: Record<string, Entry>;
  /** Where a note written on this page sits on the timeline (client ms), by note id. */
  placedAt: Record<string, number>;
  /** Notes whose insert has not answered yet, by id. Their menu and editor are disabled. */
  pending: Record<string, true>;
  /** The id and body of an add that failed with `failed`, by item: a re-save of the same body reuses the id. */
  retry: Record<string, { id: string; body: string }>;
  /**
   * Notes found deleted elsewhere while being edited, by id: kept in the list,
   * holding the text you wrote, so the open editor stays over it (with a Copy
   * note toast) until its Cancel `forget`s it, or until no editor shows it any
   * more (holdNoteEditor). No write reaches the server for one.
   */
  lost: Record<string, true>;
  load(itemId: string): Promise<void>;
  add(itemId: string, body: string, opts?: { placedAt?: number }): Promise<NoteRefusal | boolean>;
  edit(itemId: string, noteId: string, body: string): Promise<NoteRefusal | boolean>;
  remove(itemId: string, noteId: string): Promise<boolean>;
  /** Drop a `lost` note from the screen (its editor's Cancel). */
  forget(itemId: string, noteId: string): void;
}

let epoch = 0;

/** The store's epoch, bumped by every clear (lib/local-state.ts tests read it). */
export function getItemNotesEpoch(): number {
  return epoch;
}

/** Per item, the ids each read now on its way must leave as they are on screen. */
const racing = new Map<string, Set<Set<string>>>();
/** Items whose notes have been read this epoch: a read after the first is news. */
const reread = new Set<string>();
/** Per item, how many writes are in flight for each note id. */
const inflight = new Map<string, Map<string, number>>();

function begin(itemId: string, ...ids: string[]): () => void {
  let byId = inflight.get(itemId);
  if (!byId) inflight.set(itemId, (byId = new Map()));
  for (const id of ids) {
    byId.set(id, (byId.get(id) ?? 0) + 1);
    for (const since of racing.get(itemId) ?? []) since.add(id);
  }
  return () => {
    const m = inflight.get(itemId);
    for (const id of ids) {
      const n = (m?.get(id) ?? 1) - 1;
      if (n <= 0) m?.delete(id);
      else m?.set(id, n);
      for (const since of racing.get(itemId) ?? []) since.add(id);
    }
  };
}

const byCreated = (a: ItemNote, b: ItemNote) => Date.parse(a.createdAt) - Date.parse(b.createdAt);

function copyAction(body: string) {
  return {
    label: NOTE_COPY.copyNote,
    onClick: () => {
      void navigator.clipboard?.writeText(body).catch(() => {});
    },
  };
}

export const useItemNotesStore = create<ItemNotesState>((set, get) => {
  const notesOf = (itemId: string) => get().byItem[itemId]?.notes ?? [];
  const write = (itemId: string, change: (notes: ItemNote[]) => ItemNote[]) =>
    set((s) => {
      const entry = s.byItem[itemId];
      return {
        byItem: {
          ...s.byItem,
          [itemId]: { status: entry?.status ?? 'ready', notes: change(entry?.notes ?? []) },
        },
      };
    });
  const patch = (itemId: string, noteId: string, fields: Partial<ItemNote>) =>
    write(itemId, (notes) => notes.map((n) => (n.id === noteId ? { ...n, ...fields } : n)));
  const drop = (itemId: string, noteId: string) => write(itemId, (notes) => notes.filter((n) => n.id !== noteId));
  /** A write may go ahead: not during the preview, and never on a note whose insert has not answered. */
  const refused = (noteId?: string) =>
    isPlannerPreviewing() || (noteId !== undefined && (!!get().pending[noteId] || !!get().lost[noteId]));

  return {
    available: null,
    byItem: {},
    placedAt: {},
    pending: {},
    retry: {},
    lost: {},

    async load(itemId) {
      if (get().available === false) return;
      const started = epoch;
      const since = new Set<string>(inflight.get(itemId)?.keys() ?? []);
      let reads = racing.get(itemId);
      if (!reads) racing.set(itemId, (reads = new Set()));
      reads.add(since);
      set((s) => ({
        byItem: { ...s.byItem, [itemId]: { status: 'loading', notes: s.byItem[itemId]?.notes ?? [] } },
      }));
      const got = await listItemNotes(itemId);
      racing.get(itemId)?.delete(since);
      if (racing.get(itemId)?.size === 0) racing.delete(itemId);
      if (started !== epoch) return;
      if (got === 'unavailable') {
        set((s) => {
          const byItem = { ...s.byItem };
          delete byItem[itemId];
          return { available: false, byItem };
        });
        return;
      }
      set((s) => {
        const held = s.byItem[itemId]?.notes ?? [];
        // A read that did not answer proves nothing about 082: `available` stays as it was.
        if (got === 'failed') return { byItem: { ...s.byItem, [itemId]: { status: 'failed', notes: held } } };
        // A lost note stays on screen under its editor, whatever the read says.
        for (const n of held) if (s.lost[n.id]) since.add(n.id);
        const heldById = new Map(held.map((n) => [n.id, n]));
        const gotIds = new Set(got.map((n) => n.id));
        const notes = [
          ...got.flatMap((n) => (since.has(n.id) ? (heldById.has(n.id) ? [heldById.get(n.id)!] : []) : [n])),
          ...held.filter((n) => since.has(n.id) && !gotIds.has(n.id)),
        ].sort(byCreated);
        // A read over notes already shown (the tab back from another device):
        // a pass of light over each note it added or changed (lib/sync-sheen.ts).
        // The first read shows everything, so it takes none.
        if (reread.has(itemId)) {
          syncSheen(
            got
              .filter((n) => !since.has(n.id) && heldById.get(n.id)?.body !== n.body)
              .map((n) => noteKey(n.id))
          );
        }
        reread.add(itemId);
        return { available: true, byItem: { ...s.byItem, [itemId]: { status: 'ready', notes } } };
      });
    },

    async add(itemId, raw, opts) {
      if (refused()) return false;
      if (get().available === false) return 'unavailable';
      const body = cleanNoteBody(raw);
      const why = noteRefusal(body);
      if (why) {
        if (why === 'too_long') toast.error(NOTE_COPY.refusal.too_long(noteLength(body)));
        return why;
      }
      const started = epoch;
      const kept = get().retry[itemId];
      const id = kept && kept.body === body ? kept.id : crypto.randomUUID();
      const optimistic: ItemNote = {
        id,
        itemId,
        body,
        createdAt: new Date().toISOString(),
        editedAt: null,
        pinnedAt: null,
      };
      const end = begin(itemId, id);
      write(itemId, (notes) => [...notes.filter((n) => n.id !== id), optimistic]);
      set((s) => ({
        pending: { ...s.pending, [id]: true },
        placedAt: { ...s.placedAt, [id]: opts?.placedAt ?? Date.now() },
      }));
      let res = await insertItemNote({ id, itemId, body });
      if (!res.ok && res.refusal === 'failed') {
        // The insert may have landed and only its answer been lost.
        const back = await getItemNote(id);
        if (back && back !== 'failed' && back.body === body) res = { ok: true, note: back };
      }
      end();
      if (started !== epoch) return false;
      const unpend = () =>
        set((s) => {
          const pending = { ...s.pending };
          delete pending[id];
          return { pending };
        });
      if (res.ok) {
        const note = res.note;
        patch(itemId, id, note);
        unpend();
        set((s) => {
          if (!s.retry[itemId]) return s;
          const retry = { ...s.retry };
          delete retry[itemId];
          return { available: true, retry };
        });
        if (get().available !== true) set({ available: true });
        return true;
      }
      drop(itemId, id);
      unpend();
      set((s) => {
        const placedAt = { ...s.placedAt };
        delete placedAt[id];
        return { placedAt };
      });
      const refusal = res.refusal;
      if (refusal === 'failed') set((s) => ({ retry: { ...s.retry, [itemId]: { id, body } } }));
      if (refusal === 'unavailable') set({ available: false });
      // No box draws once notes are unavailable, so the text is offered on the toast, as for gone.
      if (refusal === 'gone' || refusal === 'unavailable')
        toast.error(NOTE_COPY.refusal[refusal](), { action: copyAction(body) });
      else toast.error(NOTE_COPY.refusal[refusal]());
      return refusal;
    },

    async edit(itemId, noteId, raw) {
      if (refused(noteId)) return false;
      const prev = notesOf(itemId).find((n) => n.id === noteId);
      if (!prev) return 'gone';
      const body = cleanNoteBody(raw);
      const why = noteRefusal(body);
      if (why) {
        if (why === 'too_long') toast.error(NOTE_COPY.refusal.too_long(noteLength(body)));
        return why;
      }
      if (body === prev.body) return true;
      const started = epoch;
      const end = begin(itemId, noteId);
      patch(itemId, noteId, { body, editedAt: new Date().toISOString() });
      const res = await updateItemNoteBody(noteId, body, prev.editedAt);
      end();
      if (started !== epoch) return false;
      if (res.ok) {
        patch(itemId, noteId, { editedAt: res.editedAt });
        return true;
      }
      const refusal = res.refusal;
      if (refusal === 'gone') {
        set((s) => ({ lost: { ...s.lost, [noteId]: true } }));
        toast.error(NOTE_COPY.noteGone, { action: copyAction(body) });
        return refusal;
      }
      patch(itemId, noteId, { body: prev.body, editedAt: prev.editedAt });
      if (refusal === 'conflict') {
        toast.error(NOTE_COPY.refusal.conflict());
        void get().load(itemId);
      } else if (refusal === 'unavailable') {
        toast.error(NOTE_COPY.refusal.unavailable());
      } else {
        toast.error(NOTE_COPY.editFailed);
      }
      return refusal;
    },

    async remove(itemId, noteId) {
      if (refused(noteId)) return false;
      const notes = notesOf(itemId);
      const at = notes.findIndex((n) => n.id === noteId);
      if (at < 0) return true;
      const note = notes[at];
      const started = epoch;
      const end = begin(itemId, noteId);
      drop(itemId, noteId);
      const ok = await deleteItemNote(noteId);
      end();
      if (started !== epoch) return false;
      if (ok) return true;
      write(itemId, (list) => {
        if (list.some((n) => n.id === noteId)) return list;
        const next = list.slice();
        next.splice(Math.min(at, next.length), 0, note);
        return next;
      });
      toast.error(NOTE_COPY.deleteFailed);
      return false;
    },

    forget(itemId, noteId) {
      if (!get().lost[noteId]) return;
      drop(itemId, noteId);
      set((s) => {
        const lost = { ...s.lost };
        delete lost[noteId];
        return { lost };
      });
    },
  };
});

/** How many editors are open on each note, by id (holdNoteEditor). */
const editors = new Map<string, number>();

/**
 * An open editor on a note, while it is mounted: the release drops a `lost`
 * note once no editor shows it any more (closing the item without Cancel), a
 * tick later, so a remount in the same commit (StrictMode, the lost frame
 * swapping in) keeps it.
 */
export function holdNoteEditor(itemId: string, noteId: string): () => void {
  editors.set(noteId, (editors.get(noteId) ?? 0) + 1);
  return () => {
    const n = (editors.get(noteId) ?? 1) - 1;
    if (n <= 0) editors.delete(noteId);
    else editors.set(noteId, n);
    setTimeout(() => {
      if (!editors.has(noteId)) useItemNotesStore.getState().forget(itemId, noteId);
    }, 0);
  };
}

const NO_NOTES: ItemNote[] = [];

/**
 * An item's notes, read when a view of the item mounts and again whenever the
 * page comes back into view, as useItemFiles. Null while notes are unavailable.
 */
export function useItemNotes(itemId: string | null): ItemNote[] | null {
  const notes = useItemNotesStore((s) => (itemId ? s.byItem[itemId]?.notes : undefined));
  const available = useItemNotesStore((s) => s.available);
  useEffect(() => {
    if (!itemId) return;
    const reload = () => {
      const s = useItemNotesStore.getState();
      if (s.available === false || s.byItem[itemId]?.status === 'loading') return;
      void s.load(itemId);
    };
    reload();
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [itemId]);
  if (available === false) return null;
  return notes ?? NO_NOTES;
}

/** Sign-out and account switch: empty the store and bump the epoch. In local-state's RAW_CLEARERS. */
export function clearItemNotesState(): void {
  epoch++;
  racing.clear();
  reread.clear();
  inflight.clear();
  useItemNotesStore.setState({ available: null, byItem: {}, placedAt: {}, pending: {}, retry: {}, lost: {} });
}
