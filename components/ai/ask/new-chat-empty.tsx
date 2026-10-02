'use client';

import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { AskGreeting } from '@/components/ai/ask/ask-greeting';
import { OpenerChips } from '@/components/ai/opener-chips';
import { buildChatOpeners, NEW_CHAT_OPENERS, type ChatOpener } from '@/lib/ai-openers';
import { askNew, newChat } from '@/lib/open-chat';
import { bindingKey, useRailStore, type AskSurface, type ComposerBinding } from '@/lib/rail-store';
import { useOpenerContext } from '@/hooks/use-opener-context';

/**
 * A new chat with nothing said yet: Claude's empty state (the Full Chat page,
 * mock 6). Centred in the column, top to bottom: the spark and the greeting in
 * serif (AskGreeting, Ask home's own, at its new-chat size), "How can I
 * help?", then the box (ConversationView's own, kept mounted in place so the
 * caret survives the first send), the model label, and four chips. The first
 * send swaps all of this for the transcript, and the box settles at the foot.
 *
 * A draft has no row until its first turn is saved, so a new chat left unsent
 * leaves nothing behind.
 */

/** The spark, the greeting and the question, above the box. */
export function NewChatEmpty() {
  return (
    <div
      data-testid="new-chat-empty"
      className="flex min-h-0 flex-1 flex-col items-center justify-end gap-1.5 px-6 pb-5 text-center"
    >
      <AskGreeting variant="new-chat" />
      <p className="text-[15px] text-muted-foreground">How can I help?</p>
    </div>
  );
}

/**
 * The four chips under the centred box: three of today's openers, then "Help
 * me start…" (lib/ai-openers.ts, `NEW_CHAT_OPENERS` and `includeStart`), read
 * off the same day as Ask home's two. A sending chip starts its conversation
 * titled with its label, not its long prompt (`askNew`); "Help me start…"
 * (`mode: 'prefill'`) fills this draft's box instead, ahead of anything typed
 * there already, and hands it the caret.
 */
export function NewChatChips({ binding, surface = 'desktop' }: { binding: ComposerBinding; surface?: AskSurface }) {
  const { ctx, minutesNow } = useOpenerContext();
  const openers = useMemo(
    () =>
      ctx && minutesNow !== null
        ? buildChatOpeners(ctx, { max: NEW_CHAT_OPENERS, minutesNow, includeStart: true })
        : [],
    [ctx, minutesNow]
  );

  const choose = (opener: ChatOpener) => {
    if (opener.mode === 'prefill') {
      // The chips sit beside a live box: words already typed there are kept,
      // after the sentence's start, never replaced by it.
      const rail = useRailStore.getState();
      const key = bindingKey(binding);
      const typed = rail.drafts[key] ?? '';
      if (!typed.trim()) rail.setDraft(key, opener.prompt);
      else if (!typed.startsWith(opener.prompt)) rail.setDraft(key, opener.prompt + typed.trimStart());
      rail.focusComposer(binding);
      return;
    }
    askNew(opener.prompt, { title: opener.label, isMobile: surface === 'phone' });
  };

  return <OpenerChips openers={openers} onPick={choose} className="justify-center px-5 pt-3" />;
}

/**
 * "+" in an Ask header: a new chat pushed over the view, its box focused. Back
 * from it hands focus back here (`data-ask-focus`).
 */
export function NewChatButton({ surface = 'desktop' }: { surface?: AskSurface }) {
  return (
    <button
      type="button"
      data-testid="ask-new-chat"
      data-ask-focus="new-chat"
      aria-label="New chat"
      title="New chat"
      onClick={() => newChat(surface === 'phone', { returnFocus: 'new-chat' })}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Plus className="size-4" aria-hidden />
    </button>
  );
}
