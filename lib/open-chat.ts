import { useSyncExternalStore } from 'react';
import { getAICapabilities, useAICapabilities } from './ai-connection-store';
import { resolveConversationId, useConversationsStore } from './conversations-store';
import { useMobileNavStore } from './mobile-nav-store';
import { useProposalStore, type ProposalSurface } from './proposal-store';
import {
  bindingKey,
  focusIsInRail,
  railModeNow,
  usePanelOverlays,
  useRailMode,
  useRailStore,
  type AskSurface,
  type AskView,
  type ComposerBinding,
} from './rail-store';
import { closeItemPanel, openEditFor, useUIStore } from './ui-store';
import { usePlannerStore } from './planner-store';
import { useViewStore } from './view-store';
import type { Task } from './planner-types';

export { bindingKey, type ComposerBinding } from './rail-store';

/** The rail belongs to the desktop shell, which Zen replaces: an answer must never stream into an unmounted rail. */
function leaveZen(): void {
  const view = useViewStore.getState();
  if (view.zenOpen) view.setZenOpen(false);
}

/**
 * Opens Ask iff something can answer (`getAICapabilities().canChat`).
 *
 * Desktop: leaves Zen, then summons the rail with its box focused: `askOpen`
 * (persisted), `summoned` (so it shows as an overlay at or below 1180px too)
 * and a focus request the box consumes when it mounts. Because all three
 * outlive a client navigation, the settings buttons that call this and then go
 * to `/` land on Ask with the caret in its box. An item open on top stays on
 * top, with Ask under it. Mobile: the chat tab. Returns whether it opened, so
 * a caller (a command, the catch-up card, the settings no-results button) can
 * do something else when there is nothing to open: an open into a surface
 * that is hidden is a button that does nothing.
 */
export function revealChat(isMobile: boolean): boolean {
  if (!getAICapabilities().canChat) return false;
  if (isMobile) {
    useMobileNavStore.getState().setActiveTab('chat');
  } else {
    leaveZen();
    useRailStore.getState().summon({ focus: true });
  }
  return true;
}

/**
 * Ctrl+J (`toggle_right_sidebar`). Hidden, or in Zen: leave Zen and summon Ask
 * with its box focused. Showing: close it, and an item on top with it, through
 * the one flushing close (lib/ui-store.ts closeItemPanel), so a row the click
 * selected lets go and a title typed a moment ago is saved now. Closed stays
 * closed until something opens it again. With nothing to answer it does
 * nothing; the shortcut is consumed before it gets here anyway.
 */
