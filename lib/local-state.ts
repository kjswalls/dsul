'use client';

import { useAISettingsStore } from './ai-settings-store';
import { clearChatState } from './chat-store';
import { useCommandUsageStore } from './command-usage-store';
import { useEODStore } from './eod-store';
import { useKeyboardShortcutsStore } from './keyboard-shortcuts-store';
import { useMorningStore } from './morning-store';
import { usePlannerStore } from './planner-store';
import { useSidebarStore } from './sidebar-store';
import { clearReleased } from './sweep-grace';
import { useViewStore } from './view-store';

/**
 * "Whose state is in this browser, and drop it when the answer changes."
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * Ten separate things persist to localStorage under BROWSER-GLOBAL keys —
 * `dsul-ai-settings`, `dsul-view`, `planner-storage`, `dsul-chat-history`
 * and the rest. None of them carries an account. On a shared browser they hold
 * whoever signed in last, so the next person to sign in inherits them: their
 * canvas filters name someone else's projects, the palette's "Recent" group
 * lists someone else's commands, the Beacon panel rehydrates someone else's
 * conversation, and — the sharp one — the Beacon settings page shows them
 * someone else's API key as an editable field.
 *
 * lib/settings/hydration.ts already writes this problem down ("Every store the
 * settings surface reads is localStorage-persisted under a browser-GLOBAL key
 * … On a shared browser those keys hold whoever signed in last"). Its
 * `settingsBelongToUser` gate makes the /settings route wait rather than paint
 * that state. This module is the other half: the gate stops the values being
 * READ as the wrong person's; nothing until now stopped them BEING there.
 *
 * ── WHY A STAMP, NOT A SIGN-OUT HANDLER ─────────────────────────────────────
 * "Clear on sign-out" is half a fix, because sign-out is not the only way the
 * current user changes, and most of the other ways leave no event to hang a
 * handler on:
 *
 *   1. Explicit sign-out.            SIGNED_OUT fires. Handled below.
 *   2. Account switch with no        Supabase can deliver a bare SIGNED_IN for
 *      intervening sign-out.         a different user (supabase-provider's
 *                                    hydrateSettings says so in its own note).
 *   3. Session expiry, tab closed,   NO event ever fires. The next thing that
 *      someone else signs in later.  happens is a plain SIGNED_IN on a fresh
 *                                    page load, indistinguishable from case 4.
 *   4. Plain page load, already      No event, no previous user in memory to
 *      signed in as someone new.     compare against — `hydratedUserId` starts
 *                                    null on every load.
 *   5. ANOTHER TAB adopts a new      Case 2 in every tab at once. See the
 *      user while this one is open.  cross-tab section below; the stamp alone
 *                                    makes this one WORSE, not better.
 *
 * Cases 3 and 4 are unreachable from memory: after a reload the app has no idea
 * who wrote the blob on disk. So this module writes that down.
 * `dsul-local-state-owner` names the account whose state is currently on
 * disk; every established session compares itself against it and clears on a
 * mismatch. That is the same move morning-store makes with
 * `settingsHydratedUserId` — an explicit "whose is this?" field instead of
 * inferring ownership from a coincidence — differing only in that this one has
 * to survive a reload, so it is persisted.
 *
 * ── CROSS-TAB (case 5) ──────────────────────────────────────────────────────
 * The stamp is global; the stores are per-tab. Supabase broadcasts SIGNED_IN to
 * every open tab, so on an account switch the first tab to arrive clears, wipes
 * the blobs and stamps the new owner — and every OTHER tab then compares itself
 * against a stamp that already matches, returns false, and keeps the previous
 * account in memory. That is worse than a missed clear: persist rewrites the
 * whole `partialize` on the very next `set()`, so the stale tab RESURRECTS the
 * previous account's blob onto disk under the new owner's stamp, and from then
 * on `adoptLocalState` returns false forever — the idempotency guard starts
 * protecting the leak.
 *
 * Hence the `storage` listener at the bottom of this file. It fires only in the
 * OTHER tabs (the writer never sees its own event), so a re-stamp anywhere is
 * what tells this tab its memory is stale. It clears the stores WITHOUT
 * touching the stamp — the tab that wrote it owns it.
 *
 * ── FAIL CLOSED, BUT NOT INDISCRIMINATELY ───────────────────────────────────
 * No stamp means nothing on disk records who wrote it. Every existing install
 * is in that state on its first load after this ships, and neither `dsul-view`
 * nor `dsul-ai-settings` has ANY server copy — no `saveSettings` call, no
 * supabase reference in either file — so a blanket clear there is permanent,
 * unrecoverable loss of things the user authored.
 *
 * So the clear has two scopes, and every persisted field is classified:
 *
 *   DISCLOSIVE — says something about a PERSON: a credential, text they wrote,
 *     names taken from their own data, times of day they keep, dates they acted
 *     on, what they recently did. Cleared under BOTH scopes, because on an
 *     unstamped browser we cannot rule out that it is someone else's.
 *
 *   INERT — says something about the SHAPE OF THE SCREEN and nothing about
 *     anyone: enum-valued layout, density, grouping and sort axes, which buckets
 *     are folded, which keys are bound. Cleared only under 'all' — i.e. when we
 *     KNOW the user changed (a stamp naming someone else, or a sign-out).
 *
 * The per-field verdicts live beside the fields, in each store's own
 * `clearUserScopedState`. The summary:
 *
 *   planner-storage        all 13 INERT — density, view mode, grouping axis,
 *                          sort/visibility toggles, week start, clock format.
 *                          Enum and boolean throughout; none is free text.
 *   dsul-view            canvasFilters / braindumpFilters DISCLOSIVE (they
 *                          hold `project:`/`group:` refs, tag names and goal ids
 *                          lifted from the account's own containers). The other
 *                          13 INERT. `adoptedLegacy` never cleared at all.
 *   dsul-ai-settings     all DISCLOSIVE — apiKey is a credential,
 *                          systemPrompt and assistantName are text the user
 *                          wrote, and provider/model name the paid vendor
 *                          account behind the key (and are incoherent without
 *                          it).
 *   dsul-morning-store   all DISCLOSIVE — the check TIME is the hour this
 *                          person gets up, the dismissal is a date they acted
 *                          on, the auto-age policy drives an unattended
 *                          mutation, and a receipt carries row TITLES.
 *   dsul-eod-store       all DISCLOSIVE — same reasons, at the other end of
 *                          the day.
 *   dsul-sidebar-settings  leftSidebarHoverEnabled INERT. Width and
 *                          open/collapsed chrome never cleared at all.
 *   dsul-keyboard-shortcuts  overrides INERT — an id→keys map, no free text,
 *                          and there is no server copy to restore it from.
 *   dsul-command-usage   DISCLOSIVE — "Recent" renders the previous person's
 *                          last actions as labels.
 *   chat transcripts       DISCLOSIVE, obviously and entirely.
 *   sweep-grace            DISCLOSIVE — keyed by the previous account's row ids.
 *
 * ── WHAT IS NEVER CLEARED, EVEN UNDER 'all' ─────────────────────────────────
 * The sidebar WIDTH and open/collapsed chrome (a property of the monitor you
 * are sitting at, per sidebar-store's own note) and view-store's
 * `adoptedLegacy` (a one-time migration marker about this browser, not a
 * preference). Theme and palette are out of scope on purpose: presentation,
 * disclosing nothing, re-applied from `user_settings` on the next sign-in, and
 * clearing them would mean reaching into next-themes' own storage and the
 * blocking pre-paint script in app/layout.tsx for no security gain.
 *
 * ── THE RESIDUE ─────────────────────────────────────────────────────────────
 * This makes the Beacon API key stop OUTLIVING its owner's session. It does not
 * make localStorage a good place for a credential. The standard this repo holds
 * everywhere else is `user_secrets` — service-role only, with
 * /api/reminders/secrets answering which keys are set and never what they are —
 * and the Beacon key should move there under its own ticket.
 */
