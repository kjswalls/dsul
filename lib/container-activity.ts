import { addDaysStr } from './container-schedule';
import { getItemTypeConfig, itemTypeName } from './item-registry';
import { toDateStr } from './recurrence';
import type { Item } from './planner-types';

/**
 * A container's recent activity — what happened to its members, newest first.
 *
 * Built only from what the app already stores, never from a log of its own:
 *  · "Completed X" — each date in a member's `completedDates` (the per-date
 *    record recurring items keep), and a one-off's LATEST status event when it
 *    set the type's done status and the item still holds it — un-ticking
 *    writes a later event, and a feed that kept the first one would say done
 *    about something that is not;
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
  /** For ordering within a day: the event's instant, or '' when only a date is known. */
  at: string;
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
      push({ kind: 'completed', itemId: m.id, title: m.title, date: d, at: '' });
    }
  }
  // Newest first, so the first status event met per item is its latest.
  const ordered = [...events].sort((a, b) => cmp(b.createdAt, a.createdAt));
  const statusSeen = new Set<string>();
  for (const ev of ordered) {
    const m = byId.get(ev.itemId);
    if (!m) continue;
    const date = toDateStr(new Date(ev.createdAt), tz);
    if (ev.action === 'create') {
      push({ kind: 'added', itemId: m.id, title: m.title, date, at: ev.createdAt });
    } else if (ev.action === 'update' && typeof ev.payload.status === 'string') {
      if (statusSeen.has(m.id)) continue;
      statusSeen.add(m.id);
      const done = getItemTypeConfig(itemTypeName(m)).doneStatus;
      if (ev.payload.status !== done || m.status !== done) continue;
      // Recurring completions are already counted by date.
      if ((m.completedDates ?? []).includes(date)) continue;
      push({ kind: 'completed', itemId: m.id, title: m.title, date, at: ev.createdAt });
    }
  }

  // The day decides, then the instant within it. Both keys are compared in
  // the user's zone: a UTC timestamp against a local date string would put a
  // west-of-UTC evening above the next morning.
  return out.sort((a, b) => cmp(b.date, a.date) || cmp(b.at, a.at)).slice(0, limit);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
