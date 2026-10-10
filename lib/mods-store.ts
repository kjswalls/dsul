'use client';

import { create } from 'zustand';
import { z } from 'zod';
import { createClient } from '@/lib/supabase';
import { DRAFT_SLUG, themeSlugForId } from '@/lib/user-themes/css';
import {
  MOD_KINDS,
  MOD_SLUG_RE,
  MOD_SOURCE_MAX_BYTES,
  ModManifestSchema,
  type ModManifest,
  ModNameSchema,
  isModLabel,
  parseModManifest,
  consentWidened,
  LookManifestSchema,
  type LookManifest,
  RecipeManifestSchema,
  type RecipeManifest,
  ThemeManifestSchema,
  type ThemeManifest,
  UserModRowSchema,
  userModFromRow,
  parseModSettings,
  type ModSettingValue,
  type UserMod,
} from '@/lib/mods/schema';
import { isSafeTypedValue } from '@/lib/mods/labels';
import { activeModRuntime } from '@/lib/mods/runtime-manager';
import { modStoreSet } from '@/lib/mods/store-rpc';

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
 * is on, and so does the mod runtime (lib/mods/runtime-manager.ts). Make's mod
 * editor still saves in safe mode: safe mode stops mods running, not being fixed.
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

/**
 * A slug from a name, under 061's rule: a letter first, then [a-z0-9-], at
 * most 30. `fallback` when nothing of the name survives (a name in another
 * script): the kind's own word.
 */
export function slugFromName(name: string, fallback = 'recipe'): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return MOD_SLUG_RE.test(base) ? base : fallback;
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

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
/** Why a mod's name was refused: the label rule (lib/mods/labels.ts), in plain words. */
export const MOD_NAME_REFUSED =
  'Give it a plain name, with no link and none of AI, Settings, Sign in, Account or key.';
const MOD_TOO_LONG = `The code is over ${MOD_SOURCE_MAX_BYTES / 1024}KB.`;

function parseRows(data: unknown[] | null): UserMod[] {
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
  return sortMods(rows);
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
  /** Optimistic; switching on also clears why the app switched it off. True once the write lands. */
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  /** False (and no write) when the name breaks 061's rule, or a mod's breaks the label rule. */
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
  /**
   * Saves a new mod, switched off, with its code and the manifest the
   * editor's scratch run read from it (build order 8). The name must pass the
   * label rule, since it is drawn in ⌘K and toasts beside host chrome; the
   * slug is one no row of ANY kind uses, as createRecipe's is.
   */
  createMod: (
    userId: string,
    input: { name: string; source: string; manifest: ModManifest }
  ) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  /**
   * A mod's name, code and manifest. A switched-on mod stays on (it hot
   * reloads), unless the new manifest asks for a use the old one did not,
   * or gives the mod its first card panel (consentWidened), as this tab
   * holds it or as the database does (read just before the write): then it
   * is saved switched off, even if this tab shows it off,
   * and switching it back on is the consent.
   */
  saveMod: (
    id: string,
    input: { name: string; source: string; manifest: ModManifest }
  ) => Promise<{ ok: true; switchedOff: boolean } | { ok: false; reason: string }>;
  /** Switched off by the app, with the reason Make shows (061: 1 to 200 characters). */
  disable: (id: string, reason: string) => Promise<void>;
  /** "Turn all mods off": every recipe and mod, on every device. */
  turnAllOff: (userId: string) => Promise<void>;
  /**
   * Make's list read again for the signed-in account, past hydrate's
   * once-per-account guard: how a switch-off on another device reaches this
   * tab (ModHost asks on focus). Dropped if any local write started after the
   * select went out, and `rows` is replaced only when something changed.
   */
  refresh: (userId: string) => Promise<void>;
  /**
   * One mod's code, store and manifest, which the list never selects. Read
   * by the mod runtime when it loads the mod. Null when it cannot be read.
   */
  loadModCode: (id: string) => Promise<ModCode | null>;
  /**
   * The values the person set for a mod in Make (build order 9), in its
   * store under the reserved `@settings` key, which a mod reads through
   * `$.settings.get` and can never write. Held to the manifest's declarations
   * first (parseModSettings), and a text value shaped like a password or key
   * is refused outright. A running mod takes them now, with no reload; one
   * that is off or on another device reads them at its next load.
   */
  setModSettings: (
    id: string,
    values: Record<string, ModSettingValue>
  ) => Promise<{ ok: true; values: Record<string, ModSettingValue> } | { ok: false; reason: string }>;
  /** Back to the start for the next account, keeping `safeMode`. */
  reset: () => void;
}

export const MOD_SETTING_SECRET = 'That looks like a password or key, so it was not saved.';

