'use client';

import { useEffect, useMemo } from 'react';
import { BoundComposer } from '@/components/ai/bound-composer';
import { ChatTranscript, TranscriptSkeleton } from '@/components/ai/chat-transcript';
import { NewChatChips, NewChatEmpty } from '@/components/ai/ask/new-chat-empty';
import { ProposalCard } from '@/components/ai/proposal-card';
import { resolveConversationId, useConversationsStore } from '@/lib/conversations-store';
import { usePlannerStore } from '@/lib/planner-store';
import type { AskSurface, ComposerBinding } from '@/lib/rail-store';
import { cn } from '@/lib/utils';

/** A send from a conversation deleted elsewhere starts a new one, which replaces this view. */
const HOME: ComposerBinding = { kind: 'home' };

/**
 * What the view shows for a conversation, from what this browser holds:
 *   new         a draft with nothing said yet: Claude's empty state
 *   loading     a saved conversation whose transcript is on its way
 *   error       one whose transcript could not be fetched (and nothing is here)
 *   transcript  everything else, a conversation found deleted included
 */
export type ConversationViewState = 'new' | 'loading' | 'error' | 'transcript';

/**
 * A conversation pushed over Ask: its transcript (components/ai/
 * chat-transcript.tsx), its plan card inline after the last message, and its
 * box at the foot. Its title, with the ⌄ menu once it is saved, is in the
 * rail's header (components/ai/ask/conversation-title-menu.tsx).
 *
 * A NEW CHAT (a draft with nothing said) shows the empty state instead, with
 * the box in the middle. The box is the same element in both layouts (the
 * same place in this tree), so the first send moves it to the foot with the
 * caret still in it.
 *
 * DELETED ELSEWHERE (a 404 on open or on save: another device, or another tab
 * or window on this one, so the notice does not guess which): what is in
 * memory stays, under "This conversation was deleted.", and the box sends to
 * a NEW conversation, which replaces this view (the level rule). A
 * conversation whose ITEM is gone says so, and goes on without an item to
 * focus its context on.
 *
 * `composer: false` is the phone's (its box is the dock's).
 */
export function ConversationView({
  id: rawId,
  surface = 'desktop',
  composer = true,
}: {
  id: string;
  surface?: AskSurface;
  composer?: boolean;
}) {
  // A draft rebound to its item's real conversation (a 409) is that one.
  const id = resolveConversationId(rawId);
  const state = useConversationsStore((s): ConversationViewState => {
    const t = s.threads[id];
    if (t && (t.messages.length > 0 || t.load === 'gone')) return 'transcript';
    if (!s.summaries[id] && !t?.saved) return 'new';
    if (t?.load === 'error') return 'error';
    return t?.load === 'loaded' ? 'transcript' : 'loading';
  });
  const gone = useConversationsStore((s) => s.threads[id]?.load === 'gone');
  const itemId = useConversationsStore((s) => s.summaries[id]?.itemId ?? s.threads[id]?.itemId ?? null);
  const itemGone = usePlannerStore((s) => itemId !== null && !s.items.some((i) => i.id === itemId));
  const binding = useMemo<ComposerBinding>(() => (gone ? HOME : { kind: 'conversation', id }), [gone, id]);

  // Its transcript, if this browser does not have it fresh: one opened from
  // History, or read on another device since. Only one known to have a row:
  // a draft (or an id this browser has never heard of) has nothing to fetch,
  // and one streaming is never re-read over its own reply (the store's rule).
  useEffect(() => {
    const store = useConversationsStore.getState();
    if (store.summaries[id] || store.threads[id]?.saved) void store.openThread(id);
  }, [id]);

  const isNew = state === 'new';

  return (
    <div data-ask-conversation={id} className="flex min-h-0 flex-1 flex-col">
      {gone ? <Notice testId="conversation-gone">This conversation was deleted.</Notice> : null}
      {itemGone && !gone ? <Notice testId="conversation-item-gone">The item this was about is gone.</Notice> : null}
      {isNew ? (
        <NewChatEmpty />
      ) : state === 'loading' ? (
        <div className="min-h-0 flex-1">
          <TranscriptSkeleton />
        </div>
      ) : state === 'error' ? (
        <ThreadError id={id} />
      ) : (
        <ChatTranscript id={id} />
      )}
      {composer ? (
        <div className={cn('shrink-0 px-3', !isNew && 'pt-2 pb-3')}>
          <BoundComposer binding={binding} placeholder={isNew || gone ? undefined : 'Reply…'} />
        </div>
      ) : null}
      {isNew ? (
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          <NewChatChips binding={binding} surface={surface} />
          <div className="px-3 pt-3 empty:hidden">
            <ProposalCard surface={`conv:${id}`} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Notice({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="mx-5 mb-2 shrink-0 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      {children}
    </p>
  );
}

function ThreadError({ id }: { id: string }) {
  return (
    <div
      data-testid="conversation-error"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center"
    >
      <p className="text-sm text-muted-foreground">Couldn&apos;t load this conversation.</p>
      <button
        type="button"
        onClick={() => void useConversationsStore.getState().openThread(id)}
        className="rounded-md border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent"
      >
        Try again
      </button>
    </div>
  );
}
