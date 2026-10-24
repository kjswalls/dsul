'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReplyStatus, TranscriptMessages } from '@/components/ai/chat-transcript';
import { ItemConversationMenu } from '@/components/ai/ask/conversation-title-menu';
import {
  resolveConversationId,
  useConversationsStore,
  type ChatMessage,
  type ConversationsState,
} from '@/lib/conversations-store';
import { sendFrom } from '@/lib/open-chat';
import { bindingKey, noteDraftKey, useRailStore, type ComposerBinding } from '@/lib/rail-store';
import { itemChatPlaceholder } from '@/lib/chat-utils';
import { useConversationReceipts } from '@/lib/chat-receipts';
import { useAICapabilities } from '@/lib/ai-connection-store';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';
import { AgentExchangeView, AgentRouteLine } from '@/components/ai/agent-exchange';
import { useBoxAnswersAgent } from '@/lib/agent-question';
import { useAgentExchange } from '@/hooks/use-agent-exchange';
import { DELEGATE_ASSIGNEE } from '@/lib/agent-handoff';
import { usePlannerStore } from '@/lib/planner-store';
import { getItemEventsAvailable } from '@/lib/db';
import {
  buildStream,
  fileEntries,
  noteEntries,
  pinnedNote,
  type StreamRow,
  type TimelineFilter,
} from '@/lib/item-timeline';
import { useItemFiles, useItemFilesStore } from '@/lib/item-files-store';
import { saveNoteFrom, useItemNotes, useItemNotesStore } from '@/lib/item-notes-store';
import { NOTE_COPY, cleanNoteBody, noteLength, noteRefusal } from '@/lib/item-notes';
import { toast } from 'sonner';
import { TimelineFileRow } from '@/components/planner/item-file-card';
import { PinnedNote, TimelineNoteRow } from '@/components/planner/item-notes';
import { BoxModeSwitch, noteModeLine, switchBoxMode, useItemBoxMode } from '@/components/ai/box-mode-switch';
import {
  TimelineChangeLine,
  TimelineDayLine,
  TimelineFilterMenu,
  TimelineFoldLine,
  useItemEvents,
} from '@/components/planner/item-timeline';

/** One empty transcript, so a selector for an item nobody has chatted about is stable. */
const NO_MESSAGES: ChatMessage[] = [];

/**
 * The item's one conversation as the store holds it now: the saved one it is
 * indexed to, else the draft on its way to its first save, else one found gone
 * (deleted elsewhere), which stays on screen until the next send starts afresh.
 */
export function itemThreadId(s: ConversationsState, itemId: string): string | null {
  const known = s.itemIndex[itemId];
  if (typeof known === 'string') return resolveConversationId(known);
  let gone: string | null = null;
  for (const t of Object.values(s.threads)) {
    if (t.itemId !== itemId || t.saved) continue;
    if (t.load !== 'gone') return t.id;
    gone = t.id;
  }
  return gone;
}

/**
 * The rail body an item is laid out in (ItemDialog's `railChrome` body), the one
 * box this may scroll: never `scrollIntoView`, which would move every ancestor
 * too, <main> included.
 */
function railBodyOf(el: HTMLElement | null): HTMLElement | null {
  return el?.closest<HTMLElement>('[data-rail-body]') ?? null;
}

