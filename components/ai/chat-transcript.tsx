'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Check, Copy, Wand2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ProposalCard } from '@/components/ai/proposal-card';
import { TypingIndicator } from '@/components/ui/typing-indicator';
import { useConversationsStore, type ChatMessage } from '@/lib/conversations-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import { buildPlanPrompt } from '@/lib/plan-prompt';
import { chatErrorCopy } from '@/lib/chat-errors';
import { stripReasoningTags } from '@/lib/chat-utils';
import { formatChatTimestamp } from '@/lib/format-chat-timestamp';
import { useTimeFormat } from '@/lib/use-time-format';
import { prefersReducedMotion } from '@/lib/zen-transition';
import type { Answerer } from '@/lib/conversation-types';

/**
 * chat-transcript.tsx — a conversation's messages, the one way every
 * conversation surface draws them: Ask's conversation view (the scroller
 * below, `ChatTranscript`) and an item's own conversation (the list alone,
 * `TranscriptMessages`, inside the item's body, which is its scroller).
 *
 * Claude's shape (the approved Full Chat page, mock 2):
 *  - YOURS: right-aligned, a soft bubble, no avatar.
 *  - REPLIES: full width, plain markdown, no bubble, no avatar, no card.
 *  - UNDER A FINISHED REPLY: Copy and its time, on hover and on focus within
 *    (always on a touch screen, which has no hover). Nothing there is lime, so
 *    the fade that hides them dims no accent.
 *  - STATUS LINES, muted and never content: "Stopped" after a stopped reply's
 *    partial text; a failed reply's words by its CODE (lib/chat-errors.ts,
 *    never the stored text, which holds none); "Not saved" once per turn the
 *    account will never hold.
 *  - A DIVIDER where who answers changes between replies: each message records
 *    its answerer, and a conversation may be continued under the other one.
 */

/** "Your model answers from here" / "OpenClaw answers from here". */
export function answererDividerCopy(answerer: Answerer): string {
  return answerer === 'openclaw' ? 'OpenClaw answers from here' : 'Your model answers from here';
}

/**
 * Where a divider goes: before the turn of each reply whose answerer differs
 * from the last reply that named one. The turn starts at the question when the
 * question sits right above its reply, so the divider never splits a turn.
 * Index → the answerer from there on.
 */
export function answererDividers(messages: readonly ChatMessage[]): Map<number, Answerer> {
  const at = new Map<number, Answerer>();
  let last: Answerer | null = null;
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !m.answerer) return;
    if (last && m.answerer !== last) {
      const prev = messages[i - 1];
      at.set(prev && prev.role === 'user' && prev.id === m.replyTo ? i - 1 : i, m.answerer);
    }
    last = m.answerer;
  });
  return at;
}

/**
 * "Not saved", once per turn: under its reply, or under the question when no
 * reply came to carry it (a stop before the first word).
 */
function endsUnsavedTurn(messages: readonly ChatMessage[], i: number): boolean {
  const m = messages[i];
  const next = messages[i + 1];
  return m.sync === 'unsaved' && !(next?.sync === 'unsaved' && next.replyTo === m.id);
}

/**
 * The messages alone, with no scroller of their own.
 *
 * `planFor` is the conversation the latest reply's "Turn this into a plan"
 * answers on (`conv:<id>`); without it there is no such offer (an item's
 * conversation, whose item has its own Break-into-steps). `busy` hides it
 * while a reply is still arriving.
 */
export function TranscriptMessages({
  messages,
  typing,
  busy,
  planFor,
}: {
  messages: readonly ChatMessage[];
  typing: boolean;
  busy: boolean;
  planFor?: string;
}) {
  const dividers = answererDividers(messages);
  return (
    <>
      {messages.map((m, i) => (
        <Fragment key={m.id}>
          {dividers.has(i) && <AnswererDivider answerer={dividers.get(i) as Answerer} />}
          {m.role === 'user' ? (
            <UserMessage m={m} notSaved={endsUnsavedTurn(messages, i)} />
          ) : (
            <Reply
              m={m}
              typing={typing}
              notSaved={endsUnsavedTurn(messages, i)}
              planFrom={planFor && i === messages.length - 1 && !busy ? { conversationId: planFor, messages } : undefined}
            />
          )}
        </Fragment>
      ))}
    </>
  );
}

