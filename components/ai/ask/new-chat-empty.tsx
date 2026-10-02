'use client';

import { useMemo } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { useSessionUserStore } from '@/lib/session-user-store';
import { useNowMinutes } from '@/lib/use-now-minutes';
import { buildChatOpeners, type ChatOpener, type OpenerContext } from '@/lib/ai-openers';
import { inactiveItemIdsOn } from '@/lib/active';
import { toDateStr } from '@/lib/recurrence';
import { askNew, newChat } from '@/lib/open-chat';
import { bindingKey, useRailStore, type AskSurface, type ComposerBinding } from '@/lib/rail-store';

/**
 * A new chat with nothing said yet: Claude's empty state (the Full Chat page,
 * mock 6). Centred in the column, top to bottom: the spark, the greeting in
 * serif, "How can I help?", then the box (ConversationView's own, kept mounted
 * in place so the caret survives the first send), the model label, and four
 * chips. The first send swaps all of this for the transcript, and the box
 * settles at the foot.
 *
 * A draft has no row until its first turn is saved, so a new chat left unsent
 * leaves nothing behind.
 */

// ── SEAM (C3) ────────────────────────────────────────────────────────────────
// Checkpoint C3 gives lib/ai-openers.ts options, and lib/ask-home.ts the
// greeting. At the merge:
//   - `newChatOpeners` becomes the one call
//       buildChatOpeners(ctx, { max: NEW_CHAT_OPENERS, minutesNow, includeStart: true })
//     which returns all four chips, "Help me start…" included (its `start`
//     candidate, `mode: 'prefill'`); HELP_ME_START and NEW_CHAT_CHIPS go;
//   - `newChatGreeting` becomes lib/ask-home.ts `greeting(minutes, displayName)`.
// Until then both follow D8's rules with today's buildChatOpeners(ctx).

/** A chip that sends, or ("Help me start…") one that only fills the box. */
export type NewChatOpener = ChatOpener & { mode?: 'send' | 'prefill' };

/** Mock 6: three openers drawn from today, then "Help me start…" as a fourth. */
const NEW_CHAT_CHIPS = 3;

/** Fills the box and puts the caret after it; sends nothing. */
export const HELP_ME_START: Readonly<NewChatOpener> = {
  id: 'start',
  label: 'Help me start…',
  prompt: 'Help me start ',
  mode: 'prefill',
};

export function newChatOpeners(ctx: OpenerContext): NewChatOpener[] {
  return [...buildChatOpeners(ctx).slice(0, NEW_CHAT_CHIPS), HELP_ME_START];
}

/** 04:00–11:59 morning, 12:00–16:59 afternoon, otherwise evening; the name's first word, kept short. */
export function newChatGreeting(minutes: number | null, displayName: string | null): string {
  if (minutes === null) return 'Hello';
  const part = minutes >= 240 && minutes < 720 ? 'Morning' : minutes >= 720 && minutes < 1020 ? 'Afternoon' : 'Evening';
  const first = displayName?.trim().split(/\s+/)[0]?.slice(0, 24);
  return first ? `${part}, ${first}` : part;
}
// ── end SEAM ─────────────────────────────────────────────────────────────────

/** The spark, the greeting and the question, above the box. */
export function NewChatEmpty() {
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const minutes = useNowMinutes(userTimezone ?? undefined);
  const name = useSessionUserStore((s) => s.user?.displayName ?? null);

  return (
    <div
      data-testid="new-chat-empty"
      className="flex min-h-0 flex-1 flex-col items-center justify-end gap-1.5 px-6 pb-5 text-center"
    >
      <Sparkles className="mb-1 size-6 text-ai" aria-hidden />
      <p data-ask-greeting="" className="font-serif text-2xl text-foreground">
        {newChatGreeting(minutes, name)}
      </p>
      <p className="text-[15px] text-muted-foreground">How can I help?</p>
    </div>
  );
}

/**
 * The four chips under the centred box. A sending chip starts its conversation
 * titled with its label, not its long prompt (`askNew`); "Help me start…"
 * fills this draft's box instead and hands it the caret.
 */
export function NewChatChips({ binding, surface = 'desktop' }: { binding: ComposerBinding; surface?: AskSurface }) {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const userTimezone = usePlannerStore((s) => s.userTimezone);

  const openers = useMemo(() => {
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = toDateStr(new Date(), tz);
    return newChatOpeners({
      items,
      todayStr,
      userTimezone: tz,
      inactiveIds: inactiveItemIdsOn(items, todayStr, { userTimezone: tz, routines, seasons }),
    });
  }, [items, routines, seasons, userTimezone]);

  const choose = (opener: NewChatOpener) => {
    if (opener.mode === 'prefill') {
      const rail = useRailStore.getState();
      rail.setDraft(bindingKey(binding), opener.prompt);
      rail.focusComposer(binding);
      return;
    }
    askNew(opener.prompt, { title: opener.label, isMobile: surface === 'phone' });
  };

  return (
    <div data-testid="chat-openers" className="flex flex-wrap justify-center gap-1.5 px-5 pt-3">
      {openers.map((opener) => (
        <button
          key={opener.id}
          type="button"
          data-opener={opener.id}
          onClick={() => choose(opener)}
          className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-ai/40 hover:bg-muted"
        >
          {opener.label}
        </button>
      ))}
    </div>
  );
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
