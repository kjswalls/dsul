import { addDaysStr } from './container-schedule';
import { toDateStr } from './recurrence';
import type { Item } from './planner-types';

/**
 * A container's recent activity — what happened to its members, newest first.
 *
 * Built only from what the app already stores, never from a log of its own:
 *  · "Completed X" — each date in a member's `completedDates` (the per-date
 *    record recurring items keep), and a one-off task's status set to its done
 *    status, from the `item_events` update that wrote it;
 *  · "Added X" — the member's `item_events` create.
 * Day-granular on purpose: a completion is recorded as a DATE, and a feed
 * that invented times for some rows and not others would read as precise
 * where it is not. Nothing here says what did NOT happen — the feed is a
 * record, never a scold (the guilt-free rule).
 */

export interface ActivityEntry {
  kind: 'completed' | 'added';
  itemId: string;
  title: string;
  /** yyyy-MM-dd in the user's zone. */
  date: string;
  /** For ordering within a day; the date's own midnight when only a date is known. */
  sortKey: string;
}

export interface ActivityEvent {
  itemId: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** How far back the feed looks. */
export const ACTIVITY_DAYS = 14;

export function deriveActivity({
  members,
  events,
  todayStr,
  tz,
  limit = 6,
}: {
  members: readonly Item[];
  events: readonly ActivityEvent[];
  todayStr: string;
  tz: string;
  limit?: number;
}): ActivityEntry[] {
  const since = addDaysStr(todayStr, -(ACTIVITY_DAYS - 1));
  const byId = new Map(members.map((m) => [m.id, m]));
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  const push = (e: ActivityEntry) => {
    const key = `${e.kind}:${e.itemId}:${e.date}`;
    if (seen.has(key) || e.date < since || e.date > todayStr) return;
    seen.add(key);
    out.push(e);
  };

  for (const m of members) {
    for (const d of m.completedDates ?? []) {
      push({ kind: 'completed', itemId: m.id, title: m.title, date: d, sortKey: `${d}T00:00:00` });
    }
  }
  for (const ev of events) {
    const m = byId.get(ev.itemId);
    if (!m) continue;
    const date = toDateStr(new Date(ev.createdAt), tz);
    if (ev.action === 'create') {
      push({ kind: 'added', itemId: m.id, title: m.title, date, sortKey: ev.createdAt });
    } else if (ev.action === 'update' && (ev.payload.status === 'completed' || ev.payload.status === 'done')) {
      // A one-off's completion — recurring ones are already counted by date.
      if ((m.completedDates ?? []).includes(date)) continue;
      push({ kind: 'completed', itemId: m.id, title: m.title, date, sortKey: ev.createdAt });
    }
  }

  return out.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0)).slice(0, limit);
}
