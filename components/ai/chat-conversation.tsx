'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Sparkles, MessageSquarePlus, Copy, Check, User, Wand2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatComposer } from '@/components/ai/chat-composer';
import { TypingIndicator } from '@/components/ui/typing-indicator';
import { resolveConversationId, useConversationsStore, type ChatMessage } from '@/lib/conversations-store';
import { bindingKey, sendFrom, useGeneralThreadId, type ComposerBinding } from '@/lib/open-chat';
import { buildPlanPrompt } from '@/lib/plan-prompt';
import { chatErrorCopy } from '@/lib/chat-errors';
import { useProposalStore } from '@/lib/proposal-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { buildChatOpeners } from '@/lib/ai-openers';
import { inactiveItemIdsOn } from '@/lib/active';
import { toDateStr } from '@/lib/recurrence';
import { useTimeFormat } from '@/lib/use-time-format';
import { formatChatTimestamp } from '@/lib/format-chat-timestamp';
import { chatAssistantLabel, stripReasoningTags } from '@/lib/chat-utils';
import { cn } from '@/lib/utils';

interface ChatConversationProps {
  variant: 'desktop' | 'mobile';
  /**
   * Accepted from both shells and currently unused: its one reader was the
   * "API key needed" empty state, which the AI gate made unreachable (chat
   * mounts only once something can answer). Kept so a future empty state can
   * link out without re-plumbing both callers.
   */
  onOpenSettings?: () => void;
  /** Increment to focus the input (e.g. when the panel expands / tab activates). */
  focusSignal?: number;
  /** Hide the provider header row (the desktop panel renders its own). */
  hideHeader?: boolean;
  /**
   * Drop the composer. The phone's chat tab passes this: its input is the
   * dock's bar (components/mobile/mobile-bottom-dock.tsx), so leaving this one
   * mounted would stack two text fields, the lower of which is the real one.
   */
  hideComposer?: boolean;
  /**
   * Give the assistant's replies a card of their own (surface-2, hairline, soft
   * shadow, a notched 16px radius), per design/mobile-redesign/ChatTab.dc.html.
   * The phone's chat tab passes it: with the panel gone the conversation sits
   * straight on the paper, and bare prose there has nothing bounding it — in
   * dark mode the user's bubble ends up the only carded turn on screen. The
   * desktop panel already IS a card, so it keeps the flat default.
   */
  cardedReplies?: boolean;
  /**
   * The saved conversation to show. Absent: the general conversation the
   * single-thread panels share (`useGeneralThreadId`, lib/open-chat.ts).
   */
  conversationId?: string;
}

/** One empty transcript, so a selector for a thread not yet made is stable. */
const NO_MESSAGES: ChatMessage[] = [];

/**
 * The chat conversation (messages + input) over one saved conversation
 * (lib/conversations-store.ts), answered by a connected model or by OpenClaw.
 * Shared by the desktop sidebar chat panel and the mobile chat tab — replaces
 * the duplicated bodies of chat-sidebar and mobile-chat-panel.
 *
 * Both hosts mount it only while the AI gate says something can answer, so
 * every branch here can assume an answerer; `target` names which.
 */
