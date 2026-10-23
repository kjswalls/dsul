/**
 * An item's timeline: what was said about it and what changed on it, in one
 * stream, oldest first, grouped by day, each line saying who did it
 * (components/planner/item-timeline.tsx). Pure: it reads the item's
 * `item_events` (lib/db.ts, migration 023, kept 180 days) and its
 * conversation's messages, and is handed "now" and a time zone.
 *
 * WHO. A change knows who made it from its payload's `by` key, written since
 * 2026-10-11 (lib/db.ts `recordItemEvent`): 'you', 'ai' (a card you accepted),
 * 'agent' (OpenClaw or another agent through the agent API or MCP) or 'recipe'
 * (your own automation). Older rows have none and read as you, except the two
 * kinds only an agent writes: its question, and its status. A hand-off (any
 * change of assignee) and a re-queue are yours even though they carry a status:
 * your own "Hand off to Claude" writes `{assignee, aiStatus: 'queued'}` with no
 * `by`, and read as the agent assigning itself.
 *
 * WHICH agent. An item can be handed to OpenClaw, then to Claude, so "agent"
 * is named by whoever held the item when the line was written, read off the
 * trail's own assignee changes (`ChangeEntry.agent`).
 *
 * FILES. A file kept on the item (lib/item-files.ts) is a line too, drawn
 * from its `item_files` row, never from an event: who added it is the row's
 * `added_by` (migration 081), and a deleted file's line goes with its row.
 * Files are never folded, never merged with changes and never counted as
 * hidden, and every filter shows them.
 */

import { format, isSameDay, subDays } from 'date-fns';
import type { ItemEvent } from '@/lib/db';
import { assigneeLabel } from '@/lib/chat-utils';
import { UNNAMED_AGENT, type ItemFile } from '@/lib/item-files';

export type TimelineActor = 'you' | 'ai' | 'agent' | 'recipe';

export const ACTOR_LABEL: Record<TimelineActor, string> = {
  you: 'You',
  ai: 'AI',
  agent: 'OpenClaw',
  recipe: 'A recipe',
};

/** The payload key a change's author rides in. Never shown as a changed field. */
export const ACTOR_KEY = 'by';

const ACTORS: readonly TimelineActor[] = ['you', 'ai', 'agent', 'recipe'];

export function actorOf(e: Pick<ItemEvent, 'action' | 'payload'>): TimelineActor {
  const by = e.payload?.[ACTOR_KEY];
  if (typeof by === 'string' && (ACTORS as readonly string[]).includes(by)) return by as TimelineActor;
  if (e.action === 'agent_question') return 'agent';
  if (e.action !== 'update' || !e.payload) return 'you';
  if ('assignee' in e.payload) return 'you';
  if (e.payload.aiStatus && e.payload.aiStatus !== 'queued') return 'agent';
  return 'you';
}

