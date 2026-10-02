import { useSyncExternalStore } from 'react';
import { getAICapabilities } from './ai-connection-store';
import { resolveConversationId, useConversationsStore } from './conversations-store';
import { revealDock } from './look-store';
import { useMobileNavStore } from './mobile-nav-store';
import { useProposalStore, type ProposalSurface } from './proposal-store';
import { bindingKey, useRailStore, type AskSurface, type AskView, type ComposerBinding } from './rail-store';
import { useSidebarStore } from './sidebar-store';

export { bindingKey, type ComposerBinding } from './rail-store';

/**
 * Opens the chat surface iff something can answer (`getAICapabilities().canChat`).
 *
 * Desktop: the dock, revealed (`revealDock`, which opens the left sidebar
 * unless the layout lays the dock across the bottom), with chat expanded.
 * Mobile: the chat tab. Returns
 * whether it opened, so a caller (a command, the catch-up card, the settings
 * no-results button) can do something else when chat is not there to open —
 * an open into a surface that is hidden is a button that does nothing.
 */
export function revealChat(isMobile: boolean): boolean {
  if (!getAICapabilities().canChat) return false;
  if (isMobile) {
    useMobileNavStore.getState().setActiveTab('chat');
  } else {
    revealDock();
    useSidebarStore.getState().setChatExpanded(true);
  }
  return true;
}

/**
 * Exactly ProposalCard's own render rule (components/ai/proposal-card.tsx):
 * not idle, and the request came from this surface (or names none). Pure.
 *
 * The catch-up hosts mount their box only when this is true, so a host with
 * nothing to show takes no space; a test pins it to ProposalCard's behaviour.
 */
export function proposalCardShowsOn(
  s: { status: string; lastRequest: { surface: ProposalSurface } | null },
  surface: ProposalSurface
): boolean {
  if (s.status === 'idle') return false;
  const requestSurface = s.lastRequest?.surface;
  return requestSurface === undefined || requestSurface === surface;
}

/**
 * Whether the chat surface's card has something to show (for the catch-up
 * hosts): the catch-up card's, or the general conversation's own plan
 * (`conv:<id>`). Both outlive the gate: a key turned down mid-review, or the
 * model marked failing, leaves the card to the dock's host once chat is gone
 * (components/ai/proposal-card.tsx).
 */
export function useChatHostCard(): boolean {
  const general = useGeneralThreadId();
  return useProposalStore(
    (s) => proposalCardShowsOn(s, 'chat') || (general !== '' && proposalCardShowsOn(s, `conv:${general}`))
  );
}

/**
 * The surface for the chat slot's ONE card (ChatPanel, MobileChatPanel and
 * the docks' catch-up hosts): the general conversation's own plan while that
 * is what was asked, else the catch-up card's 'chat'. One mount, not two side
 * by side: a card with no request to match (the "nothing left to apply" after
 * an accept) renders on every mount, and two would show it twice. Both
 * surfaces are exempt from the unmount-dismiss, so the prop flipping between
 * them drops nothing.
 */
export function useChatCardSurface(): ProposalSurface {
  const general = useGeneralThreadId();
  return useProposalStore((s): ProposalSurface =>
    general !== '' && s.lastRequest?.surface === `conv:${general}` ? `conv:${general}` : 'chat'
  );
}

// ── Where a send goes ────────────────────────────────────────────────────────
//
// The one place that decides which conversation a composer's text lands in,
// and whether a view is pushed to show it. Every composer calls sendFrom; the
// store's send never chooses a thread.

/**
 * C1–C4 only: the one conversation the old single-thread panels (ChatPanel,
 * ChatConversation, ChatComposer, MobileChatPanel) bind to, as
 * `{kind:'conversation', id: generalThreadId()}`. Goes in C5 with the last of
 * them.
 *
 * Memory only. The id is minted here WITHOUT a store write, so a render may
 * read it; the thread comes into being on its first send, which saves it with
 * `create`, a real saved conversation. A new one is minted when the store
 * resets (sign-out, an account switch), when this one is deleted or found gone
 * (a 404), and by `resetGeneralThread()` (chooseChatTarget).
 */
let general: string | null = null;
const generalListeners = new Set<() => void>();

/**
 * The general conversation is the old panels' one conversation on screen, so
 * replacing it is that conversation leaving, and a plan card it asked for
 * (`conv:<id>`) goes with it: rail-store's rule for a conversation that leaves
 * both Ask stacks, applied to the one the panels show.
 */
function setGeneral(id: string | null): void {
  const prev = general === null ? null : resolveConversationId(general);
  general = id;
  if (prev !== null && prev !== id) {
    const proposals = useProposalStore.getState();
    if (proposals.lastRequest?.surface === `conv:${prev}`) proposals.dismiss();
  }
  for (const l of generalListeners) l();
}

