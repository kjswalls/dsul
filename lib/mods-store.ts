'use client';

import { create } from 'zustand';
import { createClient } from '@/lib/supabase';
import {
  MOD_KINDS,
  ModNameSchema,
  UserModRowSchema,
  userModFromRow,
  type UserMod,
} from '@/lib/mods/schema';

/**
 * The signed-in user's recipes, mods, themes and Looks (user_mods, migration
 * 061), for Settings → Make. memory/plans/mods.md.
 *
 * Through the SESSION client and RLS, never the service role: these rows are
 * the owner's alone, and nothing on the server reads them in this PR.
 *
 * Not persist()ed, for extensions-store's reason: the server is truth, and a
 * stale local copy of a switch is a write that looked like it landed.
 *
 * Availability follows extensions-store: a missing table (061 not applied,
 * 42P01 / PGRST205) latches `available: false` for the session, and every
 * write is then a no-op. A transient failure un-stamps `hydratedUserId` so the
 * next call retries, leaves `available` alone, and sets `failed` so Make can
 * say so and offer Try again.
 *
 * `safeMode` belongs to the TAB, not the account: it is read once from the URL
 * (`?safe-mode`) when this module loads and survives sign-out and every
 * client-side navigation until a reload without it. Nothing runs yet, so for
 * now it only draws Make's banner; the runtime (build order 4 and 8) asks it.
 */

/** Make's list. Never `source` or `store`: the list has no use for 128KB a row. */
const LIST_COLUMNS = 'id,user_id,kind,slug,name,enabled,manifest,disabled_reason,created_at,updated_at';

/** lib/db.ts's missing-table test (42P01 from Postgres, PGRST205 from PostgREST's schema cache). */
const missingTable = (error: { code?: string } | null | undefined) =>
  error?.code === '42P01' || error?.code === 'PGRST205';

/** True when a query string carries `safe-mode`, with or without a value. */
export function hasSafeModeParam(search: string): boolean {
  return new URLSearchParams(search).has('safe-mode');
}

function readSafeMode(): boolean {
  return typeof window !== 'undefined' && hasSafeModeParam(window.location.search);
}

function sortMods(rows: UserMod[]): UserMod[] {
  return [...rows].sort(
    (a, b) => MOD_KINDS.indexOf(a.kind) - MOD_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name)
  );
}

interface ModsStore {
  /** False once a query proved user_mods is not deployed. */
  available: boolean;
  /** True once a fetch has resolved for the current user. */
  loaded: boolean;
  /** The last load failed for a reason other than a missing table; hydrate again to retry. */
  failed: boolean;
  hydratedUserId: string | null;
  rows: UserMod[];
  /** `?safe-mode` was on the URL when this tab loaded: nothing made here runs. */
  safeMode: boolean;