export function ChatConversation({
  variant,
  focusSignal,
  hideHeader,
  hideComposer,
  cardedReplies,
  conversationId,
}: ChatConversationProps) {
  const generalId = useGeneralThreadId();
  // A draft rebound to its real id (a 409) is the same conversation.
  const id = resolveConversationId(conversationId ?? generalId);
  const binding = useMemo<ComposerBinding>(() => ({ kind: 'conversation', id }), [id]);
  const messages = useConversationsStore((s) => s.threads[id]?.messages ?? NO_MESSAGES);
  const isTyping = useConversationsStore((s) => !!s.threads[id]?.typing);
  // Busy from the send's first instant until the reply has finished arriving.
  const isLoading = useConversationsStore(
    (s) => !!s.sending[bindingKey(binding)] || !!s.threads[id]?.streaming
  );
  // The AI gate (lib/ai-registry.ts), which fails closed. `canPropose` gates
  // ONE thing here, "Turn this into a plan": OpenClaw's plugin path answers
  // chat but has no proposal transport, so it can chat without proposing.
  const { target, agentId, canChat, canPropose, openclawTransport } = useAICapabilities();
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const requestProposal = useProposalStore((s) => s.request);
  // Scoped, not global. The spinner renders on the surface that asked, so a
  // breakdown loading inside an item panel used to grey out THIS button with no
  // "Thinking it through…" visible anywhere — a dead control with no
  // explanation. Superseding another surface's request is safe now: the store
  // drops the reply of any request that is no longer current.
  const proposalBusy = useProposalStore(
    (s) => s.status === 'loading' && s.lastRequest?.surface === `conv:${id}`
  );
  const timeFormatStr = useTimeFormat();

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const isMobile = variant === 'mobile';

  // Auto-scroll to bottom — scroll within container, not the whole page
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, isLoading, isTyping]);

  const copyMessage = useCallback((content: string, messageId: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(messageId);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  /**
   * "Not saved", once per turn: under its reply, or under the question when
   * there is no reply to carry it (a stop before the first word).
   */
  const endsUnsavedTurn = (i: number) => {
    const m = messages[i];
    const next = messages[i + 1];
    return m.sync === 'unsaved' && !(next?.sync === 'unsaved' && next.replyTo === m.id);
  };

  // Only read when the transcript is empty, but hooks cannot be conditional —
  // the guard is the cheap `messages.length` check inside. Gated on CHAT, not
  // on proposing: an opener is a plain send(), so OpenClaw plugin chat (which
  // cannot propose) still gets something to say instead of a blank box.
  const openers = useMemo(() => {
    if (messages.length > 0 || !canChat) return [];
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = toDateStr(new Date(), tz);
    return buildChatOpeners({
      items,
      todayStr,
      userTimezone: tz,
      inactiveIds: inactiveItemIdsOn(items, todayStr, { userTimezone: tz, routines, seasons }),
    });
  }, [messages.length, canChat, items, routines, seasons, userTimezone]);

  /**
   * Hand the exchange to the proposal path, so a conversation can end in
   * something you tap rather than something you then go and do by hand.
   *
   * Sends the EXCHANGE, not the raw question (lib/plan-prompt.ts says why).
   * The card answers on this conversation's own surface (`conv:<id>`), so what
   * it changes is counted on this conversation, and it is rendered by the
   * parent shell above the transcript — a decision waiting on you does not
   * belong at the bottom of scrollback.
   */
  const askForPlan = useCallback(
    (replyId: string) => {
      requestProposal('ask', buildPlanPrompt(messages, replyId), undefined, { conversationId: id });
    },
    [messages, requestProposal, id]
  );

  return (
    <>
      {!hideHeader && (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <p className="text-2xs font-medium text-muted-foreground">
            {chatAssistantLabel(target, agentId)}
          </p>
        </div>
      )}

      {/* Messages with fade at top */}
      <div ref={messagesContainerRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            'pointer-events-none sticky top-0 z-10 bg-gradient-to-b from-surface-1 to-transparent',
            isMobile ? 'h-16 from-background' : 'h-8'
          )}
        />

        {messages.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
            <div className="relative">
              <MessageSquarePlus
                className={cn('text-muted-foreground/40', isMobile ? 'h-14 w-14' : 'h-10 w-10')}
                strokeWidth={1.25}
              />
              <Sparkles
                className={cn('absolute -top-1 -right-1 text-ai', isMobile ? 'h-6 w-6' : 'h-4 w-4')}
              />
            </div>
            {/* No "connect a key" branch: the hosts mount this only once
                something can answer, so the empty state is always an invitation. */}
            <div className="space-y-1">
              <p className={cn('font-serif font-semibold text-foreground', isMobile ? 'text-lg' : 'text-base')}>
                {target === 'openclaw' ? 'OpenClaw is ready' : 'Ask anything'}
              </p>
              <p className="max-w-[280px] text-xs leading-relaxed text-muted-foreground">
                {target === 'openclaw'
                  ? 'Ask anything. OpenClaw can see your tasks, habits, and projects.'
                  : 'Break a task down, plan your day, or think out loud. It can see your tasks, habits, and projects.'}
              </p>

              {/* Something to say, so the first move is a tap rather than a
                  blank box. Derived from the planner — see lib/ai-openers.ts
                  for why these are not a static list, and for the copy rule. */}
              {openers.length > 0 && (
                <div
                  data-testid="chat-openers"
                  className="flex flex-col items-stretch gap-1.5 pt-2"
                >
                  {openers.map((opener) => (
                    <button
                      key={opener.id}
                      onClick={() => void sendFrom(binding, opener.prompt)}
                      className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-ai/40 hover:bg-muted"
                    >
                      {opener.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className={cn('flex flex-col gap-3 px-4 pb-4', isMobile ? '-mt-12' : '-mt-6')}>
            {messages.map((msg, i) => (
              <div key={msg.id} className="group">
                {msg.role === 'user' ? (
                  <div className="flex items-start justify-end gap-3">
                    <div className="flex max-w-[85%] flex-col items-end gap-1">
                      <div className="whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground">
                        {msg.content}
                      </div>
                      <div
                        className={cn(
                          'flex items-center gap-2 transition-opacity',
                          isMobile ? 'opacity-60' : 'opacity-0 group-hover:opacity-100'
                        )}
                      >
                        {msg.createdAt > 0 && (
                          <span className="text-2xs text-muted-foreground">
                            {formatChatTimestamp(msg.createdAt, timeFormatStr, userTimezone)}
                          </span>
                        )}
                        <button
                          onClick={() => copyMessage(msg.content, msg.id)}
                          className="p-1 text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {copiedId === msg.id ? (
                            <Check className="h-3 w-3 text-success" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                      {endsUnsavedTurn(i) && <NotSaved />}
                    </div>
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <div
                      className={cn(
                        'prose prose-sm dark:prose-invert max-w-none break-words text-sm leading-relaxed text-foreground prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-sm prose-code:text-success-text prose-pre:rounded-lg prose-pre:bg-muted prose-pre:p-3 prose-a:text-success-text prose-a:no-underline hover:prose-a:underline prose-strong:text-foreground',
                        // The notched corner is the user bubble's, mirrored to
                        // the side the reply is anchored on.
                        cardedReplies &&
                          'w-fit max-w-[85%] rounded-2xl rounded-bl-sm border border-surface-3 bg-surface-2 px-[14px] py-3 shadow-[var(--shadow-soft-sm)]'
                      )}
                    >
                      {msg.content ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {stripReasoningTags(msg.content).replace(/^\[\[reply_to[^\]]*\]\]\s*/i, '')}
                        </ReactMarkdown>
                      ) : msg.status === 'streaming' ? (
                        // The plugin answers in one piece, so it types; a
                        // stream that has not started yet waits.
                        isTyping && msg.answerer === 'openclaw' && openclawTransport === 'plugin' ? (
                          <TypingIndicator />
                        ) : (
                          <LoadingDots />
                        )
                      ) : null}
                      {/* A failed reply's words are ours, by its code, never
                          its content: they were not the AI's to save or to
                          send back to a model (lib/chat-errors.ts). */}
                      {msg.status === 'error' && (
                        <p
                          data-testid="chat-error-note"
                          className={cn('not-prose text-sm text-muted-foreground', msg.content && 'mt-2')}
                        >
                          {chatErrorCopy(msg.errorCode, msg.answerer)}
                        </p>
                      )}
                    </div>
                    <div
                      className={cn(
                        'flex items-center gap-2 transition-opacity',
                        isMobile ? 'opacity-60' : 'opacity-0 group-hover:opacity-100'
                      )}
                    >
                      {msg.createdAt > 0 && (
                        <span className="text-2xs text-muted-foreground">
                          {formatChatTimestamp(msg.createdAt, timeFormatStr, userTimezone)}
                        </span>
                      )}
                      {msg.content && (
                        <button
                          onClick={() => copyMessage(msg.content, msg.id)}
                          className="p-1 text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {copiedId === msg.id ? (
                            <Check className="h-3 w-3 text-success" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      )}
                    </div>
                    {endsUnsavedTurn(i) && <NotSaved />}

                    {/* Latest reply only: one offer at the foot of the thread,
                        not a button under every paragraph ever said. Outside the
                        hover-faded actions row above deliberately — this is the
                        one affordance that has to be findable without knowing it
                        is there, and the lime accent must never be dimmed by a
                        parent's opacity. */}
                    {canPropose &&
                      msg.content &&
                      msg.status !== 'error' &&
                      i === messages.length - 1 &&
                      !isLoading && (
                      <button
                        onClick={() => askForPlan(msg.id)}
                        disabled={proposalBusy}
                        data-testid="chat-make-plan"
                        className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:border-ai/40 hover:text-foreground disabled:opacity-50"
                      >
                        <Wand2 className="h-3 w-3 text-ai" />
                        Turn this into a plan
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Input area */}
{!hideComposer && (
        <div
          className={cn('shrink-0 px-3 pb-3 pt-2', isMobile && 'border-t border-border bg-background')}
        >
          <ChatComposer variant="panel" binding={binding} touch={isMobile} focusSignal={focusSignal} />
        </div>
      )}
    </>
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
    <span className="inline-flex items-center gap-1" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground opacity-60"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}