/**
 * An item's conversation: the one saved conversation per item
 * (lib/conversations-store.ts), the same on every device, kept until the user
 * deletes it. Sends go through `sendFrom({kind:'item'})`, which finds that
 * conversation (or starts it) whatever its id turns out to be.
 *
 * Three shapes, by where the item is shown:
 *   pinned      the desktop rail: the transcript at the foot of the item's
 *               body; its box is pinned at the bottom of the panel instead
 *               (ItemDialog's BoundComposer), so this renders the transcript
 *               only, and nothing until something has been said.
 *   transcript  the same, for a host whose box lives elsewhere.
 *   inline      the modal, the phone's drawer, Zen and /item/[id]: the
 *               transcript in its own capped list, with its own one-line box.
 *
 * Every shape returns null when nothing can answer: a conversation nobody can
 * answer in is a field that sends nowhere.
 *
 * ONE STREAM. Every shape draws the item's timeline in it: its changes
 * (`item_events`), compacted and folded, set between the messages by time
 * (lib/item-timeline.ts `buildStream`), under one "Timeline" heading with
 * All · Talk · Changes. Where this is on screen ItemDetailSections mounts no
 * timeline of its own, so a change is never listed twice. Files kept on the
 * item are in the stream too (`fileEntries`, drawn from item_files rows),
 * under every filter, never folded; a file sent with a message sits just
 * before it. Notes written on the item (lib/item-notes.ts) are in it too, under
 * every filter, never folded; the pinned one is a card under the heading.
 *
 * NOTE MODE. The inline box has an Ask / Note switch (`noteSwitch`, off only
 * on the Do stuff desk, whose Jot already writes the description): in Note
 * mode it reads and writes the item's note draft, and Save keeps the text on
 * the item (`saveNoteFrom`), never `sendFrom`.
 *
 * Every shape shows Ask's own messages (components/ai/chat-transcript.tsx:
 * your bubble, plain replies, Copy, the status lines; one transcript everywhere),
 * and once the conversation is saved its heading has a ⌄: Star, and Delete
 * conversation… (no Rename: its title is the item's). Deleted here or
 * elsewhere, the item stays, and its next send starts a fresh conversation;
 * one found deleted elsewhere stays on screen under a notice until then.
 *
 * OPENED FOR ITS CONVERSATION. An item opened from a History or activity row
 * carries a reveal request (rail-store `pendingReveal`); the pinned shape
 * consumes it and scrolls the rail body, and only the rail body, to this
 * section once it has something to show. Every other open lands at the item's
 * top, as it always has.
 */
