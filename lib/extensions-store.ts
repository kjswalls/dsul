'use client';

import { create } from 'zustand';
import {
  fetchUserExtensionConfigs,
  fetchUserExtensions,
  setUserExtensionConfig,
  setUserExtensionEnabled,
} from '@/lib/db';
import { resolveEnabled } from '@/lib/extension-registry';

/**
 * Per-user enabled state for official extensions — its own concern, one store
 * per concern. Not persist()ed: the server is truth (user_extensions rows),
 * defaults come from the manifest (lib/extension-registry.ts), and a stale
 * localStorage copy of a toggle is exactly the "write looked like it landed
 * and vanished on reload" bug the availability latch exists to prevent.
 *
 * Availability follows the itemTypesAvailable contract: fetchUserExtensions
 * returns null when the table is unreachable (migration 026 not applied), and
 * the null gates BOTH the settings toggles (via `available`) and setEnabled's
 * write path. Extensions themselves then sit at their manifest defaults —
 * quiet, never an error state to explain.
 *
 * Hydrated from supabase-provider beside hydrateSettings — deliberately NOT in
 * planner-store's initializeStore Promise.all, whose batch gates the overdue
 * sweep; extensions must never be able to fail the data load.
 */
interface ExtensionsStore {
  /** False once a fetch proved the user_extensions table isn't deployed. */
  available: boolean;
  /**
   * True only once a fetch has actually RESOLVED for the current user.
   *
   * `hydratedUserId` cannot answer this: it is stamped synchronously at the
   * START of hydrate, so it says "this account's fetch is in flight", not "its
   * values are here". setConfigValue writes the WHOLE config blob for a slug,
   * built from what the store holds — so a keystroke during that window (or
   * after a failed hydrate) would upsert a one-key object over a server row
   * holding four, silently destroying the rest.
   *
   * It is also what the settings surface renders its extension rows `pending`
   * off (lib/settings/manifest.ts). Same question, asked before the write
   * rather than after: a row whose store cannot answer for it must not draw a
   * control at all, because the value it would draw is the manifest default
   * and a click would write that default into the user's row.
   */
  configsLoaded: boolean;
  /** Sparse: only slugs the user has actually toggled have entries. */
  enabled: Record<string, boolean>;
  /**
   * The toggles as the planner snapshot remembers them (lib/planner-snapshot.ts),
   * so a preview groups exactly as the fresh render will. DISPLAY-ONLY: read by
   * the gates in lib/extension-gates.ts and nothing else — never `isEnabled()`,
   * never a write. hydrate's synchronous reset and every one of its outcomes set
   * it back to null, so a previous account's map cannot survive and the server's
   * answer always replaces it.
   */
  previewEnabled: Record<string, boolean> | null;
  /**
   * Per-extension settings (user_extensions.config), keyed by slug.
   *
   * NON-SECRET only, and that is a boundary rather than a convention: this map
   * is in a browser store, so anything reachable from a devtools console or an
   * XSS is in it. Credentials live in user_secrets and are never fetched here —
   * see lib/reminders/channel-config.ts for which field goes where.
   */
  configs: Record<string, Record<string, unknown>>;
  hydratedUserId: string | null;

  hydrate: (userId: string) => Promise<void>;
  /** Seed `previewEnabled` for `userId`'s in-flight hydrate. No-op once configs have loaded. */
  seedPreviewEnabled: (userId: string, map: Record<string, boolean>) => void;
  /** Manifest-default fallback included; safe for non-reactive reads. */
  isEnabled: (slug: string) => boolean;
  /** Optimistic; no-ops (with a warn) while the table is unavailable. */
  setEnabled: (userId: string, slug: string, enabled: boolean) => void;
  /** One key of one extension's config. Optimistic, same availability gate. */
  setConfigValue: (userId: string, slug: string, key: string, value: unknown) => void;
  reset: () => void;
}

const INITIAL = {
  available: true,
  configsLoaded: false,
  enabled: {} as Record<string, boolean>,
  previewEnabled: null as Record<string, boolean> | null,
  configs: {} as Record<string, Record<string, unknown>>,
  hydratedUserId: null as string | null,
};