export function generalThreadId(): string {
  if (general === null) general = crypto.randomUUID();
  return resolveConversationId(general);
}

/** A fresh general conversation from the next send on (chooseChatTarget). */
export function resetGeneralThread(): void {
  setGeneral(null);
}

/** The general conversation, as a render reads it: re-renders when it is re-minted. */
export function useGeneralThreadId(): string {
  return useSyncExternalStore(
    (onChange) => {
      generalListeners.add(onChange);
      return () => generalListeners.delete(onChange);
    },
    generalThreadId,
    // Module state on the server would be shared by every request.
    () => ''
  );
}

// The general conversation follows the cache: a reset, a delete or a 404 ends it.
useConversationsStore.subscribe((s, prev) => {
  if (general === null) return;
  const id = resolveConversationId(general);
  if (s.generation !== prev.generation || (prev.threads[id] && !s.threads[id]) || s.threads[id]?.load === 'gone') {
    setGeneral(null);
  }
});

/**
 * The conversation a binding sends into, and the view to push for it:
 *   home          a new draft, pushed (with `returnTo`: "?" over an item, D10)
 *   draft         that draft, already on screen
 *   conversation  that conversation
 *   item          the item's one conversation (resolveItemThread), no push
 * Async because an item's conversation may have to be asked for.
 */
export async function resolveSendTarget(
  binding: ComposerBinding,
  surface: AskSurface,
  returnTo?: { itemId: string }
): Promise<{ threadId: string; push?: AskView }> {
  const store = useConversationsStore.getState();
  switch (binding.kind) {
    case 'home': {
      const id = store.newDraft();
      const view: AskView = returnTo ? { kind: 'conversation', id, returnTo } : { kind: 'conversation', id };
      return { threadId: id, push: view };
    }
    case 'item':
      return { threadId: await store.resolveItemThread(binding.itemId) };
    default:
      return { threadId: resolveConversationId(binding.id) };
  }
}

/**
 * Send from a composer. The binding is marked sending first, synchronously, so
 * a second send in the same tick (or during an item's lookup) is a no-op and
 * the composer shows Stop at once; the mark clears once the thread's own
 * streaming state has taken over, on every exit.
 *
 * `contextItemIds` is the 2c seam (several items as context); unread for now.
 */
export async function sendFrom(
  binding: ComposerBinding,
  text: string,
  o: { surface?: AskSurface; returnTo?: { itemId: string }; contextItemIds?: string[] } = {}
): Promise<void> {
  if (!getAICapabilities().canChat || typeof text !== 'string' || !text.trim()) return;
  const store = useConversationsStore.getState();
  const key = bindingKey(binding);
  if (!store.beginSend(key)) return;
  let sending: Promise<void> | null = null;
  try {
    store.ensureOwner();
    const { threadId, push } = await resolveSendTarget(binding, o.surface ?? 'desktop', o.returnTo);
    // A saved conversation this browser has not read yet (an item's, found a
    // moment ago, or its read still on the way): its transcript first, so the
    // model hears what was said before and the new turn lands under it. An
    // open already in flight is joined, not repeated; the mark above keeps the
    // composer busy meanwhile.
    const before = useConversationsStore.getState().threads[threadId];
    if (before?.saved && before.load !== 'loaded') await useConversationsStore.getState().openThread(threadId);
    const thread = useConversationsStore.getState().threads[threadId];
    if (thread?.streaming) return;
    if (push) useRailStore.getState().push(o.surface ?? 'desktop', push);
    // send's synchronous half appends both messages and marks the thread
    // streaming before it first awaits.
    sending = useConversationsStore.getState().send(threadId, text);
  } catch {
    // A lookup never rejects, and send never throws: nothing to tell.
  } finally {
    useConversationsStore.getState().endSend(key);
  }
  if (sending) await sending;
}

/**
 * Start a fresh conversation with this text: a chip, "Plan my day". Always a
 * new conversation, titled `title`.
 *
 * C1 form: the old panel shows the general conversation, so the fresh one
 * becomes it. (C2 pushes it on the rail's stack instead.)
 */
export function askNew(text: string, o: { title: string; isMobile: boolean }): void {
  if (!revealChat(o.isMobile)) return;
  const id = useConversationsStore.getState().newDraft({ title: o.title });
  setGeneral(id);
  void sendFrom({ kind: 'conversation', id }, text);
}

/**
 * "?" in the command bar, the docked omnibar and the Ctrl+K launcher alike.
 * An empty ask only opens chat.
 *
 * C1 form: open chat as today, then send into the general conversation. (C2
 * routes by what is on screen: D10.)
 */
export function askFromCommandBar(text: string, isMobile: boolean): void {
  if (!revealChat(isMobile)) return;
  if (!text.trim()) return;
  void sendFrom({ kind: 'conversation', id: generalThreadId() }, text);
}