export interface ModCode {
  /**
   * The switch as the database holds it now, which may be newer than the
   * list's: the runtime runs nothing whose row is off here (another device's
   * save that widened `uses` switched it off, and this tab may not know yet).
   */
  enabled: boolean;
  source: string;
  store: Record<string, unknown>;
  manifest: unknown;
  updatedAt: string;
}

/**
 * Bumped by every write before it goes out and again when it lands, so a
 * refresh whose select was in flight while a write was knows its answer may
 * predate the write and drops it. A write that started before the select
 * and lands after it is caught by `writesInFlight`.
 */
let writeSeq = 0;
let writesInFlight = 0;
const startWrite = () => {
  writeSeq++;
};

/** Awaits one write to user_mods, counted as in flight until it settles. */
async function track<T>(write: PromiseLike<T>): Promise<T> {
  writesInFlight++;
  try {
    return await write;
  } finally {
    writesInFlight--;
    writeSeq++;
  }
}

const ModCodeRowSchema = UserModRowSchema.pick({ enabled: true, manifest: true, updated_at: true }).extend({
  source: UserModRowSchema.shape.source.unwrap().unwrap(),
  store: z.record(z.unknown()),
});

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
  const insertRow = async (
    row: UserMod,
    source?: string
  ): Promise<{ code?: string; message?: string } | null> => {
    startWrite();
    set((s) => ({ rows: sortMods([...s.rows.filter((r) => r.id !== row.id), row]) }));
    const { error } = await track(createClient().from('user_mods').insert({
      id: row.id,
      user_id: row.userId,
      kind: row.kind,
      slug: row.slug,
      name: row.name,
      enabled: false,
      manifest: row.manifest,
      ...(source !== undefined && { source }),
    }));
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
    startWrite();
    const before = rows.find((r) => r.id === id && r.kind === kind);
    const trimmed = name.trim();
    if (!available || !userId || !before) return false;
    if (!ModNameSchema.safeParse(trimmed).success || !schema.safeParse(manifest).success) return false;
    if (keep && !keep(before)) return false;
    set((s) => ({ rows: sortMods(s.rows.map((r) => (r.id === id ? { ...r, name: trimmed, manifest } : r))) }));
    const { error } = await track(
      createClient()
        .from('user_mods')
        .update({ name: trimmed, manifest })
        .eq('id', id)
        .eq('user_id', userId)
    );
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

      set({ rows: parseRows(data), available: true, loaded: true });
    },

    setEnabled: async (id, enabled) => {
      startWrite();
      const { available, hydratedUserId: userId, rows } = get();
      const before = rows.find((r) => r.id === id);
      if (!available || !userId || !before) return false;
      // Switching a mod on is the consent to its uses, so it must be the uses
      // this tab shows. A save on another device may have widened them since;
      // then this tab re-reads its rows and the switch stays off.
      if (enabled && before.kind === 'mod') {
        const stored = await track(
          createClient()
            .from('user_mods')
            .select('manifest')
            .eq('id', id)
            .eq('user_id', userId)
            .maybeSingle()
        );
        const fresh = stored.error ? null : (stored.data as { manifest?: unknown } | null);
        const shown = parseModManifest(before);
        const current = fresh ? parseModManifest({ kind: 'mod', manifest: fresh.manifest }) : null;
        if (!shown || !current || consentWidened(shown, current)) {
          void get().refresh(userId);
          return false;
        }
      }
      const patch = enabled ? { enabled, disabled_reason: null } : { enabled };
      set((s) => ({
        rows: s.rows.map((r) =>
          r.id === id ? { ...r, enabled, disabledReason: enabled ? null : r.disabledReason } : r
        ),
      }));
      const { error } = await track(
        createClient()
          .from('user_mods')
          .update(patch)
          .eq('id', id)
          .eq('user_id', userId)
      );
      if (error) {
        restore(userId, id, { enabled: before.enabled, disabledReason: before.disabledReason });
        writeFailed('setEnabled', error);
        return false;
      }
      return true;
    },

    rename: async (id, name) => {
      startWrite();
      const { available, hydratedUserId: userId, rows } = get();
      const before = rows.find((r) => r.id === id);
      const trimmed = name.trim();
      if (!available || !userId || !before || !ModNameSchema.safeParse(trimmed).success) return false;
      // A mod's name sits beside host chrome in ⌘K and its toasts.
      if (before.kind === 'mod' && !isModLabel(trimmed)) return false;
      if (trimmed === before.name) return true;
      set((s) => ({ rows: sortMods(s.rows.map((r) => (r.id === id ? { ...r, name: trimmed } : r))) }));
      const { error } = await track(
        createClient()
          .from('user_mods')
          .update({ name: trimmed })
          .eq('id', id)
          .eq('user_id', userId)
      );
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
      startWrite();
      const { available, hydratedUserId: userId, rows } = get();
      const at = rows.findIndex((r) => r.id === id);
      if (!available || !userId || at < 0) return false;
      const before = rows[at];
      set((s) => ({ rows: s.rows.filter((r) => r.id !== id) }));
      const { error } = await track(
        createClient()
          .from('user_mods')
          .delete()
          .eq('id', id)
          .eq('user_id', userId)
      );
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
      startWrite();
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
      const { error } = await track(
        createClient()
          .from('user_mods')
          .update({ name: trimmed, manifest, ...(switchOff && { enabled: false }) })
          .eq('id', id)
          .eq('user_id', userId)
      );
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

    createMod: async (userId, { name, source, manifest }) => {
      const { available, hydratedUserId, loaded } = get();
      const trimmed = name.trim();
      if (!available || hydratedUserId !== userId || !loaded) return { ok: false, reason: 'Make is not ready yet.' };
      if (!ModNameSchema.safeParse(trimmed).success || !isModLabel(trimmed)) return { ok: false, reason: MOD_NAME_REFUSED };
      if (utf8Bytes(source) > MOD_SOURCE_MAX_BYTES) return { ok: false, reason: MOD_TOO_LONG };
      const parsed = ModManifestSchema.safeParse(manifest);
      if (!parsed.success) return { ok: false, reason: 'Its manifest is not valid.' };

      const id = crypto.randomUUID();
      const taken = new Set(get().rows.map((r) => r.slug));
      const base = slugFromName(trimmed, 'mod');
      for (let attempt = 0; attempt < 3; attempt++) {
        const slug = uniqueSlug(base, taken);
        const error = await insertRow(newRow(userId, id, 'mod', slug, trimmed, parsed.data), source);
        if (!error) return { ok: true, id };
        if (error.code === '23505') {
          taken.add(slug);
          continue;
        }
        writeFailed('createMod', error);
        return { ok: false, reason: 'Could not save it. Try again.' };
      }
      return { ok: false, reason: 'Could not save it. Try again.' };
    },

    saveMod: async (id, { name, source, manifest }) => {
      startWrite();
      const { available, hydratedUserId: userId, rows } = get();
      const before = rows.find((r) => r.id === id && r.kind === 'mod');
      const trimmed = name.trim();
      if (!available || !userId || !before) return { ok: false, reason: 'Make is not ready yet.' };
      if (!ModNameSchema.safeParse(trimmed).success || !isModLabel(trimmed)) return { ok: false, reason: MOD_NAME_REFUSED };
      if (utf8Bytes(source) > MOD_SOURCE_MAX_BYTES) return { ok: false, reason: MOD_TOO_LONG };
      const parsed = ModManifestSchema.safeParse(manifest);
      if (!parsed.success) return { ok: false, reason: 'Its manifest is not valid.' };
      // The switch and manifest as the database holds them now: this tab's
      // copy may be stale (switched on, or saved, on another device since).
      const stored = await track(
        createClient()
          .from('user_mods')
          .select('enabled,manifest')
          .eq('id', id)
          .eq('user_id', userId)
          .maybeSingle()
      );
      const fresh = stored.error ? null : (stored.data as { enabled?: unknown; manifest?: unknown } | null);
      // Wider than either copy: saved switched off, whatever either copy says
      // of the switch, so no view can skip the consent. A stored manifest that
      // no longer parses counts as having asked for nothing.
      const switchOff =
        consentWidened(parseModManifest(before), parsed.data) ||
        (!!fresh && consentWidened(parseModManifest({ kind: 'mod', manifest: fresh.manifest }), parsed.data));
      const wasOn = before.enabled || fresh?.enabled === true;
      const next = { name: trimmed, manifest: parsed.data, ...(switchOff && { enabled: false }) };
      set((s) => ({ rows: sortMods(s.rows.map((r) => (r.id === id ? { ...r, ...next } : r))) }));
      const { data, error } = await track(
        createClient()
          .from('user_mods')
          .update({ ...next, source })
          .eq('id', id)
          .eq('user_id', userId)
          .select('updated_at')
      );
      const landed = !error && Array.isArray(data) && data.length > 0;
      if (!landed) {
        if (get().hydratedUserId === userId) {
          set((s) => ({
            rows: sortMods(
              s.rows.map((r) =>
                r.id === id ? { ...r, name: before.name, manifest: before.manifest, enabled: before.enabled } : r
              )
            ),
          }));
        }
        if (error) writeFailed('saveMod', error);
        return { ok: false, reason: 'Could not save it. Try again.' };
      }
      // The row's own updated_at, so the runtime sees the row moved and a
      // refresh that agrees changes nothing.
      const updatedAt = (data[0] as { updated_at?: unknown }).updated_at;
      if (typeof updatedAt === 'string' && get().hydratedUserId === userId) {
        set((s) => ({ rows: s.rows.map((r) => (r.id === id ? { ...r, updatedAt } : r)) }));
      }
      return { ok: true, switchedOff: switchOff && wasOn };
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
      startWrite();
      const { available, hydratedUserId: userId, rows } = get();
      const before = rows.find((r) => r.id === id);
      if (!available || !userId || !before) return;
      const why = reason.trim().slice(0, DISABLED_REASON_MAX) || 'Switched off.';
      set((s) => ({ rows: s.rows.map((r) => (r.id === id ? { ...r, enabled: false, disabledReason: why } : r)) }));
      const { error } = await track(
        createClient()
          .from('user_mods')
          .update({ enabled: false, disabled_reason: why })
          .eq('id', id)
          .eq('user_id', userId)
      );
      if (error) {
        // Left off locally even so: a recipe that broke its limit must not run
        // again in this tab because the write that recorded it failed.
        writeFailed('disable', error);
      }
    },

    turnAllOff: async (userId) => {
      startWrite();
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
      const { error } = await track(
        createClient()
          .from('user_mods')
          .update({ enabled: false })
          .eq('user_id', userId)
          .eq('enabled', true)
          .in('kind', [...kinds])
      );
      if (error) {
        if (get().hydratedUserId === userId) {
          set((s) => ({ rows: s.rows.map((r) => (flipped.has(r.id) ? { ...r, enabled: true } : r)) }));
        }
        writeFailed('turnAllOff', error);
      }
    },

    refresh: async (userId) => {
      const { available, hydratedUserId, loaded } = get();
      if (!available || hydratedUserId !== userId || !loaded) return;
      const seq = writeSeq;
      let result: { data: unknown[] | null; error: { code?: string; message?: string } | null };
      try {
        result = await createClient().from('user_mods').select(LIST_COLUMNS).eq('user_id', userId);
      } catch (error) {
        console.warn('[mods] refresh failed:', error);
        return;
      }
      // Another account, or a local write that started, landed or is still out
      // meanwhile: this answer may predate it.
      if (get().hydratedUserId !== userId || writeSeq !== seq || writesInFlight > 0) return;
      if (result.error) {
        if (missingTable(result.error)) set({ available: false, rows: [], loaded: false, failed: false });
        else console.warn('[mods] refresh failed:', result.error);
        return;
      }
      const rows = parseRows(result.data);
      if (JSON.stringify(rows) !== JSON.stringify(get().rows)) set({ rows });
    },

    loadModCode: async (id) => {
      const { available, hydratedUserId: userId } = get();
      if (!available || !userId) return null;
      try {
        const { data, error } = await createClient()
          .from('user_mods')
          .select('enabled,source,store,manifest,updated_at')
          .eq('id', id)
          .eq('user_id', userId)
          .eq('kind', 'mod')
          .maybeSingle();
        if (error || !data) {
          if (error) console.warn('[mods] could not read a mod:', error);
          return null;
        }
        const parsed = ModCodeRowSchema.safeParse(data);
        if (!parsed.success) return null;
        const { enabled, source, store, manifest, updated_at } = parsed.data;
        return { enabled, source, store, manifest, updatedAt: updated_at };
      } catch (error) {
        console.warn('[mods] could not read a mod:', error);
        return null;
      }
    },

    setModSettings: async (id, values) => {
      const { available, hydratedUserId: userId, rows } = get();
      const row = rows.find((r) => r.id === id && r.kind === 'mod');
      if (!available || !userId || !row) return { ok: false, reason: 'Make is not ready yet.' };
      const manifest = parseModManifest(row);
      if (!manifest) return { ok: false, reason: 'Its manifest is not valid.' };
      if (Object.values(values).some((v) => typeof v === 'string' && !isSafeTypedValue(v))) {
        return { ok: false, reason: MOD_SETTING_SECRET };
      }
      const clean = parseModSettings(manifest, values);
      const result = await modStoreSet(id, '@settings', clean);
      if (result === 'too_big') return { ok: false, reason: 'Your mod’s storage is full.' };
      if (result === 'gone') return { ok: false, reason: 'This mod was deleted.' };
      if (result !== 'ok') return { ok: false, reason: 'Could not save. Try again.' };
      activeModRuntime()?.settingsChanged(id, clean);
      return { ok: true, values: clean };
    },

    reset: () => set({ ...INITIAL }),
  };
});
