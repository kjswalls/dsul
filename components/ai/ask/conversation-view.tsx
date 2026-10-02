'use client';

import { useEffect, useMemo } from 'react';
import { ChatConversation } from '@/components/ai/chat-conversation';
import { ProposalCard } from '@/components/ai/proposal-card';
import { BoundComposer } from '@/components/ai/bound-composer';
import { useConversationsStore } from '@/lib/conversations-store';
import type { ComposerBinding } from '@/lib/rail-store';

/**
 * A conversation pushed over Ask home: its transcript, its own plan card, and
 * its box.
 *
 * The transcript is still ChatConversation's (bound to this conversation, its
 * own composer dropped); a transcript of the rail's own, with the ⌄ title menu
 * and the gone state, replaces it here. The plan card answers on this
 * conversation's surface (`conv:<id>`) and sits after the transcript, above the
 * box. It outlives this view unmounting (an item opened over it, a closed
 * rail): rail-store drops it only once the conversation has left both Ask
 * stacks, which is what Back is.
 */
export function ConversationView({ id }: { id: string }) {
  const binding = useMemo<ComposerBinding>(() => ({ kind: 'conversation', id }), [id]);

  // A saved conversation this browser has not read yet: its transcript. One
  // pushed by a send is already here, and one still streaming is never
  // re-read over its own reply.
  useEffect(() => {
    const store = useConversationsStore.getState();
    const thread = store.threads[id];
    if (thread?.saved && thread.load !== 'loaded' && thread.load !== 'loading' && !thread.streaming) {
      void store.openThread(id);
    }
  }, [id]);

  return (
    <div data-ask-conversation={id} className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <ChatConversation variant="desktop" conversationId={id} hideHeader hideComposer />
      </div>
      {/* A plain capped box (ScrollArea ignores max-h), gone while empty. */}
      <div className="max-h-[45%] shrink-0 overflow-y-auto px-3 pt-2 empty:hidden">
        <ProposalCard surface={`conv:${id}`} />
      </div>
      <div className="shrink-0 px-3 pt-2 pb-3">
        <BoundComposer binding={binding} />
      </div>
    </div>
  );
}