export const LOCAL_STATE_OWNER_KEY = 'dsul-local-state-owner';

/**
 * 'all' — we KNOW the user changed. 'disclosive' — we do not know whose this
 * browser is, so drop what says something about a person and leave the inert
 * presentation alone. See the classification above.
 */
export type ClearScope = 'all' | 'disclosive';

export interface ClearContext {
  scope: ClearScope;
  /** The account taking ownership, or null on a sign-out. */
  incomingUserId: string | null;
}

/** One persisted store, as the registry and its audit test see it. */
interface PersistedUserStore {
  /** The localStorage key it persists under. */
  key: string;
  /** Persisted fields never cleared, under any scope. */
  keeps: readonly string[];
  /** Persisted fields cleared only under scope 'all'. */
  inert: readonly string[];
  clear: (ctx: ClearContext) => void;
}

/**
 * Every zustand store that persists per-user state to localStorage.
 *
 * THE ONE PLACE. A store's own `clearUserScopedState` decides which of ITS
 * fields are account-owned and which are inert — that has to live beside the
 * fields — but the decision that the user changed, and the list of who hears
 * about it, is here and only here. Adding a persisted store means adding a line
 * to this array; tests/unit/local-state.test.ts walks it and fails on any
 * persisted key that survives a clear without being declared.
 */