function AnswererDivider({ answerer }: { answerer: Answerer }) {
  return (
    <div data-testid="answerer-divider" role="separator" className="flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="text-2xs text-muted-foreground">{answererDividerCopy(answerer)}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

function UserMessage({ m, notSaved }: { m: ChatMessage; notSaved: boolean }) {
  return (
    <div data-message-role="user" className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-secondary px-3 py-2 text-sm leading-relaxed text-foreground">
        {m.content}
      </div>
      {notSaved && <NotSaved />}
    </div>
  );
}

const REPLY_PROSE =
  'prose prose-sm dark:prose-invert max-w-none break-words text-sm leading-relaxed text-foreground prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-sm prose-code:text-success-text prose-pre:rounded-lg prose-pre:bg-muted prose-pre:p-3 prose-a:text-success-text prose-a:no-underline hover:prose-a:underline prose-strong:text-foreground';

function Reply({
  m,
  typing,
  notSaved,
  planFrom,
}: {
  m: ChatMessage;
  typing: boolean;
  notSaved: boolean;
  /** Set on the latest reply only, once it has finished. */
  planFrom?: { conversationId: string; messages: readonly ChatMessage[] };
}) {
  const { canPropose, openclawTransport } = useAICapabilities();
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const timeFormat = useTimeFormat();
  const streaming = m.status === 'streaming';
  const text = m.content ? stripReasoningTags(m.content).replace(/^\[\[reply_to[^\]]*\]\]\s*/i, '') : '';

  return (
    <div data-message-role="assistant" className="group/reply flex flex-col gap-1">
      {text ? (
        <div className={REPLY_PROSE}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      ) : streaming ? (
        // The plugin answers in one piece, so it types; a stream that has not
        // started yet waits.
        typing && m.answerer === 'openclaw' && openclawTransport === 'plugin' ? <TypingIndicator /> : <LoadingDots />
      ) : null}
      {m.status === 'stopped' && (
        <p data-testid="chat-stopped-note" className="text-xs text-muted-foreground">
          Stopped
        </p>
      )}
      {/* A failed reply's words are ours, by its code, never its content: they
          were not the AI's to save or to send back to a model. */}
      {m.status === 'error' && (
        <p data-testid="chat-error-note" role="status" className="text-sm text-muted-foreground">
          {chatErrorCopy(m.errorCode, m.answerer)}
        </p>
      )}
      {!streaming && (
        <div
          data-testid="reply-actions"
          className="flex items-center gap-2 opacity-0 transition-opacity group-hover/reply:opacity-100 group-focus-within/reply:opacity-100 [@media(hover:none)]:opacity-100"
        >
          {m.content && <CopyButton text={m.content} />}
          {m.createdAt > 0 && (
            <span className="text-2xs text-muted-foreground">
              {formatChatTimestamp(m.createdAt, timeFormat, userTimezone)}
            </span>
          )}
        </div>
      )}
      {notSaved && <NotSaved />}
      {/* Latest reply only: one offer at the foot of the thread. Outside the
          hover-faded row above on purpose: it is the one control that has to be
          findable without knowing it is there. */}
      {planFrom && canPropose && m.content && m.status !== 'error' && (
        <PlanButton conversationId={planFrom.conversationId} messages={planFrom.messages} replyId={m.id} />
      )}
    </div>
  );
}

/**
 * Hand the exchange to the proposal path, so a conversation can end in
 * something you tap rather than something you then go and do by hand. It sends
 * the EXCHANGE, not the reply alone (lib/plan-prompt.ts says why), and the
 * card answers on this conversation's surface (`conv:<id>`): it renders inline
 * after the last message, and what it changes is counted on this conversation.
 */
function PlanButton({
  conversationId,
  messages,
  replyId,
}: {
  conversationId: string;
  messages: readonly ChatMessage[];
  replyId: string;
}) {
  const request = useProposalStore((s) => s.request);
  // Scoped to this conversation's own request: another surface's proposal
  // loading must not grey this out with no "Thinking it through…" in sight.
  const busy = useProposalStore((s) => s.status === 'loading' && s.lastRequest?.surface === `conv:${conversationId}`);
  return (
    <button
      type="button"
      onClick={() => request('ask', buildPlanPrompt([...messages], replyId), undefined, { conversationId })}
      disabled={busy}
      data-testid="chat-make-plan"
      className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:border-ai/40 hover:text-foreground disabled:opacity-50"
    >
      <Wand2 className="size-3 text-ai" aria-hidden />
      Turn this into a plan
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      data-testid="reply-copy"
      aria-label={copied ? 'Copied' : 'Copy reply'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => {}
        );
      }}
      className="flex items-center gap-1 rounded p-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {/* Not the success green: that is the lime accent, and this row fades. */}
      {copied ? <Check className="size-3 text-foreground" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/**
 * A turn the account will never hold: the save was refused, or gave up after
 * its retries. Not behind the hover fade: it is news about the conversation,
 * not a tool.
 */
function NotSaved() {
  return (
    <span data-testid="chat-not-saved" className="text-2xs text-muted-foreground">
      Not saved
    </span>
  );
}

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1.5" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

/** Within this many pixels of the bottom, the view follows what arrives. */
export const FOLLOW_PX = 120;

const NO_MESSAGES: ChatMessage[] = [];

const distanceFromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

/**
 * A conversation's transcript in its own scroller: Ask's conversation view.
 *
 * SCROLLING. What arrives (a streamed reply, the plan card, a page loaded
 * underneath) is followed only while the view was within FOLLOW_PX of the
 * bottom; scrolled further up, the view stays where the reader put it and a
 * "Jump to latest" pill shows instead, which scrolls down (smoothly, unless
 * motion is reduced) and goes. The reader's own send always goes to the
 * bottom, and a transcript arriving whole (an open, a fetch) lands there.
 * "Load earlier" keeps the scroll where it was: the page lands above the
 * line being read.
 */
export function ChatTranscript({ id }: { id: string }) {
  const messages = useConversationsStore((s) => s.threads[id]?.messages ?? NO_MESSAGES);
  const typing = useConversationsStore((s) => !!s.threads[id]?.typing);
  const hasEarlier = useConversationsStore((s) => !!s.threads[id]?.hasEarlier);
  const busy = useConversationsStore((s) => !!s.sending[`conv:${id}`] || !!s.threads[id]?.streaming);
  const cardUp = useProposalStore((s) => s.status !== 'idle' && s.lastRequest?.surface === `conv:${id}`);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Within FOLLOW_PX of the bottom as of the last scroll: what arrives next is followed. */
  const following = useRef(true);
  const [jump, setJump] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** The distance from the bottom to hold while an earlier page lands above. */
  const anchor = useRef<number | null>(null);
  const seen = useRef<{ count: number; first: string | undefined; lastUser: string | undefined }>({
    count: 0,
    first: undefined,
    lastUser: undefined,
  });

  const toBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    following.current = true;
    setJump(false);
  }, []);

  /** Something grew: follow it, or offer the pill. */
  const grew = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (following.current) {
      el.scrollTop = el.scrollHeight;
      setJump(false);
    } else {
      setJump(distanceFromBottom(el) > FOLLOW_PX);
    }
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = seen.current;
    let lastUser: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0 && !lastUser; i--) if (messages[i].role === 'user') lastUser = messages[i];
    seen.current = { count: messages.length, first: messages[0]?.id, lastUser: lastUser?.id };
    if (!el) return;
    // An earlier page, landed above: hold the line being read.
    if (anchor.current !== null && messages[0]?.id !== prev.first && prev.count > 0) {
      el.scrollTop = el.scrollHeight - el.clientHeight - anchor.current;
      anchor.current = null;
      return;
    }
    // The transcript arriving whole, or the reader's own send: the bottom.
    const sent = !!lastUser && lastUser.id !== prev.lastUser && lastUser.sync === 'pending' && prev.count > 0;
    if ((prev.count === 0 && messages.length > 0) || sent) {
      toBottom(false);
      return;
    }
    grew();
  }, [messages, typing, cardUp, toBottom, grew]);

  // Growth no message change shows: markdown reflowing, the card's own
  // states, a window resized narrower.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => grew());
    ro.observe(content);
    return () => ro.disconnect();
  }, [grew]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = distanceFromBottom(el) <= FOLLOW_PX;
    following.current = near;
    setJump(!near);
  };

  const loadEarlier = async () => {
    const el = scrollRef.current;
    if (el) anchor.current = distanceFromBottom(el);
    setLoadingEarlier(true);
    try {
      await useConversationsStore.getState().loadEarlier(id);
    } finally {
      setLoadingEarlier(false);
      // Nothing came (a failure): there is nothing to anchor.
      if (useConversationsStore.getState().threads[id]?.messages[0]?.id === seen.current.first) anchor.current = null;
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="chat-transcript"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className="flex flex-col gap-3 px-5 pt-2 pb-4">
          {hasEarlier && (
            <button
              type="button"
              onClick={() => void loadEarlier()}
              disabled={loadingEarlier}
              data-testid="chat-load-earlier"
              className="self-center rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier'}
            </button>
          )}
          <TranscriptMessages messages={messages} typing={typing} busy={busy} planFor={id} />
          {/* The conversation's plan card, inline after the last message; it
              outlives this view unmounting (rail-store drops it once the
              conversation has left both Ask stacks). */}
          <ProposalCard surface={`conv:${id}`} />
        </div>
      </div>
      {jump && (
        <button
          type="button"
          onClick={() => toBottom(!prefersReducedMotion())}
          data-testid="chat-jump-latest"
          className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs text-foreground shadow-soft-sm transition-colors hover:bg-muted"
        >
          <ArrowDown className="size-3.5" aria-hidden />
          Jump to latest
        </button>
      )}
    </div>
  );
}

/** Three bubbles while a conversation's transcript is on its way. */
export function TranscriptSkeleton() {
  return (
    <div
      data-testid="chat-transcript-loading"
      aria-busy="true"
      aria-label="Loading conversation"
      className="flex flex-col gap-4 px-5 pt-3"
    >
      <div className="h-9 w-3/5 self-end rounded-2xl bg-muted motion-safe:animate-pulse" />
      <div className="h-14 w-11/12 rounded-2xl bg-muted motion-safe:animate-pulse" />
      <div className="h-9 w-2/5 self-end rounded-2xl bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