  hydrate: (userId: string) => Promise<void>;
  /** Optimistic; switching on also clears why the app switched it off. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** False (and no write) when the name breaks 061's rule. */
  rename: (id: string, name: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  /** "Turn all mods off": every recipe and mod, on every device. */
  turnAllOff: (userId: string) => Promise<void>;
  /** Back to the start for the next account, keeping `safeMode`. */
  reset: () => void;
}

const INITIAL = {
  available: true,
  loaded: false,
  failed: false,
  hydratedUserId: null as string | null,
  rows: [] as UserMod[],
};

export const useModsStore = create<ModsStore>((set, get) => {
  /**
   * Puts back only the fields a failed write changed, if the store still holds
   * the same account, so a rename or delete that landed meanwhile stands.
   */
  const restore = (userId: string, id: string, fields: Partial<UserMod>) => {
    if (get().hydratedUserId !== userId) return;
    set((s) => ({ rows: s.rows.map((r) => (r.id === id ? { ...r, ...fields } : r)) }));
  };

  /** A write's error: a missing table latches, anything else is logged. */
  const writeFailed = (what: string, error: { code?: string; message?: string }) => {
    if (missingTable(error)) {
      set({ available: false, rows: [], loaded: false, failed: false });
      return;
    }
    console.error(`[mods] ${what} failed:`, error);
  };

  return {
    ...INITIAL,
    safeMode: readSafeMode(),

    hydrate: async (userId) => {
      if (get().hydratedUserId === userId) return;
      // Cleared synchronously, so a bare account switch never shows the
      // previous user's rows while this fetch is in flight.
      set({ hydratedUserId: userId, rows: [], available: true, loaded: false, failed: false });

      let result: { data: unknown[] | null; error: { code?: string; message?: string } | null };
      try {
        result = await createClient().from('user_mods').select(LIST_COLUMNS).eq('user_id', userId);
      } catch (error) {
        console.warn('[mods] hydrate failed, will retry:', error);
        if (get().hydratedUserId === userId) set({ hydratedUserId: null, failed: true });
        return;
      }

      // A slower response for a previous account never lands on this one.
      if (get().hydratedUserId !== userId) return;

      const { data, error } = result;
      if (error) {
        if (missingTable(error)) {
          console.warn('[mods] user_mods is not deployed yet (061): Make latched off.');
          set({ available: false, rows: [], loaded: false, failed: false });
        } else {
          console.warn('[mods] hydrate failed, will retry:', error);
          set({ hydratedUserId: null, failed: true });
        }
        return;
      }

      const rows: UserMod[] = [];
      for (const raw of data ?? []) {
        // Owner-asserted rows (061, OWNER-ASSERTED FIELDS): one that fails the
        // shape is left out of the list, never drawn half-parsed. The read
        // schema takes every name 061 takes, so a row the database holds is
        // never one Make cannot reach.
        const parsed = UserModRowSchema.safeParse(raw);
        if (parsed.success) rows.push(userModFromRow(parsed.data));
        else console.warn('[mods] dropped a malformed user_mods row:', parsed.error.issues);
      }
      set({ rows: sortMods(rows), available: true, loaded: true });
    },

    setEnabled: async (id, enabled) => {
      const { available, hydratedUserId: userId, rows } = get();
      const before = rows.find((r) => r.id === id);
      if (!available || !userId || !before) return;
      const patch = enabled ? { enabled, disabled_reason: null } : { enabled };
      set((s) => ({
        rows: s.rows.map((r) =>
          r.id === id ? { ...r, enabled, disabledReason: enabled ? null : r.disabledReason } : r
        ),
      }));
      const { error } = await createClient()
        .from('user_mods')
        .update(patch)
        .eq('id', id)
        .eq('user_id', userId);
      if (error) {
        restore(userId, id, { enabled: before.enabled, disabledReason: before.disabledReason });
        writeFailed('setEnabled', error);
      }
    },

    rename: async (id, name) => {
      const { available, hydratedUserId: userId, rows } = get();
      const before = rows.find((r) => r.id === id);
      const trimmed = name.trim();
      if (!available || !userId || !before || !ModNameSchema.safeParse(trimmed).success) return false;
      if (trimmed === before.name) return true;
      set((s) => ({ rows: sortMods(s.rows.map((r) => (r.id === id ? { ...r, name: trimmed } : r))) }));
      const { error } = await createClient()
        .from('user_mods')
        .update({ name: trimmed })
        .eq('id', id)
        .eq('user_id', userId);
      if (error) {
        if (get().hydratedUserId === userId) {
          set((s) => ({ rows: sortMods(s.rows.map((r) => (r.id === id ? { ...r, name: before.name } : r))) }));
        }
        writeFailed('rename', error);
        return false;
      }
      return true;
    },

    remove: async (id) => {
      const { available, hydratedUserId: userId, rows } = get();
      const at = rows.findIndex((r) => r.id === id);
      if (!available || !userId || at < 0) return;
      const before = rows[at];
      set((s) => ({ rows: s.rows.filter((r) => r.id !== id) }));
      const { error } = await createClient()
        .from('user_mods')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);
      if (error) {
        if (get().hydratedUserId === userId && !get().rows.some((r) => r.id === id)) {
          set((s) => {
            const next = [...s.rows];
            next.splice(Math.min(at, next.length), 0, before);
            return { rows: next };
          });
        }
        writeFailed('remove', error);
      }
    },

    turnAllOff: async (userId) => {
      if (!get().available) return;
      // Recipes and mods only. Themes and Looks are values, not code that runs,
      // and switching off someone's theme as a safety step would only repaint.
      const kinds = ['recipe', 'mod'] as const;
      const isCode = (r: UserMod) => (kinds as readonly string[]).includes(r.kind);
      // Only the rows this call flipped go back on a failure, so a switch or a
      // Delete that lands while it is in flight stands.
      const flipped = new Set<string>();
      if (get().hydratedUserId === userId) {
        for (const r of get().rows) if (isCode(r) && r.enabled) flipped.add(r.id);
        set((s) => ({ rows: s.rows.map((r) => (flipped.has(r.id) ? { ...r, enabled: false } : r)) }));
      }
      const { error } = await createClient()
        .from('user_mods')
        .update({ enabled: false })
        .eq('user_id', userId)
        .eq('enabled', true)
        .in('kind', [...kinds]);
      if (error) {
        if (get().hydratedUserId === userId) {
          set((s) => ({ rows: s.rows.map((r) => (flipped.has(r.id) ? { ...r, enabled: true } : r)) }));
        }
        writeFailed('turnAllOff', error);
      }
    },

    reset: () => set({ ...INITIAL }),
  };
});
