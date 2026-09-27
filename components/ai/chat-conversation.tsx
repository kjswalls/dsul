'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkles, MessageSquarePlus, Copy, Check, User, Wand2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatComposer } from '@/components/ai/chat-composer';
import { OnboardingChat } from '@/components/ai/onboarding-chat';
import { TypingIndicator } from '@/components/ui/typing-indicator';
import { useChatStore } from '@/lib/chat-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { useProposalStore } from '@/lib/proposal-store';
import { usePlannerStore } from '@/lib/planner-store';
import { resolveAICapabilities } from '@/lib/ai-registry';
import { buildChatOpeners } from '@/lib/ai-openers';
import { inactiveItemIdsOn } from '@/lib/active';
import { toDateStr } from '@/lib/recurrence';
import { useTimeFormat } from '@/lib/use-time-format';
import { formatChatTimestamp } from '@/lib/format-chat-timestamp';
import { chatAssistantLabel, chatAssistantName, stripReasoningTags } from '@/lib/chat-utils';
import { createClient } from '@/lib/supabase';
import { isOnboardingComplete } from '@/lib/user-profile';
import { useUIStore } from '@/lib/ui-store';
import { cn } from '@/lib/utils';

interface ChatConversationProps {
  variant: 'desktop' | 'mobile';
  onOpenSettings?: () => void;
  /** Increment to focus the input (e.g. when the panel expands / tab activates). */
  focusSignal?: number;
  /** Hide the provider header row (the desktop panel renders its own). */
  hideHeader?: boolean;
  /**
   * Drop the composer. The phone's Beacon tab passes this: its input is the
   * dock's bar (components/mobile/mobile-bottom-dock.tsx), so leaving this one
   * mounted would stack two text fields, the lower of which is the real one.
   */
  hideComposer?: boolean;
  /**
   * Give Beacon's replies a card of their own (surface-2, hairline, soft
   * shadow, a notched 16px radius), per design/mobile-redesign/ChatTab.dc.html.
   * The phone's Beacon tab passes it: with the panel gone the conversation sits
   * straight on the paper, and bare prose there has nothing bounding it — in
   * dark mode the user's bubble ends up the only carded turn on screen. The
   * desktop panel already IS a card, so it keeps the flat default.
   */
  cardedReplies?: boolean;
}

/**
 * The Beacon/OpenClaw conversation (messages + input) on top of chat-store.
 * Shared by the desktop sidebar chat panel and the mobile chat tab —
 * replaces the duplicated bodies of chat-sidebar and mobile-chat-panel.
 */