export function toggleRail(): void {
  if (!getAICapabilities().canChat) return;
  const mode = railModeNow();
  if (mode === 'hidden') {
    leaveZen();
    useRailStore.getState().summon({ focus: true });
    return;
  }
  if (mode === 'item') closeItemPanel();
  useRailStore.getState().closeRail();
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
 * Whether chat's card has something to show (for the catch-up hosts): the
 * catch-up card ('chat'), or a conversation's own plan (`conv:<id>`). Both
 * outlive the gate: a key turned down mid-review, or the model marked failing,
 * unmounts Ask and every conversation view with it, and the card is then the
 * dock's to carry (components/ai/proposal-card.tsx). An `item:` card is the
 * item's, never the dock's.
 */
export function useChatHostCard(): boolean {
  return useProposalStore((s) => {
    if (s.status === 'idle') return false;
    const surface = s.lastRequest?.surface;
    return surface === undefined || surface === 'chat' || surface.startsWith('conv:');
  });
}

/**
 * The surface for chat's ONE card in a host that carries it (MobileChatPanel
 * and the docks' catch-up hosts): a conversation's own plan while that is what
 * was asked, else the catch-up card's 'chat'. One mount, not two side by side:
 * a card with no request to match (the "nothing left to apply" after an
 * accept) renders on every mount, and two would show it twice. Both surfaces
 * are exempt from the unmount-dismiss, so the prop flipping between them drops
 * nothing.
 */
export function useChatCardSurface(): ProposalSurface {
  return useProposalStore((s): ProposalSurface => {
    const surface = s.lastRequest?.surface;
    return surface?.startsWith('conv:') ? surface : 'chat';
  });
}

/**
 * True while Ask home is what the surface shows: desktop, the rail shows Ask
 * with nothing pushed; phone, the Ask tab is active, something answers, and
 * nothing is pushed. (The gate term is the phone's: the shell shows Today for
 * a chat tab that cannot answer, so without it a closed gate would leave the
 * catch-up card with no host.)
 */
export function useAskHomeShown(surface: AskSurface): boolean {
  const mode = useRailMode(usePanelOverlays());
  const { canChat } = useAICapabilities();
  const onTab = useMobileNavStore((s) => s.activeTab === 'chat');
  const atHome = useRailStore((s) => s.stacks[surface].length === 0);
  return surface === 'desktop' ? mode === 'ask' && atHome : onTab && canChat && atHome;
}

/**
 * Whether the card a catch-up host would carry (useChatCardSurface) is already
 * on screen in its own home, so the host yields and the card never renders
 * twice. The catch-up card's home is Ask home (D12's rule); a conversation's
 * plan's home is that conversation's view, on top of the shown rail. False
 * whenever nothing can answer, which is what keeps EITHER card in the dock
 * when the gate closes under it. The docks use it as
 * `hostCard && !homeShown && (!canChat || hosting)`, keeping their latch.
 */
export function useChatCardHomeShown(surface: AskSurface): boolean {
  const cardSurface = useChatCardSurface();
  const askHome = useAskHomeShown(surface);
  const mode = useRailMode(usePanelOverlays());
  const { canChat } = useAICapabilities();
  const onTab = useMobileNavStore((s) => s.activeTab === 'chat');
  const top = useRailStore((s) => {
    const view = s.stacks[surface].at(-1);
    return view?.kind === 'conversation' ? view.id : null;
  });
  if (cardSurface === 'chat') return askHome;
  if (surface === 'desktop') return mode === 'ask' && cardSurface === `conv:${top}`;
  // C2–C4: the phone's chat tab is still MobileChatPanel, which shows chat's
  // one card whatever its conversation. C5 (the Ask tab) makes this the
  // desktop rule over the phone stack.
  return onTab && canChat;
}

// ── Where a send goes ────────────────────────────────────────────────────────
//
// The one place that decides which conversation a composer's text lands in,
// and whether a view is pushed to show it. Every composer calls sendFrom; the
// store's send never chooses a thread.

/**
 * C1–C4 only: the one conversation the old single-thread panels
 * (MobileChatPanel, and the ChatConversation and ChatComposer inside it) bind
 * to, as `{kind:'conversation', id: generalThreadId()}`. The desktop's
 * ChatPanel went in C2 (Ask is in the rail); this goes in C5 with the last of
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
 * A send that pushes a conversation hands focus to that conversation's box
 * (the box that sent is about to unmount) when focus is the rail's to move:
 * `focus` asks for it outright (the command bar, whose own box is elsewhere),
 * or a summon's request is still pending, or focus was in the rail or lost.
 * A send from the canvas's own controls never moves it.
 *
 * `contextItemIds` is the 2c seam (several items as context); unread for now.
 */
export async function sendFrom(
  binding: ComposerBinding,
  text: string,
  o: { surface?: AskSurface; returnTo?: { itemId: string }; focus?: boolean; contextItemIds?: string[] } = {}
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
    if (push) {
      const rail = useRailStore.getState();
      const wantsFocus = o.focus || rail.pendingFocus?.target === 'composer' || focusIsInRail();
      rail.push(o.surface ?? 'desktop', push);
      if (wantsFocus && push.kind === 'conversation') rail.focusComposer({ kind: 'conversation', id: push.id });
    }
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
 * new conversation, titled `title` (the chip's label, not its long prompt),
 * pushed on the rail with its box focused. An item open on top is closed
 * first, through the one flushing close, or the answer would stream in under
 * it where nobody sees it.
 *
 * The phone, until C5: its chat tab still shows the general conversation
 * (MobileChatPanel), so the fresh conversation becomes that one instead.
 */
export function askNew(text: string, o: { title: string; isMobile: boolean }): void {
  if (!revealChat(o.isMobile)) return;
  const id = useConversationsStore.getState().newDraft({ title: o.title });
  if (o.isMobile) {
    setGeneral(id);
    void sendFrom({ kind: 'conversation', id }, text, { surface: 'phone' });
    return;
  }
  closeItemPanel();
  const rail = useRailStore.getState();
  rail.push('desktop', { kind: 'conversation', id });
  rail.focusComposer({ kind: 'draft', id });
  void sendFrom({ kind: 'draft', id }, text, { surface: 'desktop' });
}

/**
 * Open a saved conversation from a row that names it: an activity row on Ask
 * home now, History's rows and a deep link later (this is the seam a URL per
 * conversation would call).
 *
 * An item's conversation is the item's: while the item exists this opens the
 * item, on its Conversation section (`pendingReveal`, which the item's pinned
 * conversation consumes on mount and scrolls only the rail body to), over
 * whatever Ask view is showing, so Back returns there. A general conversation,
 * or one whose item is gone, is pushed, its transcript fetched if this browser
 * has not read it, and Back returns focus to the row (`returnFocus`, the row's
 * `data-ask-focus="conv:<id>"`). Nothing focuses the box: a row is not a
 * request to type.
 *
 * The phone, until C5: its chat tab still shows the general conversation
 * (MobileChatPanel), so a general conversation becomes that one, as `askNew`
 * does there, and an item opens in the drawer, as every phone open does.
 */
export function openConversation(id: string, isMobile: boolean): void {
  if (!getAICapabilities().canChat) return;
  const store = useConversationsStore.getState();
  const rid = resolveConversationId(id);
  const itemId = store.summaries[rid]?.itemId ?? store.threads[rid]?.itemId ?? null;
  const item = itemId ? usePlannerStore.getState().items.find((i) => i.id === itemId) : undefined;

  if (item) {
    if (!isMobile) {
      leaveZen();
      useRailStore.getState().setPendingReveal(item.id);
    }
    openEditFor(item as unknown as Task, item.type === 'habit' ? 'habit' : 'task');
    return;
  }

  if (isMobile) {
    if (!revealChat(true)) return;
    setGeneral(rid);
    void store.openThread(rid);
    return;
  }
  leaveZen();
  if (useUIStore.getState().activeDialog?.type === 'edit-item') closeItemPanel();
  const rail = useRailStore.getState();
  if (railModeNow() !== 'ask') rail.summon();
  rail.push('desktop', { kind: 'conversation', id: rid, returnFocus: `conv:${rid}` });
  void store.openThread(rid);
}

/**
 * "?" in the command bar: the docked omnibar, the Ctrl+K launcher, Console's
 * prompt and Notepad's caret alike (and Ctrl+Enter there). An empty ask only
 * opens Ask, as it always has. Otherwise, by what is on screen:
 *   - an item is open under the bar (in the slot, or the one the launcher
 *     displaced when it opened): close it, and ask in a NEW conversation that
 *     goes back to it ("‹ Book the dentist"). The item is never thrown away.
 *   - the phone shows an item pushed over Ask: the same, over that item.
 *   - a conversation is on screen: continue it, or, while it is still
 *     answering, leave the text in its box to send when it is done.
 *   - otherwise: a new conversation, pushed.
 * "On screen" is read BEFORE revealChat makes it true: a conversation left on
 * the stack while the rail was closed (or, on the phone, while another tab was
 * active) may be hours old, so a new `?` starts a new one rather than silently
 * continuing it.
 */
export function askFromCommandBar(text: string, isMobile: boolean): void {
  if (!text.trim()) {
    revealChat(isMobile);
    return;
  }
  // C2–C4 only: the phone's chat tab still shows the general conversation
  // (MobileChatPanel), not the phone stack, so a `?` there continues it. C5's
  // Ask tab shows the stack: this block goes with generalThreadId(), and the
  // phone branches below (written for it now) take over.
  if (isMobile) {
    if (!revealChat(true)) return;
    void sendFrom({ kind: 'conversation', id: generalThreadId() }, text, { surface: 'phone' });
    return;
  }
  const surface: AskSurface = isMobile ? 'phone' : 'desktop';
  const wasShowing = isMobile ? useMobileNavStore.getState().activeTab === 'chat' : railModeNow() === 'ask';
  const ui = useUIStore.getState();
  const itemId = !isMobile
    ? ui.activeDialog?.type === 'edit-item'
      ? ui.activeDialog.item.id
      : ui.displacedItemId
    : null;
  if (!revealChat(isMobile)) return;
  const top = useRailStore.getState().stacks[surface].at(-1);
  if (itemId) {
    if (useUIStore.getState().activeDialog?.type === 'edit-item') closeItemPanel();
    void sendFrom({ kind: 'home' }, text, { surface, returnTo: { itemId }, focus: true });
  } else if (top?.kind === 'item' && wasShowing) {
    void sendFrom({ kind: 'home' }, text, { surface, returnTo: { itemId: top.itemId }, focus: true });
  } else if (
    top?.kind === 'conversation' &&
    wasShowing &&
    useConversationsStore.getState().threads[resolveConversationId(top.id)]?.load !== 'gone'
  ) {
    const binding: ComposerBinding = { kind: 'conversation', id: top.id };
    const rail = useRailStore.getState();
    rail.focusComposer(binding);
    // Still answering: sendFrom would refuse, and the bar has already cleared
    // itself, so the text would be lost. It waits in that conversation's box
    // instead, under anything already typed there, for the user to send.
    const conversations = useConversationsStore.getState();
    const key = bindingKey(binding);
    if (conversations.threads[resolveConversationId(top.id)]?.streaming || conversations.sending[key]) {
      const typed = rail.drafts[key];
      rail.setDraft(key, typed ? `${typed}\n${text}` : text);
      return;
    }
    void sendFrom(binding, text, { surface });
  } else {
    void sendFrom({ kind: 'home' }, text, { surface, focus: true });
  }
}
