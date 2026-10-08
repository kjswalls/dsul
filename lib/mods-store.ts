'use client';

import { create } from 'zustand';
import { createClient } from '@/lib/supabase';
import { DRAFT_SLUG, themeSlugForId } from '@/lib/user-themes/css';
import {
  MOD_KINDS,
  MOD_SLUG_RE,
  ModNameSchema,
  LookManifestSchema,
  type LookManifest,
  RecipeManifestSchema,
  type RecipeManifest,
  ThemeManifestSchema,
  type ThemeManifest,
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
 * client-side navigation until a reload without it. Make draws its banner off
 * it, and the recipe engine (lib/recipes/engine.ts) and ⌘K run nothing while it
 * is on; the mod runtime (build order 8) will ask it too.
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

/** A slug from a name, under 061's rule: a letter first, then [a-z0-9-], at most 30. */
export function slugFromName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return MOD_SLUG_RE.test(base) ? base : 'recipe';
}

/** `base`, or `base-2`, `base-3`... the first no row uses, kept to 30 characters. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const slug = `${base.slice(0, 30 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(slug)) return slug;
  }
  return `recipe-${crypto.randomUUID().slice(0, 4)}`;
}

const DISABLED_REASON_MAX = 200;

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
  /** Optimistic; switching on also clears why the app switched it off. True once the write lands. */
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  /** False (and no write) when the name breaks 061's rule. */
  rename: (id: string, name: string) => Promise<boolean>;
  /** Optimistic. True once the delete lands. */
  remove: (id: string) => Promise<boolean>;
  /**
   * Saves a new recipe, switched off (mods.md: everything starts off). The slug
   * comes from the name and is one no row of ANY kind uses, so the recipe's ⌘K
   * id (`mod.<slug>.run`) cannot collide with a later mod's.
   */
  createRecipe: (
    userId: string,
    input: { name: string; manifest: RecipeManifest }
  ) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  /**
   * A recipe's name and manifest. A switched-on recipe whose manifest changed
   * is saved switched off (everything starts off, and an edit is new
   * behaviour); a rename alone leaves the switch as it is.
   */
  saveRecipe: (id: string, input: { name: string; manifest: RecipeManifest }) => Promise<boolean>;
  /**
   * Saves a new theme, switched off. Its id is minted here and its slug is
   * `u-` and the id's first 8 hex digits (lib/user-themes/css.ts), so a clash
   * mints a new id rather than a new suffix.
   */
  createTheme: (
    userId: string,
    input: { name: string; manifest: ThemeManifest }
  ) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  /**
   * A theme's name and manifest. The switch stays as it is: a theme is values,
   * not code that runs, so an edit is not new behaviour the way a recipe's is.
   */
  saveTheme: (id: string, input: { name: string; manifest: ThemeManifest }) => Promise<boolean>;
  /**
   * Saves a new Look, switched off. Its ref is minted as a theme's slug is
   * (`u-` and the id's first 8 hex digits, lib/user-looks.ts), and stored as
   * its slug; 061's unique is per kind, so it never clashes with a theme's.
   */
  createLook: (
    userId: string,
    input: { name: string; manifest: LookManifest }
  ) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  /** A Look's name and manifest. The switch stays as it is: a Look is values, like a theme. */
  saveLook: (id: string, input: { name: string; manifest: LookManifest }) => Promise<boolean>;
  /** Switched off by the app, with the reason Make shows (061: 1 to 200 characters). */
  disable: (id: string, reason: string) => Promise<void>;
  /** "Turn all mods off": every recipe and mod, on every device. */
  turnAllOff: (userId: string) => Promise<void>;
  /** Back to the start for the next account, keeping `safeMode`. */
  reset: () => void;
}

