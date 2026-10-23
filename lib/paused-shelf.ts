import { formatDay, inactiveItemIdsOn, suppressionLabel, suppressionReason, type ActivationContext } from './active';
import { addDays } from './away';
import { getItemTypeConfig, itemTypeName } from './item-registry';
import { toDateOnly } from './overdue';
import type { Item, Routine, Season } from './planner-types';

/**
 * Everything set aside, as the Organize console's Paused section lists it and
 * its rail row counts it — one derivation, so the count on the rail is always
 * the number of rows behind it.
 *
 * WHY THIS EXISTS AT ALL is programs-routines.md locked decision 10: pausing
 * hides an item from the grid, the review, the past-due bar and the braindump,
 * so without a browsable home the only way back is remembering its name. That
 * home was a drawer at the foot of the braindump until 2026-10-23, when Kirby
 * moved it into Organize (programs-routines.md, addendum 2026-10-23).
 *
 * GROUPED BY THE DAY IT COMES BACK, soonest first, with the undated ones last.
 * The question someone opening this has is "what's coming back, and when";
 * the cause is still on every row, but it is no longer the heading.
 *
 * A ROUTINE OR SEASON IS ONE ENTRY, carrying its hidden members, rather than a
 * row per member. Pausing Morning used to add four rows; it adds one, and its
 * Resume is the container's own switch (lib/gate-toggle.ts). The entry is keyed
 * on the container the item's suppressionReason NAMES, which is the switch that
 * actually brings it back (a routine a season is holding names the season).
 *
 * Resolved at TODAY by the caller, never a browsed date: pausing is dateless
 * (locked decision 3).
 */

export type PausedEntry =
  | { kind: 'item'; key: string; item: Item; until?: string }
  | { kind: 'routine'; key: string; routine: Routine; until?: string; items: Item[] }
  | { kind: 'season'; key: string; season: Season; until?: string; items: Item[] };

export interface PausedDay {
  /** The return day, or '' for the undated group. */
  key: string;
  until?: string;
  entries: PausedEntry[];
}

export interface PausedShelf {
  days: PausedDay[];
  /** Items, not entries: a routine of four counts four. */
  count: number;
}

const EMPTY: PausedShelf = { days: [], count: 0 };

export function pausedShelf(
  items: readonly Item[],
  todayStr: string,
  ctx: ActivationContext,
  /** Already resolved at today by a caller that has it (the braindump does). */
  suppressed?: ReadonlySet<string>,
): PausedShelf {
  const hidden = suppressed ?? inactiveItemIdsOn(items, todayStr, ctx);
  if (hidden.size === 0) return EMPTY;

  const entries = new Map<string, PausedEntry>();
  let count = 0;
  for (const item of items) {
    if (!hidden.has(item.id)) continue;
    // A subtask has no standalone row anywhere else; it travels with its parent.
    if ('parentItemId' in item && item.parentItemId) continue;
    const reason = suppressionReason(item, todayStr, ctx);
    // Resting for a trip is not "set aside": every habit rests at once, and the
    // trip's own line in the date capsule already says so and brings them back.
    if (reason?.kind === 'away') continue;
    count++;
    if (reason?.kind === 'routine') {
      const key = `routine:${reason.routine.id}`;
      const entry = entries.get(key);
      if (entry?.kind === 'routine') entry.items.push(item);
      else entries.set(key, { kind: 'routine', key, routine: reason.routine, until: reason.until, items: [item] });
    } else if (reason?.kind === 'season') {
      const key = `season:${reason.season.id}`;
      const entry = entries.get(key);
      if (entry?.kind === 'season') entry.items.push(item);
      else entries.set(key, { kind: 'season', key, season: reason.season, until: reason.until, items: [item] });
    } else {
      // A null reason can't normally reach here (the set and suppressionReason
      // agree), but listing it as an undated pause keeps the row reachable
      // rather than dropping it on the floor.
      entries.set(`item:${item.id}`, { kind: 'item', key: `item:${item.id}`, item, until: reason?.until });
    }
  }
  if (count === 0) return EMPTY;

  const days = new Map<string, PausedDay>();
  for (const entry of entries.values()) {
    const key = entry.until ? toDateOnly(entry.until) : '';
    const day = days.get(key);
    if (day) day.entries.push(entry);
    else days.set(key, { key, until: key || undefined, entries: [entry] });
  }
  // Containers first within a day — one row that brings several back reads
  // before the single items — then each in the order the store holds them.
  const rank = (e: PausedEntry) => (e.kind === 'item' ? 1 : 0);
  for (const day of days.values()) day.entries.sort((a, b) => rank(a) - rank(b));

  return {
    days: [...days.values()].sort((a, b) => {
      if (a.key === b.key) return 0;
      if (!a.key) return 1;
      if (!b.key) return -1;
      return a.key < b.key ? -1 : 1;
    }),
    count,
  };
}

/**
 * The Paused rail row's second line in Organize: "5 · Gym back Fri", or just
 * "5" when nothing set aside has a day to come back. Null with nothing paused,
 * so the row stays one line. It names the soonest return only: the rail is
 * 180px, and the list behind the row has the rest.
 */
