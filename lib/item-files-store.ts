import { useEffect } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import {
  ITEM_FILE_LIMITS,
  REFUSAL_COPY,
  THUMB_TTL_S,
  deleteItemFile,
  isThumbable,
  listItemFiles,
  thumbLinks,
  uploadItemFile,
  type ItemFile,
} from '@/lib/item-files';
import { usePlannerStore } from '@/lib/planner-store';

/**
 * Files on an item, as the panel shows them (lib/item-files.ts, migration 073).
 * Memory only, never persisted: the list is the database's, fetched when an
 * item opens. `available` is false once a read says 073 is not applied, which
 * hides the paperclip for the session.
 *
 * A load MERGES: a file added or deleted while a read was on its way (a read
 * taken mid-upload never holds it, since only ready rows are listed) keeps its
 * place, so an upload is never dropped from the screen by a reload that raced it.
 *
 * `placedAt` is where a file sits on the item's timeline when it was added on
 * this page: the client's clock at the send it went with, so the card lands
 * before its message even when the server's clock (or the upload of the files
 * ahead of it) is late. After a reload the row's own `created_at` is used.
 */

/** Signed again once a thumbnail's link has less than this left. */
const THUMB_MARGIN_MS = 60_000;

/** Pictures being signed now, so two views asking at once sign each once. */
const signing = new Set<string>();

/** Ids added or deleted per item while a read was on its way, which that read must not undo. */
const pending = new Map<string, { added: Set<string>; removed: Set<string> }>();

interface ItemFilesState {
  available: boolean | null;
  byItem: Record<string, { status: 'loading' | 'ready' | 'failed'; files: ItemFile[] }>;
  /** How many uploads are in flight per item. */
  uploading: Record<string, number>;
  /** Where a file added on this page sits on the timeline (ms), by file id. */
  placedAt: Record<string, number>;
  /** Short-lived links to pictures (lib/item-files.ts THUMB_TTL_S), by file id. */
  thumbs: Record<string, { url: string; until: number }>;
  /** How often a picture's link failed to load: once is signed again, twice shows the file card. */
  thumbFails: Record<string, number>;
  load(itemId: string): Promise<void>;
  add(itemId: string, files: readonly File[], opts?: { placedAt?: number }): Promise<void>;
  remove(itemId: string, file: ItemFile): Promise<boolean>;
  loadThumbs(itemId: string): Promise<void>;
  /** An <img> failed: sign it again once, then give up on it (the file card shows). */
  dropThumb(fileId: string): void;
}

