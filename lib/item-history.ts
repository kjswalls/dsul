import type { ItemEvent } from '@/lib/db';
import { ACTOR_LABEL, buildTimeline, type ChangeEntry, type TimelineActor } from '@/lib/item-timeline';

/**
 * An item's History, the popover under the panel's ⋯ (the item panel beta
 * round, Kirby's pick H6, 2026-11-06). The panel itself no longer draws the
 * timeline: what changed on an item is one click away, never between its
 * chat messages.
 *
 * Two readings of the same compacted change lines (lib/item-timeline.ts):
 * "what happened", the lines worth knowing about (added, done, skipped,
 * paused, moved, handed off, and anything an agent, the AI or a recipe did),
 * and every line, your own small edits included (renames, notes, priority,
 * duration and the like). The popover shows the first and offers the second.
 */

/** What a history row's tile draws. */
export type HistoryIcon =
  | 'added'
  | 'deleted'
  | 'done'
  | 'reopened'
  | 'let-go'
  | 'paused'
  | 'resumed'
  | 'moved'
  | 'braindump'
  | 'handed'
  | 'agent'
  | 'said'
  | 'edit';

export interface HistoryRow {
  key: string;
  at: number;
  icon: HistoryIcon;
  /** The sentence, capitalised and without its "it": "Moved to Tue, Nov 3". */
  text: string;
  /** Who did it, named only when it was not you: "AI", "OpenClaw", "A recipe". */
  by: string | null;
  actor: TimelineActor;
  /** False for your own small edits, which wait behind "Show all edits". */
  happened: boolean;
}

export interface HistoryDay {
  key: string;
  label: string;
  rows: HistoryRow[];
}

/** The change topics (lib/item-timeline.ts changeTopic) that are an event, not a field edit. */
const EVENT_TOPICS = new Set(['assignee', 'aiStatus', 'status', 'pause', 'when']);

/** "moved it to Tue" → "Moved to Tue"; "let it go" → "Let go"; the rest just capitalised. */
export function historyText(line: string): string {
  const s = line.replace(/^(\w+) it\b ?/, '$1 ').trimEnd();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function iconFor(entry: ChangeEntry): HistoryIcon {
  const t = entry.text;
  if (t === 'added it') return 'added';
  if (t === 'deleted it') return 'deleted';
  if (t === 'marked it done') return 'done';
  if (t === 'opened it again') return 'reopened';
  if (t === 'let it go') return 'let-go';
  if (t === 'paused it') return 'paused';
  if (t === 'resumed it') return 'resumed';
  if (t === 'moved it to the braindump') return 'braindump';
  if (t.startsWith('moved it to')) return 'moved';
  if (t === 'took it back' || t.startsWith('handed it to') || t.startsWith('assigned it to')) return 'handed';
  if (t.startsWith('marked it ')) return 'agent';
  if (t.startsWith('checked in') || t.startsWith('asked') || t.startsWith('answered')) return 'said';
  return 'edit';
}

/** The history, newest day first and newest row first within a day. */
export function buildHistory(events: readonly ItemEvent[], now: Date): HistoryDay[] {
  const days = buildTimeline(events, [], { filter: 'changes', now });
  const out: HistoryDay[] = [];
  for (const day of days) {
    const rows: HistoryRow[] = [];
    for (const entry of day.entries) {
      if (entry.kind !== 'change') continue;
      const by = entry.by === 'you' ? null : entry.by === 'agent' && entry.agent ? entry.agent : ACTOR_LABEL[entry.by];
      rows.push({
        key: entry.key,
        at: entry.at,
        icon: iconFor(entry),
        text: historyText(entry.text),
        by,
        actor: entry.by,
        happened: entry.by !== 'you' || entry.topic === null || EVENT_TOPICS.has(entry.topic),
      });
    }
    if (rows.length) out.push({ key: day.key, label: day.label, rows: rows.reverse() });
  }
  return out.reverse();
}

/** The same days with only what happened, empty days dropped. */
export function happenedOnly(days: readonly HistoryDay[]): HistoryDay[] {
  return days
    .map((d) => ({ ...d, rows: d.rows.filter((r) => r.happened) }))
    .filter((d) => d.rows.length > 0);
}

/** How many of your own edits "what happened" leaves out. */
export function editCount(days: readonly HistoryDay[]): number {
  return days.reduce((n, d) => n + d.rows.filter((r) => !r.happened).length, 0);
}