/**
 * Same JSON value, key order aside: a manifest read back from jsonb has its
 * keys sorted, one built by the form does not.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return (
    ka.length === kb.length &&
    ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
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

  /**
   * Inserts one new row, shown at once and taken back on failure. Returns the
   * error so the caller can retry a 23505 its own way.
   */
  const insertRow = async (row: UserMod): Promise<{ code?: string; message?: string } | null> => {
    set((s) => ({ rows: sortMods([...s.rows.filter((r) => r.id !== row.id), row]) }));
    const { error } = await createClient().from('user_mods').insert({
      id: row.id,
      user_id: row.userId,
      kind: row.kind,
      slug: row.slug,
      name: row.name,
      enabled: false,
      manifest: row.manifest,
    });
    if (error && get().hydratedUserId === row.userId) set((s) => ({ rows: s.rows.filter((r) => r.id !== row.id) }));
    return error;
  };

  const newRow = (userId: string, id: string, kind: UserMod['kind'], slug: string, name: string, manifest: unknown): UserMod => {
    const now = new Date().toISOString();
    return { id, userId, kind, slug, name, enabled: false, manifest, disabledReason: null, createdAt: now, updatedAt: now };
  };

  /**
   * A new theme or Look, switched off. Its id is minted here and its slug is
   * `u-` and the id's first 8 hex digits (lib/user-themes/css.ts), so a clash
   * mints a new id rather than a new suffix.
   */
  const createByIdSlug = async (
    kind: 'theme' | 'look',
    schema: { safeParse: (v: unknown) => { success: boolean } },
    userId: string,
    { name, manifest }: { name: string; manifest: unknown }
  ): Promise<{ ok: true; id: string } | { ok: false; reason: string }> => {
    const { available, hydratedUserId, loaded } = get();
    const trimmed = name.trim();
    if (!available || hydratedUserId !== userId || !loaded) return { ok: false, reason: 'Make is not ready yet.' };
    if (!ModNameSchema.safeParse(trimmed).success) return { ok: false, reason: 'Give it a name.' };
    if (!schema.safeParse(manifest).success) return { ok: false, reason: 'Something in it is not valid.' };
    const what = kind === 'theme' ? 'createTheme' : 'createLook';
    for (let attempt = 0; attempt < 3; attempt++) {
      // A slug another row of this kind already has (an id prefix shared by
      // chance, or a row made elsewhere) comes back as 23505: a new id.
      const id = crypto.randomUUID();
      // The editor's preview owns u-00000000; a row there would never show.
      if (themeSlugForId(id) === DRAFT_SLUG) continue;
      const error = await insertRow(newRow(userId, id, kind, themeSlugForId(id), trimmed, manifest));
      if (!error) return { ok: true, id };
      if (error.code === '23505') continue;
      writeFailed(what, error);
      return { ok: false, reason: 'Could not save it. Try again.' };
    }
    return { ok: false, reason: 'Could not save it. Try again.' };
  };

  /**
   * A theme's or Look's name and manifest. The switch stays as it is: these
   * are values, not code that runs, so an edit is not new behaviour the way
   * a recipe's is. `keep` may refuse the edit against the row as it stands.
   */
  const saveValues = async (
    kind: 'theme' | 'look',
    schema: { safeParse: (v: unknown) => { success: boolean } },
    id: string,
    { name, manifest }: { name: string; manifest: unknown },
    keep?: (before: UserMod) => boolean
  ): Promise<boolean> => {
    const { available, hydratedUserId: userId, rows } = get();
    const before = rows.find((r) => r.id === id && r.kind === kind);
    const trimmed = name.trim();
    if (!available || !userId || !before) return false;
    if (!ModNameSchema.safeParse(trimmed).success || !schema.safeParse(manifest).success) return false;
    if (keep && !keep(before)) return false;
    set((s) => ({ rows: sortMods(s.rows.map((r) => (r.id === id ? { ...r, name: trimmed, manifest } : r))) }));
    const { error } = await createClient()
      .from('user_mods')
      .update({ name: trimmed, manifest })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) {
      if (get().hydratedUserId === userId) {
        set((s) => ({
          rows: sortMods(s.rows.map((r) => (r.id === id ? { ...r, name: before.name, manifest: before.manifest } : r))),
        }));
      }
      writeFailed(kind === 'theme' ? 'saveTheme' : 'saveLook', error);
      return false;
    }
    return true;
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
      if (!available || !userId || !before) return false;
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
        return false;
      }
      return true;
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
      if (!available || !userId || at < 0) return false;
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
        return false;
      }
      return true;
    },

    createRecipe: async (userId, { name, manifest }) => {
      const { available, hydratedUserId, loaded } = get();
      const trimmed = name.trim();
      if (!available || hydratedUserId !== userId || !loaded) return { ok: false, reason: 'Make is not ready yet.' };
      if (!ModNameSchema.safeParse(trimmed).success) return { ok: false, reason: 'Give it a name.' };
      if (!RecipeManifestSchema.safeParse(manifest).success) return { ok: false, reason: 'Something in it is not valid.' };

      const id = crypto.randomUUID();
      const taken = new Set(get().rows.map((r) => r.slug));
      const base = slugFromName(trimmed);
      // A clash the list cannot see (a row made on another device since the
      // load) comes back as 23505; take the next suffix and try again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const slug = uniqueSlug(base, taken);
        const error = await insertRow(newRow(userId, id, 'recipe', slug, trimmed, manifest));
        if (!error) return { ok: true, id };
        if (error.code === '23505') {
          taken.add(slug);
          continue;
        }
        writeFailed('createRecipe', error);
        return { ok: false, reason: 'Could not save it. Try again.' };
      }
      return { ok: false, reason: 'Could not save it. Try again.' };
    },

    saveRecipe: async (id, { name, manifest }) => {
      const { available, hydratedUserId: userId, rows } = get();
      const before = rows.find((r) => r.id === id && r.kind === 'recipe');
      const trimmed = name.trim();
      if (!available || !userId || !before) return false;
      if (!ModNameSchema.safeParse(trimmed).success || !RecipeManifestSchema.safeParse(manifest).success) return false;
      const switchOff = before.enabled && !sameJson(before.manifest, manifest);
      set((s) => ({
        rows: sortMods(
          s.rows.map((r) => (r.id === id ? { ...r, name: trimmed, manifest, ...(switchOff && { enabled: false }) } : r))
        ),
      }));
      const { error } = await createClient()
        .from('user_mods')
        .update({ name: trimmed, manifest, ...(switchOff && { enabled: false }) })
        .eq('id', id)
        .eq('user_id', userId);
      if (error) {
        if (get().hydratedUserId === userId) {
          set((s) => ({
            rows: sortMods(
              s.rows.map((r) =>
                r.id === id ? { ...r, name: before.name, manifest: before.manifest, enabled: before.enabled } : r
              )
            ),
          }));
        }
        writeFailed('saveRecipe', error);
        return false;
      }
      return true;
    },

    createTheme: (userId, input) => createByIdSlug('theme', ThemeManifestSchema, userId, input),

    saveTheme: (id, input) =>
      // A theme keeps its mode: it may be a saved light or dark pick, which a
      // switch would strand (the editor locks the choice; this is the backstop).
      saveValues('theme', ThemeManifestSchema, id, input, (before) => {
        const was = ThemeManifestSchema.safeParse(before.manifest);
        return !was.success || was.data.mode === input.manifest.mode;
      }),

    createLook: (userId, input) => createByIdSlug('look', LookManifestSchema, userId, input),

    saveLook: (id, input) => saveValues('look', LookManifestSchema, id, input),

    disable: async (id, reason) => {
      const { available, hydratedUserId: userId, rows } = get();
      const before = rows.find((r) => r.id === id);
      if (!available || !userId || !before) return;
      const why = reason.trim().slice(0, DISABLED_REASON_MAX) || 'Switched off.';
      set((s) => ({ rows: s.rows.map((r) => (r.id === id ? { ...r, enabled: false, disabledReason: why } : r)) }));
      const { error } = await createClient()
        .from('user_mods')
        .update({ enabled: false, disabled_reason: why })
        .eq('id', id)
        .eq('user_id', userId);
      if (error) {
        // Left off locally even so: a recipe that broke its limit must not run
        // again in this tab because the write that recorded it failed.
        writeFailed('disable', error);
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
