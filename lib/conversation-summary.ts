import type { ProposalOperation } from './planner-types';
import { assigneeLabel } from './chat-utils';
import { CHAT_LIMITS, type ConversationChanges, type ConversationSummary } from './conversation-types';
import { clockTime } from './format-chat-timestamp';

/**
 * What a conversation changed, as History's second line says it.
 *
 * Pure and client-safe. A conversation stores four counters (migration 057);
 * everything a row SAYS is derived here, at render time, from those counters
 * and the item as the planner holds it now. Live agent state must never freeze
 * into a row: "waiting on you" read from a column would still be saying it a
 * week after the answer.
 */

export const NO_CHANGES: Readonly<ConversationChanges> = Object.freeze({ added: 0, steps: 0, moved: 0, changed: 0 });

/** The scheduling fields: an update touching any of them MOVED the item. */
const MOVE_FIELDS = ['startDate', 'timeBucket', 'startTime'] as const;

/**
 * What one accepted proposal did, counted in DISTINCT items per bucket:
 *   - a create with `parentItemId` is a step under that item;
 *   - any other create is an added item;
 *   - an update touching startDate, timeBucket or startTime moved its item;
 *   - any other update changed it.
 * An item both moved and changed in one proposal counts once, as moved: the
 * line is about what the user will notice. Each counter is at most
 * CHAT_LIMITS.changesPerCall (a proposal carries at most 20 operations), so a
 * tally always fits one PATCH.
 */
export function tallyOperations(ops: readonly ProposalOperation[]): ConversationChanges {
  let added = 0;
  let steps = 0;
  const moved = new Set<string>();
  const changed = new Set<string>();
  for (const op of ops) {
    if (op.kind === 'create') {
      if (op.parentItemId) steps += 1;
      else added += 1;
      continue;
    }
    // A tick, a skip or a pause changes the item, not its place; so does
    // putting it in a container or taking it out.
    // A delete or a streak reset is counted as a change too: the counters are
    // stored columns, and neither is common enough to earn one of its own.
    if (op.kind === 'delete') {
      changed.add(`${op.what}:${op.id}`);
      continue;
    }
    if (op.kind === 'verb' || op.kind === 'membership' || op.kind === 'resetStreak') {
      changed.add(op.itemId);
      continue;
    }
    // A new project, routine, season or goal is something added; a changed
    // one is a change, counted once whatever the card did to it.
    if (op.kind === 'container') {
      if (op.containerId) changed.add(`container:${op.containerId}`);
      else added += 1;
      continue;
    }
    const touchesSchedule = MOVE_FIELDS.some((f) => op[f] !== undefined);
    if (touchesSchedule) moved.add(op.itemId);
    else changed.add(op.itemId);
  }
  for (const id of moved) changed.delete(id);
  const cap = (n: number) => Math.min(n, CHAT_LIMITS.changesPerCall);
  return { added: cap(added), steps: cap(steps), moved: cap(moved.size), changed: cap(changed.size) };
}

export function hasChanges(c: ConversationChanges | null | undefined): boolean {
  return !!c && c.added + c.steps + c.moved + c.changed > 0;
}

/** The counters after another tally, each held to the column's ceiling (100,000). */
export function addChanges(a: ConversationChanges, b: Partial<ConversationChanges>): ConversationChanges {
  const sum = (x: number, y: number | undefined) => Math.min(100_000, x + Math.max(0, y ?? 0));
  return {
    added: sum(a.added, b.added),
    steps: sum(a.steps, b.steps),
    moved: sum(a.moved, b.moved),
    changed: sum(a.changed, b.changed),
  };
}

const items = (n: number) => (n === 1 ? '1 item' : `${n} items`);

/** The non-zero counters, one phrase each, in a fixed order: moved, added, steps, changed. */
export function changeParts(c: ConversationChanges): string[] {
  const parts: string[] = [];
  if (c.moved > 0) parts.push(`Moved ${items(c.moved)}`);
  if (c.added > 0) parts.push(`Added ${items(c.added)}`);
  if (c.steps > 0) parts.push(c.steps === 1 ? 'Added a step' : `Broke it into ${c.steps} steps`);
  if (c.changed > 0) parts.push(`Changed ${items(c.changed)}`);
  return parts;
}