export function ChatConversation({
  variant,
  onOpenSettings,
  focusSignal,
  hideHeader,
  hideComposer,
  cardedReplies,
}: ChatConversationProps) {
  // `send` outlived the composer's move into ChatComposer: an opener is a
  // tap that sends a message, so this surface still has one thing to say.
  const { messages, isLoading, isTyping, send, hydrate, syncOpenclawInfo, openclawAgentIdDisplay } =
    useChatStore();
  const aiProvider = useAISettingsStore((s) => s.provider);
  const aiApiKey = useAISettingsStore((s) => s.apiKey);
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
    (s) => s.status === 'loading' && s.lastRequest?.surface === 'chat'
  );
  const timeFormatStr = useTimeFormat();

  // 'unknown' connection: this component has no reachability probe, and the
  // registry treats unknown optimistically on purpose so capabilities do not
  // flicker off and back on during hydration.
  const canPropose = resolveAICapabilities(aiProvider).canPropose;
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  // Shared, not local: the phone's chat field lives in the dock now, and the
  // dock has to stand down while this branch is showing (see the note on
  // chatOnboardingActive in lib/ui-store.ts).
  const showOnboarding = useUIStore((s) => s.chatOnboardingActive);
  const setShowOnboarding = useUIStore((s) => s.setChatOnboardingActive);
  const [userId, setUserId] = useState<string | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const isMobile = variant === 'mobile';
  const displayName = chatAssistantName(aiProvider);

  useEffect(() => {
    hydrate();
    syncOpenclawInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check auth + onboarding status
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id;
      if (!uid) return;
      setUserId(uid);
      const done = await isOnboardingComplete(uid);
      if (!done) setShowOnboarding(true);
    });
  }, [setShowOnboarding]);

  // Auto-scroll to bottom — scroll within container, not the whole page
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, isLoading, isTyping]);

  const copyMessage = useCallback((content: string, index: number) => {
    navigator.clipboard.writeText(content);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  }, []);

  // Only read when the transcript is empty, but hooks cannot be conditional —
  // the guard is the cheap `messages.length` check inside.
  const openers = useMemo(() => {
    if (messages.length > 0 || !canPropose) return [];
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = toDateStr(new Date(), tz);
    return buildChatOpeners({
      items,
      todayStr,
      userTimezone: tz,
      inactiveIds: inactiveItemIdsOn(items, todayStr, { userTimezone: tz, routines, seasons }),
    });
  }, [messages.length, canPropose, items, routines, seasons, userTimezone]);

  /**
   * Hand the exchange to the proposal path, so a conversation can end in
   * something you tap rather than something you then go and do by hand.
   *
   * Sends the EXCHANGE, not the raw question: what makes a plan worth proposing
   * is usually in Beacon's reply ("push the two writing ones to Thursday"), and
   * a proposer given only "what should I do about this week" has to re-derive
   * the whole answer and will land somewhere else. The card is rendered by the
   * parent shell above the transcript — a decision waiting on you does not
   * belong at the bottom of scrollback.
   */
  const askForPlan = useCallback(
    (index: number) => {
      const reply = stripReasoningTags(messages[index]?.content ?? '');
      let ask = '';
      for (let i = index - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          ask = messages[i].content;
          break;
        }
      }
      requestProposal(
        'ask',
        [
          'Turn this conversation into concrete planner changes.',
          '',
          `I asked: ${clip(ask)}`,
          '',
          `You answered: ${clip(reply)}`,
        ].join('\n')
      );
    },
    [messages, requestProposal]
  );

  if (showOnboarding && userId) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <OnboardingChat userId={userId} onComplete={() => setShowOnboarding(false)} />
      </div>
    );
  }

  return (
    <>
      {!hideHeader && (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <p className="text-2xs font-medium text-muted-foreground">
            {chatAssistantLabel(aiProvider, openclawAgentIdDisplay)}
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
            {aiProvider === 'openai' && !aiApiKey ? (
              <div className="space-y-2">
                <p className={cn('font-medium text-foreground', isMobile ? 'text-lg' : 'text-sm')}>
                  API key needed
                </p>
                <p className="max-w-[280px] text-xs leading-relaxed text-muted-foreground">
                  Beacon needs an API key to get started.
                </p>
                {onOpenSettings && (
                  <button onClick={onOpenSettings} className="text-xs text-success-text hover:underline">
                    → Go to Settings
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                <p className={cn('font-serif font-semibold text-foreground', isMobile ? 'text-lg' : 'text-base')}>
                  {aiProvider === 'openclaw' ? `${displayName} is ready` : `Plan with ${displayName}`}
                </p>
                <p className="max-w-[280px] text-xs leading-relaxed text-muted-foreground">
                  {aiProvider === 'openclaw' ? (
                    `Ask anything — ${displayName} knows your tasks, habits, and projects.`
                  ) : aiProvider === 'none' ? (
                    <span>
                      Connect <span className="font-medium text-foreground">OpenClaw</span> in Settings
                      for your personal AI agent, or add an OpenAI key to use Beacon.
                    </span>
                  ) : (
                    'Ask me to break down tasks, plan your day, or think through what to tackle next.'
                  )}
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
                        onClick={() => send(opener.prompt)}
                        className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-ai/40 hover:bg-muted"
                      >
                        {opener.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className={cn('flex flex-col gap-3 px-4 pb-4', isMobile ? '-mt-12' : '-mt-6')}>
            {messages.map((msg, i) => (
              <div key={i} className="group">
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
                        {msg.timestamp && (
                          <span className="text-2xs text-muted-foreground">
                            {formatChatTimestamp(msg.timestamp, timeFormatStr, userTimezone)}
                          </span>
                        )}
                        <button
                          onClick={() => copyMessage(msg.content, i)}
                          className="p-1 text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {copiedIndex === i ? (
                            <Check className="h-3 w-3 text-success" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
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
                      ) : isTyping && i === messages.length - 1 ? (
                        <TypingIndicator />
                      ) : isLoading && i === messages.length - 1 ? (
                        <LoadingDots />
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        'flex items-center gap-2 transition-opacity',
                        isMobile ? 'opacity-60' : 'opacity-0 group-hover:opacity-100'
                      )}
                    >
                      {msg.timestamp && (
                        <span className="text-2xs text-muted-foreground">
                          {formatChatTimestamp(msg.timestamp, timeFormatStr, userTimezone)}
                        </span>
                      )}
                      {msg.content && (
                        <button
                          onClick={() => copyMessage(msg.content, i)}
                          className="p-1 text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {copiedIndex === i ? (
                            <Check className="h-3 w-3 text-success" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      )}
                    </div>

                    {/* Latest reply only: one offer at the foot of the thread,
                        not a button under every paragraph ever said. Outside the
                        hover-faded actions row above deliberately — this is the
                        one affordance that has to be findable without knowing it
                        is there, and the lime accent must never be dimmed by a
                        parent's opacity. */}
                    {canPropose && msg.content && i === messages.length - 1 && !isLoading && (
                      <button
                        onClick={() => askForPlan(i)}
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
            {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
              <div className="text-sm text-foreground">
                <LoadingDots />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input area */}
{!hideComposer && (
        <div
          className={cn('shrink-0 px-3 pb-3 pt-2', isMobile && 'border-t border-border bg-background')}
        >
          <ChatComposer variant="panel" touch={isMobile} focusSignal={focusSignal} />
        </div>
      )}
    </>
  );
}

/**
 * Caps one side of the excerpt handed to the proposer.
 *
 * The whole planner already travels with a proposal request; a long reply on
 * top of it is the part that pushes the prompt somewhere it starts losing the
 * item list off the front. The tail is what gets cut because the conclusion —
 * the part worth acting on — is at the end of an answer, not the start.
 */
function clip(text: string, max = 2000): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
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