export function ItemConversation({
  item,
  mode,
  className,
  tall = false,
  noteSwitch = true,
}: {
  item: Item;
  mode: 'pinned' | 'transcript' | 'inline';
  className?: string;
  /** Inline only: the stream may run most of the window's height (/item/[id]'s own column). */
  tall?: boolean;
  /** Inline only: the box draws the Ask / Note switch. The Do stuff desk says false. */
  noteSwitch?: boolean;
}) {
  const threadId = useConversationsStore((s) => itemThreadId(s, item.id));
  // The agent's side of the item (components/ai/agent-exchange.tsx), read
  // live: an agent's question or result moves the store, not this prop.
  const live = usePlannerStore((s) => s.items.find((i) => i.id === item.id)) ?? item;
  const exchange = useAgentExchange(live as Parameters<typeof useAgentExchange>[0]);
  const answeringAgent = useBoxAnswersAgent(item.id);
  const messages = useConversationsStore((s) => (threadId ? s.threads[threadId]?.messages : undefined) ?? NO_MESSAGES);
  const isTyping = useConversationsStore((s) => !!(threadId && s.threads[threadId]?.typing));
  const saved = useConversationsStore((s) => !!(threadId && s.summaries[threadId]));
  const gone = useConversationsStore((s) => !!(threadId && s.threads[threadId]?.load === 'gone'));
  const receiptList = useConversationReceipts(threadId);
  const receipts = useMemo(
    () => (threadId && receiptList.length ? { conversationId: threadId, list: receiptList } : undefined),
    [threadId, receiptList]
  );
  // Busy from the send's first instant (before the item's conversation is even
  // known) until the reply has finished arriving.
  const isLoading = useConversationsStore(
    (s) => !!s.sending[`item:${item.id}`] || !!(threadId && s.threads[threadId]?.streaming)
  );
  const { canChat, target } = useAICapabilities();
  // The inline box's text lives in rail-store under the item's binding key, as
  // every composer's does (bound-composer.tsx): one draft per item, whichever
  // surface shows it, so a half-typed message survives the view, and an ask
  // parked while the item was still answering (lib/open-chat.ts askAboutItem)
  // shows here as it does in the rail's box.
  const notesAvailable = useItemNotesStore((s) => s.available);
  const canNote = mode === 'inline' && noteSwitch && notesAvailable === true;
  const noting = useItemBoxMode(item.id, canNote) === 'note';
  const draftKey = noting ? noteDraftKey(item.id) : bindingKey({ kind: 'item', itemId: item.id });
  const draft = useRailStore((s) => s.drafts[draftKey] ?? '');
  const setDraft = (next: string) => useRailStore.getState().setDraft(draftKey, next);
  const listRef = useRef<HTMLDivElement>(null);
  const retryVia = useMemo<ComposerBinding>(() => ({ kind: 'item', itemId: item.id }), [item.id]);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevCount = useRef(0);
  const inline = mode === 'inline';
  const events = useItemEvents(item, canChat);
  const [filter, setFilter] = useState<TimelineFilter>('all');
  // Slots whose older changes were opened. Keyed by slot index, which a new
  // message never moves (it only appends a slot at the end).
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set());
  const itemFiles = useItemFiles(canChat ? item.id : null);
  const placedAt = useItemFilesStore((s) => s.placedAt);
  const loadThumbs = useItemFilesStore((s) => s.loadThumbs);
  const files = useMemo(
    () =>
      fileEntries(
        itemFiles ?? [],
        placedAt,
        messages.map((m) => m.createdAt)
      ),
    [itemFiles, placedAt, messages]
  );
  useEffect(() => {
    if (canChat && itemFiles?.length) void loadThumbs(item.id);
  }, [canChat, itemFiles, item.id, loadThumbs]);
  const notes = useItemNotes(canChat ? item.id : null);
  const notePlacedAt = useItemNotesStore((s) => s.placedAt);
  const pinned = useMemo(() => pinnedNote(notes ?? []), [notes]);
  const noteRows = useMemo(() => noteEntries(notes ?? [], notePlacedAt), [notes, notePlacedAt]);
  const slots = useMemo(
    () =>
      buildStream(getItemEventsAvailable() ? (events ?? []) : [], messages, {
        filter,
        now: new Date(),
        unfolded,
        files,
        notes: noteRows,
      }),
    [events, messages, filter, unfolded, files, noteRows]
  );
  const anyChange = slots.some((rows) => rows.some((r) => r.kind !== 'day'));
  const anyFile = files.length > 0;
  const anyNote = noteRows.length > 0;

  // Find the item's conversation and fetch its transcript, only while
  // something can answer (the conversation is not shown otherwise).
  useEffect(() => {
    if (!canChat) return;
    let live = true;
    const store = useConversationsStore.getState();
    void store.resolveItemThread(item.id).then((id) => {
      if (live) void useConversationsStore.getState().openThread(id);
    });
    return () => {
      live = false;
    };
  }, [canChat, item.id]);

  // A reveal asked for THIS item: taken once, then held until the transcript
  // is there to scroll to.
  const revealing = useRef(false);

  // Inline: scroll ONLY the list, and only on new messages, never on the
  // initial load (scrollIntoView would yank the panel, or the page, down to
  // it on open). Pinned: the same rule over the rail body, plus a send's own
  // first turn, which should be seen arriving; and a pending reveal.
  useLayoutEffect(() => {
    if (!inline && useRailStore.getState().consumeReveal(item.id)) revealing.current = true;
    const prev = prevCount.current;
    prevCount.current = messages.length;
    if (inline) {
      const el = listRef.current;
      if (!el || prev === 0 || messages.length <= prev) return;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const section = listRef.current;
    const body = railBodyOf(section);
    if (!section || !body) return;
    if (revealing.current) {
      revealing.current = false;
      body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top;
      return;
    }
    const sent = messages.at(-1)?.status === 'streaming';
    if (messages.length > prev && (prev > 0 || sent)) body.scrollTop = body.scrollHeight;
  }, [messages, isTyping, inline, item.id]);

  const handleSend = () => {
    const text = draft.trim();
    // A note is saved even while a reply is arriving, and never sent.
    if (noting) {
      const body = cleanNoteBody(draft);
      const why = noteRefusal(body);
      if (why) {
        if (why === 'too_long') toast.error(NOTE_COPY.refusal.too_long(noteLength(body)));
        return;
      }
      setDraft('');
      void saveNoteFrom(item.id, body);
      return;
    }
    if (!text || isLoading) return;
    setDraft('');
    void sendFrom({ kind: 'item', itemId: item.id }, text);
  };

  // After every hook. Every mount (the panel's stack, the rail, /item/[id]) is
  // gated by this.
  if (!canChat) return null;

  const agentSide = exchange && <AgentExchangeView item={live} exchange={exchange} />;
  const open = (slot: number) => setUnfolded((prev) => new Set(prev).add(slot));
  const rowsAt = (i: number) => <StreamRows itemId={item.id} rows={slots[i] ?? []} onOpen={open} />;
  const pinnedCard = pinned && <PinnedNote key={pinned.id} itemId={item.id} note={pinned} />;
  const heading = (menu: ReactNode) => (
    <div className="flex min-h-6 items-center justify-between gap-2">
      {(anyChange || messages.length > 0) && <TimelineFilterMenu value={filter} onChange={setFilter} />}
      <div className="ml-auto flex items-center gap-1">{menu}</div>
    </div>
  );
  // Changes alone: one slot and no transcript. Otherwise the transcript, with
  // the changes drawn between its messages.
  // Talk with no messages still draws its file rows.
  const empty =
    filter === 'talk' && messages.length === 0 && !anyFile && !anyNote
      ? 'No conversation about this yet.'
      : filter === 'changes' && !anyChange
        ? 'No changes yet.'
        : null;
  const stream = empty ? (
    <p className="text-muted-foreground text-xs" data-testid="item-timeline-empty">
      {empty}
    </p>
  ) : filter === 'changes' ? (
    rowsAt(0)
  ) : (
    <TranscriptMessages
      messages={messages}
      busy={isLoading}
      retryVia={retryVia}
      receipts={receipts}
      before={rowsAt}
      pictureNote="sent"
    />
  );

  if (!inline) {
    if (messages.length === 0 && !exchange && !anyChange && !pinned) return null;
    return (
      <div ref={listRef} data-testid="item-conversation" className={cn('flex flex-col gap-3', className)}>
        {heading(saved && threadId && <ItemConversationMenu id={threadId} />)}
        {pinnedCard}
        {gone && <GoneNotice />}
        {agentSide}
        {stream}
        <ReplyStatus messages={messages} />
      </div>
    );
  }

  const placeholder = noting
    ? 'Add a note…'
    : answeringAgent
      ? `Answer ${answeringAgent}…`
      : itemChatPlaceholder(target);

  return (
    <div className={cn('flex min-h-0 flex-col gap-1.5', className)} data-testid="item-thread">
      {/* A delete takes this ⌄ with it, and the box below stays: focus goes there. */}
      {heading(
        saved && threadId && <ItemConversationMenu id={threadId} fallbackFocus={() => inputRef.current?.focus()} />
      )}
      {pinnedCard}
      {gone && <GoneNotice />}
      {(messages.length > 0 || exchange || anyChange || pinned) && (
        <div
          ref={listRef}
          className={cn(
            'flex min-h-0 flex-col gap-3 overflow-y-auto pr-1',
            tall ? 'max-h-[min(40rem,70vh)]' : 'max-h-64'
          )}
        >
          {agentSide}
          {stream}
        </div>
      )}
      <ReplyStatus messages={messages} />
      <div className="field flex items-center gap-1.5 border px-2 py-1">
        {canNote && (
          <BoxModeSwitch
            size="sm"
            value={noting ? 'note' : 'ask'}
            onChange={(m) => {
              switchBoxMode(item.id, m);
              inputRef.current?.focus();
            }}
          />
        )}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label={noting ? 'Note on this item' : undefined}
          data-sub-input
          data-testid="item-thread-input"
          className="placeholder:text-muted-foreground -mx-1 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            handleSend();
          }}
        />
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          disabled={!draft.trim() || (!noting && isLoading)}
          onClick={handleSend}
          aria-label={noting ? 'Save note' : 'Send'}
        >
          <ArrowUp className="size-3.5" />
        </Button>
      </div>
      {noting ? (
        <p className="text-muted-foreground text-2xs" data-testid="note-mode-line">
          {noteModeLine(target === 'openclaw' || (live as { assignee?: string }).assignee === DELEGATE_ASSIGNEE)}
        </p>
      ) : (
        <AgentRouteLine itemId={item.id} />
      )}
    </div>
  );
}

/** A slot of the stream: day lines, changes, files, notes and a fold, drawn between two messages. */
function StreamRows({
  itemId,
  rows,
  onOpen,
}: {
  itemId: string;
  rows: readonly StreamRow[];
  onOpen: (slot: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="item-timeline-slot">
      {rows.map((r) =>
        r.kind === 'day' ? (
          <TimelineDayLine key={r.key} label={r.label} />
        ) : r.kind === 'fold' ? (
          <TimelineFoldLine key={r.key} hidden={r.hidden} onOpen={() => onOpen(r.slot)} />
        ) : r.kind === 'file' ? (
          <TimelineFileRow key={r.key} entry={r} />
        ) : r.kind === 'note' ? (
          <TimelineNoteRow key={r.key} itemId={itemId} entry={r} />
        ) : (
          <TimelineChangeLine key={r.key} entry={r} as="div" />
        )
      )}
    </div>
  );
}

/** The item's conversation was deleted on another device, or in another tab or window. */
function GoneNotice() {
  return (
    <p role="status" data-testid="conversation-gone" className="text-xs text-muted-foreground">
      This conversation was deleted.
    </p>
  );
}