export const useItemFilesStore = create<ItemFilesState>((set, get) => ({
  available: null,
  byItem: {},
  uploading: {},
  placedAt: {},
  thumbs: {},
  thumbFails: {},

  async load(itemId) {
    if (get().available === false) return;
    const since = { added: new Set<string>(), removed: new Set<string>() };
    pending.set(itemId, since);
    set((s) => ({
      byItem: { ...s.byItem, [itemId]: { status: 'loading', files: s.byItem[itemId]?.files ?? [] } },
    }));
    const got = await listItemFiles(itemId);
    if (pending.get(itemId) === since) pending.delete(itemId);
    if (got === 'unavailable') {
      set((s) => {
        const byItem = { ...s.byItem };
        delete byItem[itemId];
        return { available: false, byItem };
      });
      return;
    }
    set((s) => {
      const held = s.byItem[itemId]?.files ?? [];
      if (got === 'failed')
        return { available: true, byItem: { ...s.byItem, [itemId]: { status: 'failed', files: held } } };
      const ids = new Set(got.map((f) => f.id));
      const files = [
        ...got.filter((f) => !since.removed.has(f.id)),
        ...held.filter((f) => since.added.has(f.id) && !ids.has(f.id)),
      ];
      return { available: true, byItem: { ...s.byItem, [itemId]: { status: 'ready', files } } };
    });
  },

  async add(itemId, files, opts) {
    const userId = usePlannerStore.getState().userId;
    if (!userId || files.length === 0) return;
    const startedAt = Date.now();
    const room = ITEM_FILE_LIMITS.perItem - (get().byItem[itemId]?.files.length ?? 0) - (get().uploading[itemId] ?? 0);
    const taking = files.slice(0, Math.max(0, room));
    if (taking.length < files.length) toast.error(REFUSAL_COPY.item_full(''));
    const bump = (n: number) =>
      set((s) => ({ uploading: { ...s.uploading, [itemId]: Math.max(0, (s.uploading[itemId] ?? 0) + n) } }));
    for (const file of taking) {
      bump(1);
      const res = await uploadItemFile({ itemId, userId, file });
      bump(-1);
      if (res.ok) {
        pending.get(itemId)?.added.add(res.file.id);
        set((s) => ({
          available: true,
          byItem: {
            ...s.byItem,
            [itemId]: {
              status: s.byItem[itemId]?.status ?? 'ready',
              files: [...(s.byItem[itemId]?.files ?? []), res.file],
            },
          },
          placedAt: { ...s.placedAt, [res.file.id]: opts?.placedAt ?? startedAt },
        }));
      } else {
        if (res.refusal === 'unavailable') set({ available: false });
        toast.error(REFUSAL_COPY[res.refusal](file.name));
        if (res.refusal === 'item_full' || res.refusal === 'account_full' || res.refusal === 'unavailable') break;
      }
    }
  },

  async remove(itemId, file) {
    const userId = usePlannerStore.getState().userId;
    if (!userId) return false;
    const ok = await deleteItemFile(file, userId);
    if (!ok) {
      toast.error(`Couldn’t delete ${file.name}. Try again.`);
      return false;
    }
    pending.get(itemId)?.removed.add(file.id);
    set((s) => {
      const entry = s.byItem[itemId];
      if (!entry) return s;
      return { byItem: { ...s.byItem, [itemId]: { ...entry, files: entry.files.filter((f) => f.id !== file.id) } } };
    });
    return true;
  },

  async loadThumbs(itemId) {
    const userId = usePlannerStore.getState().userId;
    const files = get().byItem[itemId]?.files ?? [];
    if (!userId || files.length === 0) return;
    const now = Date.now();
    const due = files.filter(
      (f) =>
        isThumbable(f.mime) &&
        !signing.has(f.id) &&
        (get().thumbFails[f.id] ?? 0) < 2 &&
        (get().thumbs[f.id]?.until ?? 0) - now < THUMB_MARGIN_MS
    );
    if (due.length === 0) return;
    for (const f of due) signing.add(f.id);
    const links = await thumbLinks(due, userId).finally(() => {
      for (const f of due) signing.delete(f.id);
    });
    const until = Date.now() + THUMB_TTL_S * 1000;
    set((s) => {
      const thumbs = { ...s.thumbs };
      for (const [id, url] of Object.entries(links)) thumbs[id] = { url, until };
      return { thumbs };
    });
  },

  dropThumb(fileId) {
    // A link that had run out is not a broken picture: re-sign without counting it.
    const expired = (get().thumbs[fileId]?.until ?? Infinity) <= Date.now();
    const fails = (get().thumbFails[fileId] ?? 0) + (expired ? 0 : 1);
    set((s) => {
      const thumbs = { ...s.thumbs };
      delete thumbs[fileId];
      return { thumbs, thumbFails: { ...s.thumbFails, [fileId]: fails } };
    });
    if (fails >= 2) return;
    const itemId = Object.keys(get().byItem).find((id) => get().byItem[id].files.some((f) => f.id === fileId));
    if (itemId) void get().loadThumbs(itemId);
  },
}));

/**
 * An item's files, read when a view of the item mounts and again whenever the
 * page comes back into view (how a file an agent added while the item was open
 * shows up). Every view of an item (its Files section, its conversation, its
 * timeline) reads through here, so there is one fetch path; a read already on
 * its way is not asked again. Null while files are not available.
 */
export function useItemFiles(itemId: string | null): ItemFile[] | null {
  const files = useItemFilesStore((s) => (itemId ? s.byItem[itemId]?.files : undefined));
  const available = useItemFilesStore((s) => s.available);
  useEffect(() => {
    if (!itemId) return;
    const reload = () => {
      const s = useItemFilesStore.getState();
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
  return files ?? NO_FILES;
}

const NO_FILES: ItemFile[] = [];
