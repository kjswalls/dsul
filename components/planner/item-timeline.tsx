'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { BandLabel } from '@/components/planner/item-bands';
import { itemThreadId } from '@/components/ai/item-conversation';
import { fetchItemEvents, getItemEventsAvailable, type ItemEvent } from '@/lib/db';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useConversationsStore, type ChatMessage } from '@/lib/conversations-store';
import { TimelineFileRow } from '@/components/planner/item-file-card';
import { useItemFiles, useItemFilesStore } from '@/lib/item-files-store';
import { useItemNotes, useItemNotesStore } from '@/lib/item-notes-store';
import { TimelineNoteRow } from '@/components/planner/item-notes';
import {
  ACTOR_LABEL,
  buildTimeline,
  fileEntries,
  foldRuns,
  noteEntries,
  runLine,
  talkLine,
  type ChangeEntry,
  type RunRow,
  type TimelineActor,
  type TimelineFilter,
} from '@/lib/item-timeline';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * An item's timeline (lib/item-timeline.ts): what changed on it and what was
 * said about it, oldest first, by day, each line with who did it. It took the
 * place of the Activity list and the panel footer's edit history.
 *
 * Where the item's conversation is on screen, the timeline is drawn INSIDE it,
 * as one stream (components/ai/item-conversation.tsx, `buildStream`), and this
 * section is not mounted. This is the timeline everywhere else: with no AI, the
 * changes alone; with AI and no conversation here, a day's talk as one line.
 * Either way, a day's changes in a row fold to the newest one's line and
 * "· N more" (`foldRuns`), opened in place. Files kept on the item are lines
 * too (`fileEntries`), never folded, and shown even where item_events is not.
 * Notes written on the timeline before round 3 (lib/item-notes.ts) are too.
 *
 * Quiet when there is nothing: no heading over an empty list.
 */

const NO_MESSAGES: ChatMessage[] = [];

/** Fetched again this long after the item last changed, so a save shows up without a reload. */
const REFETCH_MS = 800;

/**
 * Who did a line, as its mark: a small dot where the avatars were (the item
 * panel tidy, round 3), since the line itself names who in words. An agent's
 * dot is ink, so what it did stands out; everyone else's is the hairline grey.
 */
export function TimelineAvatar({ who }: { who: TimelineActor; agent?: string }) {
  return (
    <span className="grid size-5 shrink-0 place-items-center" aria-hidden data-who={who}>
      <span className={cn('size-1.5 rounded-full', who === 'agent' ? 'bg-foreground/70' : 'bg-border')} />
    </span>
  );
}

/**
 * The item's `item_events`, read at once and again a moment after the item
 * stops changing (an autosave lands, a tick, a drag), so the line for it
 * appears without a reload. Null until the first read lands.
 */
export function useItemEvents(item: Item, enabled = true): ItemEvent[] | null {
  const [events, setEvents] = useState<ItemEvent[] | null>(null);
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // A failed read keeps what is on screen: the timeline is never worth an error.
    const run = () =>
      fetchItemEvents(item.id).then(
        (rows) => {
          if (!cancelled) setEvents(rows);
        },
        () => {}
      );
    if (fetchedFor.current !== item.id) {
      fetchedFor.current = item.id;
      void run();
      return () => {
        cancelled = true;
      };
    }
    const t = setTimeout(run, REFETCH_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [item, enabled]);
  return events;
}

/** A day's heading in the stream. */
export function TimelineDayLine({ label }: { label: string }) {
  return (
    <p
      className="text-muted-foreground/80 font-mono text-[10px] tracking-wider uppercase"
      data-testid="item-timeline-daylabel"
    >
      {label}
    </p>
  );
}