export const PERSISTED_USER_STORES: readonly PersistedUserStore[] = [
  {
    key: 'planner-storage',
    keeps: [],
    inert: [
      'compactMode',
      'viewMode',
      'chillMode',
      'groupBy',
      'showCurrentTimeIndicator',
      'timelineItemFilter',
      'showCompletedTasks',
      'showPausedOnGrid',
      'defaultView',
      'defaultTimeBucket',
      'animationsEnabled',
      'weekStartDay',
      'timeFormat',
    ],
    clear: ({ scope }) => usePlannerStore.getState().clearUserScopedState(scope),
  },
  {
    key: 'dsul-view',
    keeps: ['adoptedLegacy'],
    inert: [
      'scope',
      'layout',
      'typeFilter',
      'canvasGroupBy',
      'braindumpGroupBy',
      'canvasSortBy',
      'braindumpSortBy',
      'typeMode',
      'scheduleMarkStyle',
      'weekDaysVisible',
      'bucketStyle',
      'collapsedBuckets',
      // Inert on the same test every field above it passes: a boolean saying
      // which of two screens is showing, and nothing whatever about the person
      // looking at it. The sharper reason to spare it under 'disclosive' is
      // that clearing it there would be a silent eviction — an unstamped
      // browser is every existing install exactly once, and someone who left
      // the room open would find the planner instead with nothing on screen to
      // explain why.
      'zenOpen',
      // Whether the Zen switch animation is mid-flight. Persisted only because
      // the store persists every field; the merge forces it off on load.
      'zenMoving',
    ],
    clear: ({ scope }) => useViewStore.getState().clearUserScopedState(scope),
  },
  {
    key: 'dsul-ai-settings',
    keeps: [],
    inert: [],
    clear: () => useAISettingsStore.getState().clearUserScopedState(),
  },
  {
    key: 'dsul-morning-store',
    keeps: [],
    inert: [],
    clear: ({ incomingUserId }) => useMorningStore.getState().clearUserScopedState(incomingUserId),
  },
  {
    key: 'dsul-eod-store',
    keeps: [],
    inert: [],
    clear: () => useEODStore.getState().clearUserScopedState(),
  },
  {
    key: 'dsul-sidebar-settings',
    keeps: ['leftSidebarOpen', 'chatExpanded', 'leftSidebarWidth'],
    inert: ['leftSidebarHoverEnabled'],
    clear: ({ scope }) => useSidebarStore.getState().clearUserScopedState(scope),
  },
  {
    key: 'dsul-keyboard-shortcuts',
    keeps: [],
    inert: ['overrides'],
    clear: ({ scope }) => useKeyboardShortcutsStore.getState().clearUserScopedState(scope),
  },
  {
    key: 'dsul-command-usage',
    keeps: [],
    inert: [],
    clear: () => useCommandUsageStore.getState().clearUserScopedState(),
  },
];

/**
 * Per-user state that reaches localStorage without a zustand persist blob, so
 * the audit test cannot walk it by key: chat transcripts span one fixed key
 * plus one per item thread, and sweep-grace is plain functions over a raw map.
 * Both are wholly disclosive, so neither takes a scope. Covered by named tests.
 */
const RAW_CLEARERS: readonly (() => void)[] = [clearChatState, clearReleased];

/** The account whose local state is on disk right now, or null for none. */
export function localStateOwner(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LOCAL_STATE_OWNER_KEY);
  } catch {
    // Unreadable storage reads as unowned, which clears. Fail closed.
    return null;
  }
}