export const useExtensionsStore = create<ExtensionsStore>((set, get) => ({
  ...INITIAL,

  hydrate: async (userId) => {
    // Duplicate-event guard (TOKEN_REFRESHED, repeated SIGNED_IN) — same shape
    // as hydrateSettings' hydratedUserId ref, so an auth refresh can't clobber
    // an in-session toggle with a stale server read.
    if (get().hydratedUserId === userId) return;
    // Clear synchronously on a BARE account switch (SIGNED_IN for a different
    // user with no SIGNED_OUT — the morning-store pattern): the previous
    // user's toggles must not answer isEnabled() during the fetch window. A
    // no-op on plain page load, where state is still initial.
    set({
      hydratedUserId: userId,
      enabled: {},
      previewEnabled: null,
      configs: {},
      available: true,
      configsLoaded: false,
    });

    let rows: Record<string, boolean> | null;
    let configRows: Record<string, Record<string, unknown>> | null;
    try {
      // One round-trip's worth of latency for both — see the note on
      // fetchUserExtensionConfigs for why they are separate calls.
      [rows, configRows] = await Promise.all([
        fetchUserExtensions(userId),
        fetchUserExtensionConfigs(userId),
      ]);
    } catch (error) {
      // Transient failure (network, 5xx) — NOT the missing-table case, which
      // returns null. Un-stamp the guard so the next auth event retries, and
      // leave `available` alone: a blip must not read as a missing migration.
      console.warn('[extensions] hydrate failed, will retry on next auth event:', error);
      if (get().hydratedUserId === userId) set({ hydratedUserId: null, previewEnabled: null });
      return;
    }

    // A slower response for a previous account must never land on the current
    // one (the hydrateSettings stale-drop rule).
    if (get().hydratedUserId !== userId) return;

    if (rows === null) {
      set({ available: false, enabled: {}, previewEnabled: null, configs: {}, configsLoaded: false });
    } else {
      // Merge UNDER any local entries: `enabled` was cleared above, so entries
      // present now are exactly the toggles made while the fetch was in flight
      // — their upserts are already on the wire and must win over this
      // pre-write server read. Configs merge PER SLUG for the same reason, so a
      // field typed during the fetch is not reverted by the row it predates.
      set((s) => {
        const configs = { ...(configRows ?? {}) };
        for (const [slug, local] of Object.entries(s.configs)) {
          configs[slug] = { ...(configs[slug] ?? {}), ...local };
        }
        return {
          available: true,
          configsLoaded: true,
          enabled: { ...rows, ...s.enabled },
          previewEnabled: null,
          configs,
        };
      });
    }
  },

  /** Display-only, from the planner snapshot. NEVER feeds `enabled`, `isEnabled()` or any write:
   *  `enabled` entries present when the fetch resolves are merged OVER the server rows as in-flight
   *  toggles (the merge note in hydrate), so seeding them would let a cached value beat server truth;
   *  and stamping hydratedUserId would make hydrate() return early and never fetch.
   *  `!available` too: after the missing-table branch nothing would ever clear the seed again. */
  seedPreviewEnabled: (userId, map) => {
    const s = get();
    if (s.configsLoaded || !s.available || s.hydratedUserId !== userId) return;
    set({ previewEnabled: { ...map } });
  },

  isEnabled: (slug) => resolveEnabled(get().enabled, slug),

  setEnabled: (userId, slug, enabled) => {
    if (!get().available) {
      console.warn('[extensions] setEnabled ignored — user_extensions table not deployed.');
      return;
    }
    set((s) => ({ enabled: { ...s.enabled, [slug]: enabled } }));
    setUserExtensionEnabled(userId, slug, enabled).catch(console.error);
  },

  setConfigValue: (userId, slug, key, value) => {
    if (!get().available) {
      console.warn('[extensions] setConfigValue ignored — user_extensions table not deployed.');
      return;
    }
    // The write is whole-object, so writing before the server's copy has landed
    // would replace it with whatever fragment is in memory.
    //
    // THIS IS THE LAST LINE, NOT THE ONLY ONE, and it used to be described as
    // if it were unreachable: "the settings page gates its whole render on
    // hydration". That was true only while that gate waited on planner-store's
    // seven-table load, which this store's two queries always beat. The gate is
    // now the single-row settings read (lib/settings/hydration.ts) and the two
    // race, so every extension row states its own readiness instead — see
    // `pending` / `extPending` in lib/settings/manifest.ts, which renders the
    // row as loading rather than as an editable control. With that in place a
    // keystroke can only reach here after a hydrate FAILED (the store is
    // un-stamped and retries on the next auth event), which is exactly the case
    // where the in-memory copy is empty and dropping the write is the only safe
    // answer. Silent by design: this is a guard behind a UI that already says
    // the row is not ready, not an error the user can act on.
    if (!get().configsLoaded) {
      console.warn('[extensions] setConfigValue ignored — config has not loaded yet.');
      return;
    }
    // An empty string is DELETION, not storage. Otherwise clearing a field
    // leaves '' behind, and every channel's requireString then has to decide
    // whether '' means unset — which is exactly the ambiguity that makes
    // "I removed the number and it still called me" possible.
    const next = { ...(get().configs[slug] ?? {}) };
    if (value === '' || value === null || value === undefined) delete next[key];
    else next[key] = value;

    set((s) => ({ configs: { ...s.configs, [slug]: next } }));
    setUserExtensionConfig(userId, slug, next).catch(console.error);
  },

  reset: () => set({ ...INITIAL }),
}));