/** `changeParts` joined with " · ". Null when nothing changed. */
export function changePhrase(c: ConversationChanges): string | null {
  const parts = changeParts(c);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The fields of a live item the second line reads. */
export interface SecondLineItem {
  assignee?: string | null;
  aiStatus?: string | null;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * History's second line for one conversation. The first rule that applies:
 *
 *   item conversation, item live, delegated and blocked   "With OpenClaw · waiting on you"
 *   …same, queued or working                               "With OpenClaw · working on it"
 *   item conversation, item live                           "Item conversation · moved 1 item · added a step" / "· no changes"
 *   item conversation, item gone                           "Item conversation · item deleted"
 *   general, with changes                                  "Moved 3 items · Added 1 item"
 *   general, none                                          "No changes"
 *
 * "OpenClaw" is whoever the item is delegated to, as the user reads it
 * (`assigneeLabel`: a stored 'beacon' reads "AI"). `item` is the planner's
 * live item, or null/undefined when it is gone.
 */
export function historySecondLine(
  summary: Pick<ConversationSummary, 'itemId' | 'changes'>,
  item: SecondLineItem | null | undefined
): string {
  const phrase = changePhrase(summary.changes);
  if (summary.itemId === null) return phrase ?? 'No changes';
  if (!item) return 'Item conversation · item deleted';
  if (item.assignee) {
    const who = assigneeLabel(item.assignee);
    if (item.aiStatus === 'blocked') return `With ${who} · waiting on you`;
    if (item.aiStatus === 'queued' || item.aiStatus === 'working') return `With ${who} · working on it`;
  }
  // Each phrase lowered, not just the first: after "Item conversation ·" the
  // whole line reads as one clause ("moved 1 item · added a step").
  const parts = changeParts(summary.changes);
  return `Item conversation · ${parts.length > 0 ? parts.map(lowerFirst).join(' · ') : 'no changes'}`;
}

// ── History's groups and times ───────────────────────────────────────────────

export type HistoryDay = 'today' | 'yesterday' | 'earlier';
export type HistoryGroupKey = 'starred' | HistoryDay;

export const HISTORY_GROUP_LABELS: Readonly<Record<HistoryGroupKey, string>> = Object.freeze({
  starred: 'Starred',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
});

/**
 * A formatter in the user's zone, falling back to the browser's when the zone
 * is unset or one Intl does not know (it throws a RangeError for those).
 */
function zoned(tz: string | null | undefined, o: Intl.DateTimeFormatOptions, locale = 'en-US'): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...o, timeZone: tz || undefined });
  } catch {
    return new Intl.DateTimeFormat(locale, o);
  }
}

/** The calendar day an instant falls on in `tz`, as yyyy-MM-dd. */
function dayIn(ms: number, tz: string | null | undefined): string {
  return zoned(tz, {}, 'en-CA').format(new Date(ms));
}

/** The day before a yyyy-MM-dd, by the calendar (no zone: it is already a date). */
function dayBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Which of History's day groups a conversation's last message falls in, in the user's zone. */
export function historyDay(lastMessageAt: string, now: number, tz: string | null | undefined): HistoryDay {
  const t = Date.parse(lastMessageAt);
  if (!Number.isFinite(t)) return 'earlier';
  const day = dayIn(t, tz);
  const today = dayIn(now, tz);
  if (day === today) return 'today';
  return day === dayBefore(today) ? 'yesterday' : 'earlier';
}

/**
 * A History row's time, in the user's zone:
 *   today      "8:02", or "08:02" under the 24-hour setting (a
 *              row's time is a glance, so no am/pm); the one chat clock,
 *              lib/format-chat-timestamp.ts clockTime
 *   yesterday  "Tue"
 *   earlier    "Sep 24", plus ", 2025" when it is not this year
 */
export function historyTime(lastMessageAt: string, now: number, tz: string | null | undefined, hour24: boolean): string {
  const t = Date.parse(lastMessageAt);
  if (!Number.isFinite(t)) return '';
  const at = new Date(t);
  const day = historyDay(lastMessageAt, now, tz);
  if (day === 'today') return clockTime(t, tz, hour24 ? '24h' : '12h');
  if (day === 'yesterday') return zoned(tz, { weekday: 'short' }).format(at);
  const date = zoned(tz, { month: 'short', day: 'numeric' }).format(at);
  const year = zoned(tz, { year: 'numeric' });
  return year.format(at) === year.format(new Date(now)) ? date : `${date}, ${year.format(at)}`;
}

export interface HistoryGroup {
  key: HistoryGroupKey;
  label: string;
  ids: string[];
}

/**
 * History's groups, in order: Starred (every starred conversation, and only
 * when there is one), then Today, Yesterday and Earlier by the last message,
 * in the user's zone. A starred conversation shows ONLY under Starred. Each
 * group keeps the list's own order (newest first), and an empty group is left
 * out. Ids with no summary are skipped: a row needs something to say.
 */
export function groupHistory(
  list: { ids: readonly string[]; starredIds: readonly string[] },
  summaries: Readonly<Record<string, Pick<ConversationSummary, 'starred' | 'lastMessageAt'> | undefined>>,
  now: number,
  tz: string | null | undefined
): HistoryGroup[] {
  const groups: Record<HistoryGroupKey, string[]> = { starred: [], today: [], yesterday: [], earlier: [] };
  const seen = new Set<string>();
  for (const id of list.starredIds) {
    if (seen.has(id) || !summaries[id]) continue;
    seen.add(id);
    groups.starred.push(id);
  }
  for (const id of list.ids) {
    const s = summaries[id];
    if (seen.has(id) || !s) continue;
    seen.add(id);
    // A row starred here a moment ago, before the list moved it.
    if (s.starred) groups.starred.push(id);
    else groups[historyDay(s.lastMessageAt, now, tz)].push(id);
  }
  return (['starred', 'today', 'yesterday', 'earlier'] as const)
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, label: HISTORY_GROUP_LABELS[key], ids: groups[key] }));
}