function setLocalStateOwner(userId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (userId === null) window.localStorage.removeItem(LOCAL_STATE_OWNER_KEY);
    else window.localStorage.setItem(LOCAL_STATE_OWNER_KEY, userId);
  } catch {
    // Private mode. Nothing is stamped, so the next load clears again — the
    // wasteful direction, not the leaking one.
  }
}

/**
 * Run every clearer, isolated from every other one.
 *
 * EACH CALL IS ITS OWN TRY/CATCH, and that is not defensive dressing. A clear
 * is a zustand `set()`, and the persist middleware calls `storage.setItem`
 * UNWRAPPED — a browser at its quota, or one with site data blocked, throws
 * `QuotaExceededError`/`SecurityError` straight back out of `set()`. In a bare
 * loop that one throw aborts the stores after it, both raw clearers and the
 * stamp write; and because this runs FIRST inside the provider's `adoptUser`,
 * it would take `loadPlanner`, `hydrateSettings` and both extension hydrates
 * down with it. The app would come up as a blank shell on a browser that,
 * before this change, merely failed to persist.
 *
 * Swallowing is right rather than merely safe: a clear that cannot write is a
 * clear that had nothing durable to erase either, and there is no user action
 * that would help.
 */
function clearStores(ctx: ClearContext): void {
  for (const store of PERSISTED_USER_STORES) {
    try {
      store.clear(ctx);
    } catch {
      /* hostile storage — see above */
    }
  }
  for (const clear of RAW_CLEARERS) {
    try {
      clear();
    } catch {
      /* hostile storage — see above */
    }
  }
}

/**
 * Drop every per-user local store back to its defaults and release the stamp.
 *
 * Synchronous and total over the state THIS MODULE OWNS: by the time it
 * returns, no localStorage-persisted store holds the previous account. It does
 * NOT speak for the planner's DATA — items, containers and goals live in
 * planner-store's unpersisted slices and are dropped by `clearStore()`, which
 * the provider calls on SIGNED_OUT only. On a bare account switch the previous
 * user's item list therefore stays in memory and on screen until
 * `loadPlanner(B)` resolves and replaces it.
 */
export function clearUserScopedLocalState(): void {
  clearStores({ scope: 'all', incomingUserId: null });
  setLocalStateOwner(null);
}

/**
 * Make `userId` the owner of this browser's local state.
 *
 * Clears first unless they already owned it, then stamps. Returns whether it
 * cleared, which is what the tests assert on.
 *
 * IDEMPOTENT BY DESIGN. Supabase re-emits SIGNED_IN on every hidden→visible
 * transition and broadcasts it across tabs, so this runs constantly for a
 * session that has not changed at all — and a clear on one of those would throw
 * away preferences the user set this session. The stamp comparison is what
 * makes the repeat a no-op. (It is also why the cross-tab listener below exists
 * rather than being folded in here: after a sibling tab re-stamps, this
 * comparison is satisfied and can no longer speak for THIS tab's memory.)
 */
export function adoptLocalState(userId: string): boolean {
  const owner = localStateOwner();
  if (owner === userId) return false;
  // An unstamped browser is the every-existing-install case, not an attack:
  // drop what could belong to someone else, keep what could not belong to
  // anyone. A stamp naming a different account is a known user change.
  clearStores({ scope: owner === null ? 'disclosive' : 'all', incomingUserId: userId });
  setLocalStateOwner(userId);
  return true;
}

/**
 * Case 5: another tab established a different owner.
 *
 * `storage` fires only in tabs OTHER than the writer, and only when the value
 * actually changed, so this is exactly "someone else re-stamped". Scope is
 * always 'all' — a sibling tab writing the stamp is proof the user changed,
 * which is more than `adoptLocalState` ever gets to know on its own.
 *
 * The stamp is deliberately NOT written here: the tab that wrote it owns it,
 * and re-writing it from a handler is how a storage listener becomes a loop.
 *
 * Registered at module scope and guarded for SSR, the same shape chat-store
 * uses for its own provider subscription. The residual race — this tab having
 * already hydrated the NEW user's settings when the event lands, and holding
 * defaults until the next reload — is the narrow, non-leaking direction, and
 * the event is delivered long before those fetches resolve.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LOCAL_STATE_OWNER_KEY) return;
    clearStores({ scope: 'all', incomingUserId: event.newValue });
  });
}
