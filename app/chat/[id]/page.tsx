'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConversationView } from '@/components/ai/ask/conversation-view';
import { useAICapabilities, useAIConnectionStore } from '@/lib/ai-connection-store';
import { resolveConversationId, useConversationsStore } from '@/lib/conversations-store';

/** A conversation id is a UUID; anything else is a link that names nothing. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A conversation opened wide (AI step 2c, "Open wide" on its title's ⌄): the
 * same view Ask pushes over the rail, at reading width on a page of its own,
 * for a long answer, a table, or a conversation worth keeping a tab on. It is
 * deep-linkable, as the item page is.
 *
 * The same gate as Ask: only while a model or OpenClaw can answer (History,
 * and so every saved conversation, is reachable only then). It reads the
 * transcript itself, since a cold load has no History to have opened it from.
 *
 * Deleted (or never this account's): the view says so and has no box, since a
 * send from it would start a conversation in a rail this page does not have.
 */
export default function ChatPage() {
  const params = useParams<{ id: string }>();
  const raw = params?.id ?? '';
  const valid = UUID.test(raw);
  const id = valid ? resolveConversationId(raw.toLowerCase()) : raw;
  const { known, canChat } = useAICapabilities();
  const owner = useAIConnectionStore((s) => s.hydratedUserId);
  const title = useConversationsStore((s) => s.summaries[id]?.title ?? null);
  const gone = useConversationsStore((s) => s.threads[id]?.load === 'gone');

  // Once the gate has answered for a signed-in account: openThread fetches
  // under the account the store is bound to, and does nothing without one.
  useEffect(() => {
    if (!valid || !canChat || !owner) return;
    void useConversationsStore.getState().openThread(id);
  }, [valid, canChat, owner, id]);

  if (!valid || !known || !canChat) {
    const settled = known || !valid;
    return (
      <main className="mx-auto flex max-w-lg flex-col items-start gap-4 px-6 py-16">
        <h1 className="text-foreground text-lg font-semibold">
          {!settled ? 'Loading…' : !valid ? 'Conversation not found' : 'AI is off'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {!settled
            ? 'If nothing loads, you may need to sign in.'
            : !valid
              ? 'The link may be incomplete.'
              : 'Conversations open while a model or OpenClaw is connected. Connect one in Settings → AI.'}
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/">Open dsul</Link>
          </Button>
          {!owner && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/login?redirect=${encodeURIComponent(`/chat/${raw}`)}`}>Sign in</Link>
            </Button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main
      data-testid="chat-page"
      className="mx-auto flex h-dvh max-w-3xl flex-col gap-4 px-4 pt-[max(1.5rem,env(titlebar-area-height,0px))] sm:px-6"
    >
      <nav className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
        <Link href="/" className="hover:text-foreground inline-flex items-center gap-1 transition-colors">
          <ChevronLeft className="size-3.5" />
          dsul
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium">Conversation</span>
      </nav>
      <h1 className="text-foreground shrink-0 truncate text-lg font-semibold" data-ask-heading tabIndex={-1}>
        {title ?? 'Conversation'}
      </h1>
      <ConversationView id={id} composer={!gone} />
    </main>
  );
}
