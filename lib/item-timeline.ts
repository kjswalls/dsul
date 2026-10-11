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
 * kinds only an agent writes: its question, and its status.
 */

import { format, isSameDay, subDays } from 'date-fns';
import type { ItemEvent } from '@/lib/db';
import { assigneeLabel } from '@/lib/chat-utils';

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
  if (e.action === 'update' && e.payload && 'aiStatus' in e.payload && e.payload.aiStatus) return 'agent';
  return 'you';
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
  if ('priority' in p && keys.length === 1) return p.priority && p.priority !== 'none' ? `set the priority to ${String(p.priority)}` : 'cleared the priority';
  if (keys.length === 0) return 'changed it';
  const words = [...new Set(keys.map((k) => FIELD_WORDS[k]).filter(Boolean))];
  if (words.length === 0) return 'changed it';
  if (words.length === 1) return `changed ${words[0]}`;
  return `changed ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
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
  text: string;
}

export type TimelineEntry = TalkEntry | ChangeEntry;

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
 * The stream, oldest day first and oldest line first within a day. A day's
 * messages fold into one talk line, placed at the day's first message; the
 * conversation itself is read where it is drawn, under the details.
 */
export function buildTimeline(
  events: readonly ItemEvent[],
  messages: readonly TimelineMessage[],
  opts: { filter: TimelineFilter; now: Date }
): TimelineDay[] {
  const entries: TimelineEntry[] = [];
  if (opts.filter !== 'talk') {
    for (const e of events) {
      entries.push({ kind: 'change', key: e.id, at: new Date(e.createdAt).getTime(), by: actorOf(e), text: changeLine(e) });
    }
  }
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
        byDay.set(k, { kind: 'talk', key: `talk-${k}`, at: m.createdAt, with: withWhom, messages: 1 });
      }
    }
    entries.push(...byDay.values());
  }
  entries.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'talk' ? 1 : -1));

  const days: TimelineDay[] = [];
  for (const entry of entries) {
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