export function pausedNote(shelf: PausedShelf, todayStr: string): string | null {
  if (shelf.count === 0) return null;
  const next = shelf.days.find((d) => d.until);
  if (!next?.until) return String(shelf.count);
  return `${shelf.count} · ${pausedEntryName(next.entries[0])} back ${backWhen(next.until, todayStr)}`;
}

/** "tomorrow", "Fri" within the week, "Nov 12" past it. */
function backWhen(day: string, todayStr: string): string {
  const diff = daysFrom(todayStr, day);
  if (diff <= 1) return 'tomorrow';
  if (diff < 7) return weekdayShort(day);
  return formatDay(day);
}

/** Whole calendar days from `todayStr` to `day`, both yyyy-MM-dd. */
function daysFrom(todayStr: string, day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const [ty, tm, td] = todayStr.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

/**
 * The day's short weekday in fixed English, as `formatDay`'s months are: the
 * same word on every device whatever its locale, and a fixture that does not
 * depend on the machine it was written on.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekdayShort(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** A return day's heading on the Paused list: "Tomorrow", "Thu, Oct 30", a return, said the way a calendar would. */
export function returnDayLabel(day: string, todayStr: string): string {
  if (daysFrom(todayStr, day) === 1) return 'Tomorrow';
  return `${weekdayShort(day)}, ${formatDay(day)}`;
}

/** The heading over the entries with no day to come back. */
export const PAUSED_NO_DATE = 'No date';

/** A group's heading: its return day's label, or {@link PAUSED_NO_DATE}. */
export function pausedDayLabel(day: Pick<PausedDay, 'until'>, todayStr: string): string {
  return day.until ? returnDayLabel(day.until, todayStr) : PAUSED_NO_DATE;
}

/** The Paused list with nothing set aside. */
export const NOTHING_PAUSED = 'Nothing is paused.';

/** What the Paused list is, said once beside it (guilt-free: nothing here is late). */
export const PAUSED_WELCOME =
  "Things you've set aside. Nothing here is late: each one comes back on its own day, or whenever you resume it.";

/**
 * What an entry is, under its name: "Habit" (the item's type label),
 * "Routine · 4 habits", "Season · 3 items". A container says "habits" only
 * when every member it is hiding is one.
 */
export function entryKindLine(entry: PausedEntry): string {
  if (entry.kind === 'item') return getItemTypeConfig(itemTypeName(entry.item)).label;
  const n = entry.items.length;
  const allHabits = entry.items.every((i) => i.type === 'habit');
  const noun = allHabits ? (n === 1 ? 'habit' : 'habits') : n === 1 ? 'item' : 'items';
  return `${entry.kind === 'routine' ? 'Routine' : 'Season'} · ${n} ${noun}`;
}

/**
 * An entry's state line, the long form of why it is away, as a sentence:
 * "Paused until Oct 30.", "Hidden with your Morning routine. It stays set
 * aside until you resume it." Asked of the entry's first item, so it can never
 * disagree with what the grid would say. `ctx` is the routines and seasons
 * with NO trips, as the detail pane asks it: a trip's rest is never an entry.
 */
export function pausedStateLine(entry: PausedEntry, todayStr: string, ctx: ActivationContext): string {
  const first = entry.kind === 'item' ? entry.item : entry.items[0];
  const reason = first ? suppressionReason(first, todayStr, ctx) : null;
  const line = reason ? suppressionLabel(reason, { long: true }) : 'Paused';
  return `${line}${entry.until ? '.' : '. It stays set aside until you resume it.'}`;
}

/** What a paused entry is called on its row and on the rail's line. */
export function pausedEntryName(entry: PausedEntry): string {
  if (entry.kind === 'item') return entry.item.title;
  return entry.kind === 'routine' ? entry.routine.name : entry.season.name;
}

/**
 * What comes back ON `dateStr`: set aside the day before, live on the day, and
 * the reason named this very day as its return. The date capsule says so on
 * that day ("Back today"). A trip's return is the trip's own line, so it is
 * left out here exactly as it is left out of the shelf.
 *
 * Containers are named once, like the shelf names them. Only the day before is
 * asked, and only of the items hidden on it, so a browsed week costs one pass
 * per column rather than one per item per path.
 */
export function backOn(
  items: readonly Item[],
  dateStr: string,
  ctx: ActivationContext,
): string[] {
  const day = toDateOnly(dateStr);
  const before = addDays(day, -1);
  const hiddenBefore = inactiveItemIdsOn(items, before, ctx);
  if (hiddenBefore.size === 0) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!hiddenBefore.has(item.id)) continue;
    if ('parentItemId' in item && item.parentItemId) continue;
    const reason = suppressionReason(item, before, ctx);
    if (!reason || reason.kind === 'away' || !reason.until || toDateOnly(reason.until) !== day) continue;
    if (suppressionReason(item, day, ctx)) continue;
    const key =
      reason.kind === 'routine'
        ? `routine:${reason.routine.id}`
        : reason.kind === 'season'
          ? `season:${reason.season.id}`
          : `item:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(
      reason.kind === 'routine'
        ? reason.routine.name
        : reason.kind === 'season'
          ? reason.season.name
          : item.title,
    );
  }
  return names;
}
