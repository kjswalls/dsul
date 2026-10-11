import { create } from 'zustand';
import { toast } from 'sonner';
import {
  ITEM_FILE_LIMITS,
  REFUSAL_COPY,
  deleteItemFile,
  listItemFiles,
  uploadItemFile,
  type ItemFile,
} from '@/lib/item-files';
import { usePlannerStore } from '@/lib/planner-store';

/**
 * Files on an item, as the panel shows them (lib/item-files.ts, migration 073).
 * Memory only, never persisted: the list is the database's, fetched when an
 * item opens. `available` is false once a read says 073 is not applied, which
 * hides the paperclip for the session.
 */

interface ItemFilesState {
  available: boolean | null;
  byItem: Record<string, { status: 'loading' | 'ready' | 'failed'; files: ItemFile[] }>;
  /** How many uploads are in flight per item. */
  uploading: Record<string, number>;
  load(itemId: string): Promise<void>;
  add(itemId: string, files: readonly File[]): Promise<void>;
  remove(itemId: string, file: ItemFile): Promise<boolean>;
}

export const useItemFilesStore = create<ItemFilesState>((set, get) => ({
  available: null,
  byItem: {},
  uploading: {},

  async load(itemId) {
    if (get().available === false) return;
    set((s) => ({
      byItem: { ...s.byItem, [itemId]: { status: 'loading', files: s.byItem[itemId]?.files ?? [] } },
    }));
    const got = await listItemFiles(itemId);
    if (got === 'unavailable') {
      set((s) => {
        const byItem = { ...s.byItem };
        delete byItem[itemId];
        return { available: false, byItem };
      });
      return;
    }
    set((s) => ({
      available: true,
      byItem: {
        ...s.byItem,
        [itemId]: got === 'failed' ? { status: 'failed', files: s.byItem[itemId]?.files ?? [] } : { status: 'ready', files: got },
      },
    }));
  },

  async add(itemId, files) {
    const userId = usePlannerStore.getState().userId;
    if (!userId || files.length === 0) return;
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
        set((s) => ({
          available: true,
          byItem: {
            ...s.byItem,
            [itemId]: { status: 'ready', files: [...(s.byItem[itemId]?.files ?? []), res.file] },
          },
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
    set((s) => {
      const entry = s.byItem[itemId];
      if (!entry) return s;
      return { byItem: { ...s.byItem, [itemId]: { ...entry, files: entry.files.filter((f) => f.id !== file.id) } } };
    });
    return true;
  },
}));
