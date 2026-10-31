import type { AtlasCard } from './atlas-model';
import type { ItemEvent } from './db';
import { lastDoneOn } from './goals';
import { toDateStr } from './recurrence';
import { toDateOnly } from './overdue';
import { daysBetween } from './container-schedule';
import { ATLAS_RESTING_DAYS } from './atlas-model';

/**
 * Momentum's side channel (design PR2): when each card was last touched,
 * beyond what the store can say.
 *
 * The store knows a recurring tick (`lastDoneOn`). It does not know when a
 * one-off was finished or an item was added, so this reads `item_events`
 * (creates and status changes) and `items.completed_at`, and merges both with
 * the store's own touch. Never `items.updated_at`, which every sync bumps.
 *
 * - `fetchItemEventsFor` caps a batch at 200 ids AND 200 rows newest first, so
 *   a few busy items would push everyone else's last event out: it is asked
 *   about {@link ACTIVITY_BATCH} ids at a time.
 * - `fetchCompletedAt` throws on an error; that read is quiet.
 * - A failed or unavailable events read (it answers `[]` quietly, and
 *   `getItemEventsAvailable()` goes false once the table is missing) is
 *   UNKNOWN, never "quiet": then only a recent touch counts, and an old one
 *   reads 'unknown', so no card goes to Resting on a read that failed (rule 13).
 * - Read on Atlas mount, twice (now and at +2s, since events land
 *   fire-and-forget after the write), and cached for {@link ACTIVITY_CACHE_MS}
 *   so switching layouts never re-reads.
 *
 * A grouped `max(created_at)` RPC would be exact but needs SQL in a
 * migration; not in v1.
 */

export const ACTIVITY_BATCH = 25;
/** How far back the events read looks. Older than this is unknown. */
export const ACTIVITY_WINDOW_DAYS = 120;
export const ACTIVITY_CACHE_MS = 60_000;

/** Last touch per card key: yyyy-MM-dd, or 'unknown'. */
export type AtlasActivity = ReadonlyMap<string, string | 'unknown'>;

/** Last touch per item id, as ISO stamps from the server. */
export interface ItemTouches {
  touches: ReadonlyMap<string, string>;
  /** The events read worked (the table is there and nothing threw). */
  eventsOk: boolean;
}

export interface ActivityDeps {
  fetchEvents: (ids: readonly string[], sinceIso: string) => Promise<ItemEvent[]>;
  fetchCompletedAt: (ids: readonly string[]) => Promise<Map<string, string>>;
  eventsAvailable: () => boolean;
  now?: () => number;
}

const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : a > b ? a : b);

/** Reads the server's touches for these items, 25 ids per events read. */
export async function readItemTouches(ids: readonly string[], deps: ActivityDeps): Promise<ItemTouches> {
  const touches = new Map<string, string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { touches, eventsOk: true };
  const now = deps.now?.() ?? Date.now();
  const since = new Date(now - ACTIVITY_WINDOW_DAYS * 86_400_000).toISOString();
  let eventsOk = deps.eventsAvailable();
  if (eventsOk) {
    for (let i = 0; i < unique.length; i += ACTIVITY_BATCH) {
      try {
        const rows = await deps.fetchEvents(unique.slice(i, i + ACTIVITY_BATCH), since);
        for (const r of rows) touches.set(r.itemId, later(touches.get(r.itemId), r.createdAt)!);
      } catch {
        eventsOk = false;
        break;
      }
      // The table went missing mid-read: what was read stands, the rest is unknown.
      if (!deps.eventsAvailable()) {
        eventsOk = false;
        break;
      }
    }
  }
  try {
    const done = await deps.fetchCompletedAt(unique);
    for (const [id, at] of done) touches.set(id, later(touches.get(id), at)!);
  } catch {
    // Quiet: the store's own touch and the events still stand.
  }
  return { touches, eventsOk };
}

/** The store's own last touch for a card (lastDoneOn, a goal's achievedAt, a season's updatedAt). */
export function storeTouchOf(card: AtlasCard): string | undefined {
  const t = card.touch;
  if (t.kind === 'touched') return t.on;
  if (t.kind === 'resting') return t.since;
  return undefined;
}

/**
 * Per card, the latest touch from the store and the server. With the events
 * read failed or unavailable, a server touch older than the resting threshold
 * is dropped (a newer event may exist that this read could not see), so a card
 * never goes to Resting on missing data. No touch at all is 'unknown'.
 */
export function cardActivity(
  cards: readonly AtlasCard[],
  server: ItemTouches | null,
  todayStr: string,
  tz: string,
): Map<string, string | 'unknown'> {
  const out = new Map<string, string | 'unknown'>();
  const today = toDateOnly(todayStr);
  const trusted = !!server && server.eventsOk;
  const clamp = (d: string | undefined) => (d && d > today ? today : d);
  for (const card of cards) {
    // The store's touch is known whatever the server said (the footer says it too).
    let mine = storeTouchOf(card);
    let theirs: string | undefined;
    for (const m of card.members) {
      mine = later(mine, lastDoneOn(m.item));
      const at = server?.touches.get(m.item.id);
      if (at) theirs = later(theirs, toDateStr(new Date(at), tz));
    }
    mine = clamp(mine);
    theirs = clamp(theirs);
    // An old server touch from a read that failed part way says nothing: a
    // newer event may be one this read never saw.
    if (theirs && !trusted && daysBetween(theirs, today) > ATLAS_RESTING_DAYS) theirs = undefined;
    out.set(card.key, later(mine, theirs) ?? 'unknown');
  }
  return out;
}

/* ── the read, cached ─────────────────────────────────────────────────── */

let cache: { key: string; at: number; value: ItemTouches } | null = null;

/** A cached answer for exactly these ids, when fresh. */
export function cachedTouches(ids: readonly string[], now = Date.now()): ItemTouches | null {
  const key = idsKey(ids);
  if (!cache || cache.key !== key || now - cache.at > ACTIVITY_CACHE_MS) return null;
  return cache.value;
}

export function rememberTouches(ids: readonly string[], value: ItemTouches, now = Date.now()): void {
  cache = { key: idsKey(ids), at: now, value };
}

/** Sign-out and account switches (lib/local-state.ts's raw clearers). */
export function clearAtlasActivity(): void {
  cache = null;
}

export function idsKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(',');
}