/** One change: who, in full colour, then what, in grey, and the time. */
export function TimelineChangeLine({ entry, as: Tag = 'li' }: { entry: ChangeEntry; as?: 'li' | 'div' }) {
  return (
    <Tag className="flex items-center gap-2" data-testid="item-timeline-change" data-by={entry.by}>
      <TimelineAvatar who={entry.by} agent={entry.agent} />
      <span className="min-w-0 flex-1 truncate text-xs">
        <span className="text-foreground font-medium">
          {entry.by === 'agent' && entry.agent ? entry.agent : ACTOR_LABEL[entry.by]}
        </span>{' '}
        <span className="text-muted-foreground">{entry.text}</span>
      </span>
      <time className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">
        {new Date(entry.at).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </time>
    </Tag>
  );
}

/** A folded run, "You moved it to today · 2 more ›": opens the run where it is. */
export function TimelineRunLine({ run, onOpen }: { run: RunRow; onOpen: () => void }) {
  const who = run.newest.by === 'agent' && run.newest.agent ? run.newest.agent : ACTOR_LABEL[run.newest.by];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="item-timeline-run"
      data-hidden={run.hidden}
      aria-label={`${who} ${runLine(run)}. Show all`}
      className="hover:text-foreground group/run flex w-full min-w-0 items-center gap-2 rounded-sm text-left transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
    >
      <TimelineAvatar who={run.newest.by} />
      <span className="min-w-0 flex-1 truncate text-xs">
        <span className="text-foreground font-medium">{who}</span>{' '}
        <span className="text-muted-foreground group-hover/run:text-foreground">{runLine(run)}</span>
        <ChevronRight className="text-muted-foreground ml-0.5 inline size-3 align-[-2px]" aria-hidden />
      </span>
      <time className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">
        {new Date(run.at).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </time>
    </button>
  );
}

export function ItemTimeline({ item }: { item: Item }) {
  const events = useItemEvents(item);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const { canChat } = useAICapabilities();
  const threadId = useConversationsStore((s) => itemThreadId(s, item.id));
  const messages = useConversationsStore((s) => (threadId ? s.threads[threadId]?.messages : undefined) ?? NO_MESSAGES);

  const itemFiles = useItemFiles(item.id);
  const placedAt = useItemFilesStore((s) => s.placedAt);
  const loadThumbs = useItemFilesStore((s) => s.loadThumbs);
  const talk = canChat ? messages : NO_MESSAGES;
  const files = useMemo(
    () =>
      fileEntries(
        itemFiles ?? [],
        placedAt,
        talk.map((m) => m.createdAt)
      ),
    [itemFiles, placedAt, talk]
  );
  useEffect(() => {
    if (itemFiles?.length) void loadThumbs(item.id);
  }, [itemFiles, item.id, loadThumbs]);
  const notes = useItemNotes(item.id);
  const notePlacedAt = useItemNotesStore((s) => s.placedAt);
  const noteRows = useMemo(() => noteEntries(notes ?? [], notePlacedAt), [notes, notePlacedAt]);

  const effective: TimelineFilter = canChat ? 'all' : 'changes';
  const built = useMemo(
    () =>
      buildTimeline(
        events ?? [],
        talk.map((m) => ({
          role: m.role,
          createdAt: m.createdAt,
          answerer: m.answerer,
        })),
        { filter: effective, now: new Date(), files, notes: noteRows }
      ),
    [events, talk, effective, files, noteRows]
  );
  const days = useMemo(
    () => built.map((day) => ({ ...day, entries: foldRuns(day.entries, unfolded) })),
    [built, unfolded]
  );
  const anything = useMemo(
    () =>
      buildTimeline(
        events ?? [],
        talk.map((m) => ({
          role: m.role,
          createdAt: m.createdAt,
          answerer: m.answerer,
        })),
        { filter: 'all', now: new Date(), files, notes: noteRows }
      ).length > 0,
    [events, talk, files, noteRows]
  );

  const nothing =
    !anything || (!getItemEventsAvailable() && talk.length === 0 && files.length === 0 && noteRows.length === 0);
  if (nothing) return null;

  return (
    <section data-testid="item-timeline" aria-labelledby={`item-timeline-${item.id}`} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <BandLabel>
          <span id={`item-timeline-${item.id}`}>Timeline</span>
        </BandLabel>
      </div>
      {days.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="item-timeline-empty">
          No changes yet.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {days.map((day) => (
            <li key={day.key} className="flex flex-col gap-1.5" data-testid="item-timeline-day">
              <TimelineDayLine label={day.label} />
              <ol className="flex flex-col gap-1.5">
                {day.entries.map((entry) =>
                  entry.kind === 'talk' ? (
                    <li key={entry.key} className="flex items-center gap-2" data-testid="item-timeline-talk">
                      <TimelineAvatar who={entry.with} />
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{talkLine(entry)}</span>
                    </li>
                  ) : entry.kind === 'file' ? (
                    <li key={entry.key}>
                      <TimelineFileRow entry={entry} />
                    </li>
                  ) : entry.kind === 'note' ? (
                    <li key={entry.key}>
                      <TimelineNoteRow itemId={item.id} entry={entry} />
                    </li>
                  ) : entry.kind === 'run' ? (
                    <li key={entry.key}>
                      <TimelineRunLine run={entry} onOpen={() => setUnfolded((prev) => new Set(prev).add(entry.key))} />
                    </li>
                  ) : (
                    <TimelineChangeLine key={entry.key} entry={entry} />
                  )
                )}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
