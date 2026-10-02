'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BandLabel } from '@/components/planner/item-bands';
import {
  resolveConversationId,
  useConversationsStore,
  type ChatMessage,
  type ConversationsState,
} from '@/lib/conversations-store';
import { sendFrom } from '@/lib/open-chat';
import { useRailStore } from '@/lib/rail-store';
import { chatErrorCopy } from '@/lib/chat-errors';
import { itemChatPlaceholder } from '@/lib/chat-utils';
import { useAICapabilities } from '@/lib/ai-connection-store';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/** One empty transcript, so a selector for an item nobody has chatted about is stable. */
const NO_MESSAGES: ChatMessage[] = [];

/**
 * The item's one conversation as the store holds it now: the saved one it is
 * indexed to, else the draft on its way to its first save, else one found gone
 * (deleted elsewhere), which stays on screen until the next send starts afresh.
 */
function itemThreadId(s: ConversationsState, itemId: string): string | null {
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
}: {
  item: Item;
  mode: 'pinned' | 'transcript' | 'inline';
  className?: string;
}) {
  const threadId = useConversationsStore((s) => itemThreadId(s, item.id));
  const messages = useConversationsStore((s) => (threadId ? s.threads[threadId]?.messages : undefined) ?? NO_MESSAGES);
  const isTyping = useConversationsStore((s) => !!(threadId && s.threads[threadId]?.typing));
  // Busy from the send's first instant (before the item's conversation is even
  // known) until the reply has finished arriving.
  const isLoading = useConversationsStore(
    (s) => !!s.sending[`item:${item.id}`] || !!(threadId && s.threads[threadId]?.streaming)
  );
  const { canChat, target } = useAICapabilities();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  const inline = mode === 'inline';

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
    if (!text || isLoading) return;
    setDraft('');
    void sendFrom({ kind: 'item', itemId: item.id }, text);
  };

  // After every hook. Every mount (the panel's stack, the rail, /item/[id]) is
  // gated by this.
  if (!canChat) return null;

  if (!inline) {
    if (messages.length === 0) return null;
    return (
      <div ref={listRef} data-testid="item-conversation" className={cn('flex flex-col gap-2', className)}>
        <BandLabel>Conversation</BandLabel>
        {messages.map((m, i) => (
          <MessageRow key={m.id} m={m} next={messages[i + 1]} rail />
        ))}
      </div>
    );
  }

  const placeholder = itemChatPlaceholder(target);

  return (
    <div className={cn('flex min-h-0 flex-col gap-1.5', className)} data-testid="item-thread">
      <BandLabel>Thread</BandLabel>
      {messages.length > 0 && (
        <div ref={listRef} className="flex max-h-64 min-h-0 flex-col gap-2 overflow-y-auto pr-1">
          {messages.map((m, i) => (
            <MessageRow key={m.id} m={m} next={messages[i + 1]} />
          ))}
        </div>
      )}
      <div className="border-input flex items-center gap-1.5 rounded-md border px-2 py-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          data-sub-input
          data-testid="item-thread-input"
          className="placeholder:text-muted-foreground -mx-1 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            handleSend();
          }}
        />
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          disabled={!draft.trim() || isLoading}
          onClick={handleSend}
          aria-label="Send"
        >
          <ArrowUp className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * One message. In the rail, yours is a soft bubble and a reply is plain text
 * with no bubble at all; inline keeps the compact tinted pair it always had.
 * "Not saved" shows once per turn: under its reply, or under the question when
 * no reply came.
 */
function MessageRow({ m, next, rail = false }: { m: ChatMessage; next: ChatMessage | undefined; rail?: boolean }) {
  const notSaved = m.sync === 'unsaved' && !(next?.sync === 'unsaved' && next.replyTo === m.id);
  const mine = m.role === 'user';
  return (
    <div
      className={cn(
        'flex flex-col gap-0.5',
        rail ? (mine ? 'max-w-[85%] self-end items-end' : 'self-stretch') : 'max-w-[92%]',
        !rail && (mine ? 'self-end items-end' : 'self-start')
      )}
    >
      <div
        className={cn(
          'whitespace-pre-wrap',
          rail
            ? mine
              ? 'rounded-2xl bg-secondary px-3 py-2 text-sm leading-relaxed text-foreground'
              : 'text-sm leading-relaxed text-foreground'
            : cn(
                'rounded-md px-2.5 py-1.5 text-xs leading-relaxed',
                mine ? 'bg-secondary text-foreground' : 'bg-warning/10 text-foreground'
              )
        )}
      >
        {m.content || (m.status === 'streaming' ? '…' : '')}
        {/* A failed reply's words are ours, by its code (lib/chat-errors.ts). */}
        {m.status === 'error' && (
          <span data-testid="chat-error-note" className={cn('block text-muted-foreground', m.content && 'mt-1')}>
            {chatErrorCopy(m.errorCode, m.answerer)}
          </span>
        )}
      </div>
      {notSaved && (
        <span data-testid="chat-not-saved" className="text-muted-foreground text-[10px]">
          Not saved
        </span>
      )}
    </div>
  );
}