/** The name an agent goes by on the timeline: OpenClaw, or the connected app it was handed to. */
export function agentName(assignee: unknown): string {
  const a = typeof assignee === 'string' ? assignee.trim() : '';
  if (!a || a.toLowerCase() === 'openclaw') return ACTOR_LABEL.agent;
  return assigneeLabel(a);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** "Tue, Oct 14" from a yyyy-MM-dd, read as a calendar day (no zone can move it). */
function dayWords(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return format(new Date(y, m - 1, d), 'EEE, MMM d');
}

const quote = (s: string, max = 60) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;

/** Field names in words, for an update this file has no sentence for. */
const FIELD_WORDS: Record<string, string> = {
  title: 'the title',
  notes: 'the notes',
  startDate: 'the day',
  startTime: 'the time',
  timeBucket: 'the time of day',
  duration: 'how long it takes',
  priority: 'the priority',
  project: 'the project',
  repeatFrequency: 'how it repeats',
  repeatDays: 'how it repeats',
  repeatMonthDay: 'how it repeats',
  reminder: 'the reminder',
  reminderTime: 'the reminder',
  size: 'the size',
  parentItemId: 'where it sits',
};

/** What a change did, as the rest of a sentence after who did it ("moved it to Tue, Oct 14"). */
export function changeLine(e: Pick<ItemEvent, 'action' | 'payload'>): string {
  const p = e.payload ?? {};
  switch (e.action) {
    case 'create':
      return 'added it';
    case 'delete':
      return 'deleted it';
    case 'checkin': {
      const note = str(p.note);
      return note ? `checked in: ${quote(note, 120)}` : 'checked in';
    }
    case 'agent_question': {
      const q = str(p.question);
      return q ? `asked: ${quote(q, 120)}` : 'asked a question';
    }
    case 'agent_reply': {
      const t = str(p.text);
      return t ? `answered: ${quote(t, 120)}` : 'answered';
    }
  }
  const keys = Object.keys(p).filter((k) => k !== ACTOR_KEY && k !== 'projectId' && k !== 'groupId');
  if ('assignee' in p) {
    if (!p.assignee) return 'took it back';
    return p.assignee === 'openclaw' ? 'handed it to OpenClaw' : `assigned it to ${assigneeLabel(String(p.assignee))}`;
  }
  if (p.aiStatus) return `marked it ${String(p.aiStatus)}`;
  if ('status' in p) {
    if (p.status === 'completed' || p.status === 'done') return 'marked it done';
    if (p.status === 'cancelled' || p.status === 'skipped') return 'let it go';
    return 'opened it again';
  }
  if ('pausedAt' in p) return p.pausedAt ? 'paused it' : 'resumed it';
  if ('type' in p && keys.length === 1) return 'changed what kind of item it is';
  if ('startDate' in p && keys.every((k) => ['startDate', 'isScheduled', 'timeBucket', 'startTime'].includes(k))) {
    const day = str(p.startDate);
    return day ? `moved it to ${dayWords(day)}` : 'moved it to the braindump';
  }
  if ('title' in p && keys.length === 1) {
    const t = str(p.title);
    return t ? `renamed it ${quote(t)}` : 'renamed it';
  }
  if ('project' in p && keys.length === 1) {
    const name = str(p.project);
    return name ? `filed it under ${name}` : 'took it out of its project';
  }
  if ('notes' in p && keys.length === 1) return 'edited the notes';
  if ('duration' in p && keys.length === 1) return 'changed how long it takes';
  if ('priority' in p && keys.length === 1)
    return p.priority && p.priority !== 'none' ? `set the priority to ${String(p.priority)}` : 'cleared the priority';
  if (keys.length === 0) return 'changed it';
  const words = [...new Set(keys.map((k) => FIELD_WORDS[k]).filter(Boolean))];
  if (words.length === 0) return 'changed it';
  if (words.length === 1) return `changed ${words[0]}`;
  return `changed ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * What a change is about, so a burst of the same kind can merge
 * (`compactChanges`): "when" for a move, "status" for done and opened again,
 * the field names otherwise. Null for a line that stands on its own whatever
 * comes next (added, deleted, a check-in, a question or its answer).
 */
export function changeTopic(e: Pick<ItemEvent, 'action' | 'payload'>): string | null {
  if (e.action !== 'update') return null;
  const p = e.payload ?? {};
  if ('assignee' in p) return 'assignee';
  if (p.aiStatus) return 'aiStatus';
  if ('status' in p) return 'status';
  if ('pausedAt' in p) return 'pause';
  const keys = Object.keys(p).filter((k) => k !== ACTOR_KEY && k !== 'projectId' && k !== 'groupId');
  if (keys.length > 0 && keys.every((k) => ['startDate', 'isScheduled', 'timeBucket', 'startTime'].includes(k)))
    return 'when';
  return keys.sort().join(',');
}

/** Same person, same kind of change, no further apart than this: one line, the last. */
export const BURST_MS = 15 * 60 * 1000;

/** A run of more changes in a row than this folds, */
export const FOLD_OVER = 4;
/** showing only the newest this many under a "Show N earlier changes" line. */
export const FOLD_KEEP = 3;

/** The words of a change that says nothing ("You changed it"), never shown. */
const SAYS_NOTHING = 'changed it';

/**
 * A long history read the way it was meant, not keystroke by keystroke:
 * a line that says nothing goes, and a burst (the same person making the same
 * kind of change, each within BURST_MS of the last, with nothing said in
 * between) is one line, the last, so four moves back and forth in a minute
 * read as where the item ended up. Order is kept; talk lines are untouched
 * and break a burst.
 */
export function compactChanges<T extends TimelineEntry>(entries: readonly T[]): T[] {
  const out: T[] = [];
  for (const entry of entries) {
    if (entry.kind === 'change' && entry.text === SAYS_NOTHING) continue;
    const prev = out[out.length - 1];
    if (
      entry.kind === 'change' &&
      prev?.kind === 'change' &&
      entry.topic !== null &&
      prev.topic === entry.topic &&
      prev.by === entry.by &&
      prev.agent === entry.agent &&
      entry.at - prev.at <= BURST_MS
    ) {
      out[out.length - 1] = entry;
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Every change on the item as a line, oldest first, each knowing who held the item when it was written. */
function changeEntries(events: readonly ItemEvent[]): ChangeEntry[] {
  const oldestFirst = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let holder: unknown = null;
  const out: ChangeEntry[] = [];
  for (const e of oldestFirst) {
    if (e.payload && 'assignee' in e.payload) holder = e.payload.assignee;
    const by = actorOf(e);
    out.push({
      kind: 'change',
      key: e.id,
      at: new Date(e.createdAt).getTime(),
      by,
      ...(by === 'agent' ? { agent: agentName(holder) } : {}),
      text: changeLine(e),
      topic: changeTopic(e),
    });
  }
  return out;
}

/** One talk line: a day's conversation folded to who talked and how much. */
export interface TalkEntry {
  kind: 'talk';
  key: string;
  at: number;
  /** Who answered: the connected model or OpenClaw. */
  with: 'ai' | 'agent';
  messages: number;
}

export interface ChangeEntry {
  kind: 'change';
  key: string;
  at: number;
  by: TimelineActor;
  /** Who "agent" was when this line was written (`agentName`); set only when `by` is 'agent'. */
  agent?: string;
  text: string;
  /** What the change is about (`changeTopic`), for merging a burst; null never merges. */
  topic: string | null;
}

/** Files added together: by one person, each within FILE_BURST_MS of the last. */
export interface FileEntry {
  kind: 'file';
  key: string;
  at: number;
  by: TimelineActor;
  /** The agent's name (`fileAgentName`); set only when `by` is 'agent'. */
  agent?: string;
  text: string;
  files: ItemFile[];
}

export type TimelineEntry = TalkEntry | ChangeEntry | FileEntry;

/** Files added this close together by the same person are one line. */
export const FILE_BURST_MS = 2 * 60_000;

/** The name a file's `added_by` goes by: "An agent" for one with no name, else as `agentName`. */
export function fileAgentName(addedBy: string): string {
  if (addedBy === UNNAMED_AGENT || !addedBy.trim()) return 'An agent';
  return agentName(addedBy);
}

/**
 * An item's files as timeline lines, oldest first. A file sits at the time it
 * was placed on this page (`placedAt`, the send it went with), else its row's
 * `created_at`. A message (`messageTimes`) in between ends a burst, so a group
 * never spans two of buildStream's slots: a message at m falls between files at
 * x < y when x <= m < y, the same strict `<` buildStream places by.
 */
export function fileEntries(
  files: readonly ItemFile[],
  placedAt?: Readonly<Record<string, number>>,
  messageTimes: readonly number[] = []
): FileEntry[] {
  const breaks = messageTimes.filter((m) => m);
  const timed = files
    .map((f) => ({ f, at: placedAt?.[f.id] ?? Date.parse(f.createdAt) }))
    .filter((t) => Number.isFinite(t.at))
    .sort((a, b) => a.at - b.at);
  const out: FileEntry[] = [];
  let lastAt = 0;
  for (const { f, at } of timed) {
    const prev = out[out.length - 1];
    if (
      prev &&
      (prev.files[0].addedBy ?? null) === (f.addedBy ?? null) &&
      at - lastAt <= FILE_BURST_MS &&
      !breaks.some((m) => lastAt <= m && m < at)
    ) {
      prev.files.push(f);
      prev.text = `attached ${prev.files.length} files`;
    } else {
      out.push({
        kind: 'file',
        key: `file-${f.id}`,
        at,
        by: f.addedBy ? 'agent' : 'you',
        ...(f.addedBy ? { agent: fileAgentName(f.addedBy) } : {}),
        text: `attached ${f.name}`,
        files: [f],
      });
    }
    lastAt = at;
  }
  return out;
}

export interface TimelineDay {
  key: string;
  label: string;
  entries: TimelineEntry[];
}

export type TimelineFilter = 'all' | 'talk' | 'changes';

/** The messages the timeline needs, nothing it does not. */
export interface TimelineMessage {
  role: 'user' | 'assistant';
  createdAt: number;
  answerer: 'model' | 'openclaw' | null;
}

function dayLabel(at: Date, now: Date): string {
  if (isSameDay(at, now)) return 'Today';
  if (isSameDay(at, subDays(now, 1))) return 'Yesterday';
  return format(at, at.getFullYear() === now.getFullYear() ? 'EEE, MMM d' : 'EEE, MMM d, yyyy');
}

const dayKey = (at: Date) => format(at, 'yyyy-MM-dd');

/**
 * The stream, oldest day first and oldest line first within a day, compacted
 * (`compactChanges`). A day's messages fold into one talk line, placed at the
 * day's first message: this is the timeline a host draws where the
 * conversation itself is not on screen (`buildStream` is the one with it).
 */
export function buildTimeline(
  events: readonly ItemEvent[],
  messages: readonly TimelineMessage[],
  opts: { filter: TimelineFilter; now: Date; files?: readonly FileEntry[] }
): TimelineDay[] {
  const entries: TimelineEntry[] = [];
  if (opts.filter !== 'talk') entries.push(...changeEntries(events));
  // Every filter shows files.
  if (opts.files) entries.push(...opts.files);
  if (opts.filter !== 'changes') {
    const byDay = new Map<string, TalkEntry>();
    for (const m of messages) {
      if (!m.createdAt) continue;
      const k = dayKey(new Date(m.createdAt));
      const talk = byDay.get(k);
      const withWhom = m.answerer === 'openclaw' ? 'agent' : 'ai';
      if (talk) {
        talk.messages += 1;
        talk.at = Math.min(talk.at, m.createdAt);
        if (m.role === 'assistant' && withWhom === 'agent') talk.with = 'agent';
      } else {
        byDay.set(k, {
          kind: 'talk',
          key: `talk-${k}`,
          at: m.createdAt,
          with: withWhom,
          messages: 1,
        });
      }
    }
    entries.push(...byDay.values());
  }
  entries.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'talk' ? 1 : -1));

  const days: TimelineDay[] = [];
  for (const entry of compactChanges(entries)) {
    const at = new Date(entry.at);
    const key = dayKey(at);
    const last = days[days.length - 1];
    if (last?.key === key) last.entries.push(entry);
    else days.push({ key, label: dayLabel(at, opts.now), entries: [entry] });
  }
  return days;
}

/** "You and the AI talked it through · 4 messages". */
export function talkLine(t: TalkEntry): string {
  const who = t.with === 'agent' ? 'You and OpenClaw' : 'You and the AI';
  return `${who} talked it through · ${t.messages} ${t.messages === 1 ? 'message' : 'messages'}`;
}

/**
 * The newest `keep` lines of a timeline, and how many older ones that leaves
 * out, once it has more than FOLD_OVER; the whole of it, and 0, otherwise.
 * File lines are never folded and never counted: they stay where they are.
 */
export function foldTimeline(days: readonly TimelineDay[], keep = FOLD_KEEP): { days: TimelineDay[]; hidden: number } {
  const total = days.reduce((n, d) => n + d.entries.filter((e) => e.kind !== 'file').length, 0);
  if (total <= FOLD_OVER) return { days: [...days], hidden: 0 };
  let skip = total - keep;
  const out: TimelineDay[] = [];
  for (const day of days) {
    const entries = day.entries.filter((e) => {
      if (e.kind === 'file' || skip === 0) return true;
      skip--;
      return false;
    });
    if (entries.length) out.push({ ...day, entries });
  }
  return { days: out, hidden: total - keep };
}

/** A line of the stream drawn between messages: a day, a change, a file, or a fold over older changes. */
export type StreamRow =
  | { kind: 'day'; key: string; label: string }
  | ChangeEntry
  | FileEntry
  | { kind: 'fold'; key: string; slot: number; hidden: number };

/**
 * The item's timeline and its conversation as ONE stream (the item
 * conversations design, approved 2026-10-01): the changes, compacted, set
 * between the messages by time. Returns one slot per gap, `messages.length + 1`
 * of them: slot i is drawn just before message i, the last after every message.
 *
 * A slot holding more than FOLD_OVER changes shows its newest FOLD_KEEP under a
 * fold line, unless its index is in `unfolded`. Messages never fold. A day line
 * opens each new day, whether a change or a message starts it.
 *
 * Talk shows the messages alone (the slots hold only days and files); Changes
 * the changes alone, as one slot (the caller draws no messages).
 *
 * Files (`opts.files`) are set by time in their own list per slot, and drawn
 * merged with the slot's kept changes by time. They never fold, never merge
 * with a change, never count in a fold, and every filter shows them. A file
 * sits BEFORE a message stamped the same instant (strict `<`): a file sent
 * with a message is placed at a time taken just before the message's own.
 */
export function buildStream(
  events: readonly ItemEvent[],
  messages: readonly { createdAt: number }[],
  opts: { filter: TimelineFilter; now: Date; unfolded?: ReadonlySet<number>; files?: readonly FileEntry[] }
): StreamRow[][] {
  const msgs = opts.filter === 'changes' ? [] : messages;
  const changes = opts.filter === 'talk' ? [] : changeEntries(events);
  const bySlot: ChangeEntry[][] = Array.from({ length: msgs.length + 1 }, () => []);
  const filesBySlot: FileEntry[][] = Array.from({ length: msgs.length + 1 }, () => []);
  let slot = 0;
  for (const c of changes) {
    while (slot < msgs.length && msgs[slot].createdAt && msgs[slot].createdAt <= c.at) slot++;
    bySlot[slot].push(c);
  }
  slot = 0;
  for (const f of [...(opts.files ?? [])].sort((a, b) => a.at - b.at)) {
    while (slot < msgs.length && msgs[slot].createdAt && msgs[slot].createdAt < f.at) slot++;
    filesBySlot[slot].push(f);
  }
  // Compacted per slot, after placing: a message in between ends a burst.
  const slots: StreamRow[][] = [];
  let lastDay: string | null = null;
  const dayRow = (at: number, where: string): StreamRow[] => {
    const k = dayKey(new Date(at));
    if (k === lastDay) return [];
    lastDay = k;
    return [
      {
        kind: 'day',
        key: `day-${where}-${k}`,
        label: dayLabel(new Date(at), opts.now),
      },
    ];
  };
  for (let i = 0; i < bySlot.length; i++) {
    const rows: StreamRow[] = [];
    let list = compactChanges(bySlot[i]);
    if (list.length > FOLD_OVER && !opts.unfolded?.has(i)) {
      rows.push({
        kind: 'fold',
        key: `fold-${i}`,
        slot: i,
        hidden: list.length - FOLD_KEEP,
      });
      list = list.slice(-FOLD_KEEP);
    }
    const merged: (ChangeEntry | FileEntry)[] = [...list, ...filesBySlot[i]].sort((a, b) => a.at - b.at);
    for (const c of merged) rows.push(...dayRow(c.at, c.key), c);
    const next = msgs[i];
    if (next?.createdAt) rows.push(...dayRow(next.createdAt, `m${i}`));
    slots.push(rows);
  }
  return slots;
}

/** "Show 9 earlier changes". */
export function foldLine(hidden: number): string {
  return `Show ${hidden} earlier ${hidden === 1 ? 'change' : 'changes'}`;
}
