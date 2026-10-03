import { useMemo } from 'react';
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
import { chatPlaceholder, itemChatPlaceholder } from './chat-utils';
import type { Item, Task } from './planner-types';

export { bindingKey, type ComposerBinding } from './rail-store';

/** The rail belongs to the desktop shell, which Zen replaces: an answer must never stream into an unmounted rail. */
function leaveZen(): void {
  const view = useViewStore.getState();
  if (view.zenOpen) view.setZenOpen(false);
}

/** The phone's Ask tab, shown with nothing asked of the box (a row is not a request to type). */
function showAskTab(): void {
  useMobileNavStore.getState().setActiveTab('chat');
}

/**
 * Opens Ask iff something can answer (`getAICapabilities().canChat`).
 *
 * Desktop: leaves Zen, then summons the rail with its box focused: `askOpen`
 * (persisted), `summoned` (so it shows as an overlay below 1180px too)
 * and a focus request the box consumes when it mounts. Because all three
 * outlive a client navigation, the settings buttons that call this and then go
 * to `/` land on Ask with the caret in its box. An item open on top stays on
 * top, with Ask under it. Mobile: the Ask tab, with the dock's box asked for
 * (an explicit open, unlike arriving by the sheet or a swipe). Returns whether
 * it opened, so a caller (a command, the catch-up card, the settings
 * no-results button) can do something else when there is nothing to open: an
 * open into a surface that is hidden is a button that does nothing.
 *
 * `boxOnPhone: false` asks for no box on the phone, for an open that lands on
 * something to tap rather than type into (catch-up's card): there the box's
 * keyboard would cover what the open came to show. Desktop has no keyboard to
 * raise, so it always asks.
 */
export function revealChat(isMobile: boolean, o: { boxOnPhone?: boolean } = {}): boolean {
  if (!getAICapabilities().canChat) return false;
  if (isMobile) {
    showAskTab();
    if (o.boxOnPhone !== false) useRailStore.getState().focusComposer();
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
 * The surface for chat's ONE card in a host that carries it (the docks'
 * catch-up hosts): a conversation's own plan while that is what was asked,
 * else the catch-up card's 'chat'. One mount, not two side by side:
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
 * twice. The catch-up card's home is Ask home; a conversation's
 * plan's home is that conversation's view, on top of the shown rail or the
 * phone's Ask tab. False whenever nothing can answer, which is what keeps
 * EITHER card in the dock when the gate closes under it. The docks use it as
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
  const shown = surface === 'desktop' ? mode === 'ask' : onTab && canChat;
  return shown && top !== null && cardSurface === `conv:${resolveConversationId(top)}`;
}

/** What the phone dock's box sends into, and what it says (usePhoneComposerBinding). */
export interface PhoneComposer {
  binding: ComposerBinding;
  placeholder: string;
}

const PHONE_HOME: ComposerBinding = { kind: 'home' };

/**
 * The phone's one box is the dock's (components/mobile/mobile-bottom-dock.tsx),
 * under every view of the Ask tab, so it follows the top of `stacks.phone`:
 *   home, History  a new conversation, pushed: "Ask anything…" ("Message
 *                  OpenClaw…" when OpenClaw answers)
 *   conversation   that one: "Reply…". A new chat's draft has nothing to reply
 *                  to yet, and one deleted elsewhere sends to a new conversation
 *                  (which replaces it), so both keep the plain wording, as the
 *                  rail's conversation view does.
 *   item           the item's one conversation: "Ask about this item…"
 * The binding is one object per view, so the box's effects run when it moves
 * and never because something else re-rendered.
 */
export function usePhoneComposerBinding(): PhoneComposer {
  const top = useRailStore((s) => {
    const view = s.stacks.phone.at(-1);
    if (view?.kind === 'conversation') return `conv:${view.id}`;
    if (view?.kind === 'item') return `item:${view.itemId}`;
    return 'home';
  });
  const conversation = useConversationsStore((s): 'said' | 'new' | 'gone' | null => {
    if (!top.startsWith('conv:')) return null;
    const id = resolveConversationId(top.slice(5));
    const t = s.threads[id];
    if (t?.load === 'gone') return 'gone';
    return (t && t.messages.length > 0) || s.summaries[id] || t?.saved ? 'said' : 'new';
  });
  const { target } = useAICapabilities();
  return useMemo(() => {
    if (top.startsWith('item:')) {
      return { binding: { kind: 'item', itemId: top.slice(5) }, placeholder: itemChatPlaceholder(target) };
    }
    if (top.startsWith('conv:') && conversation !== 'gone') {
      return {
        binding: { kind: 'conversation', id: resolveConversationId(top.slice(5)) },
        placeholder: conversation === 'said' ? 'Reply…' : chatPlaceholder(target),
      };
    }
    return { binding: PHONE_HOME, placeholder: chatPlaceholder(target) };
  }, [top, conversation, target]);
}

// ── Opening what Ask holds ───────────────────────────────────────────────────

/**
 * An item opened from inside Ask (a Needs-you title, an activity row, an
 * item's conversation from History or an activity row): `openEditFor`, and
 * when focus was Ask's, the item takes it. Ask goes hidden and inert under
 * the item with the control that opened it, which would leave focus on
 * <body> and send the next Tab to the top of the document (rail-store's
 * `back` does the same for an item reopened by Back).
 *
 * The hand-off waits a tick: ItemDialog notes the control that opened it in
 * the open's own commit, and its return on close (Back, Escape) hands focus
 * back there; the panel focused in the same commit would be noted instead,
 * and the return would land nowhere.
 */
export function openItemFromAsk(item: Item): void {
  const handBack = focusIsInRail();
  openEditFor(item as unknown as Task, item.type === 'habit' ? 'habit' : 'task');
  if (!handBack) return;
  setTimeout(() => {
    if (focusIsInRail()) useUIStore.getState().focusItemPanel();
  }, 0);
}

/**
 * Show Ask from a command (the palette), with whatever was on top of it closed
 * through the one flushing close, so the view about to be pushed is the one on
 * screen. False when nothing can answer.
 */
function revealForCommand(isMobile: boolean): boolean {
  if (!revealChat(isMobile)) return false;
  if (!isMobile) closeItemPanel();
  return true;
}

/**
 * A new chat: a draft pushed over what Ask shows, with its box asked for. It
 * has no row until its first turn is saved, so leaving it unsent leaves
 * nothing behind. "+" in an Ask header pushes it in place (`returnFocus`: the
 * "+" itself, so Back hands focus back to it); the palette's "New chat" shows
 * Ask first (`reveal`). Returns the draft's id, or null with nothing to answer.
 */
export function newChat(isMobile: boolean, o: { reveal?: boolean; returnFocus?: string } = {}): string | null {
  if (o.reveal ? !revealForCommand(isMobile) : !getAICapabilities().canChat) return null;
  const id = useConversationsStore.getState().newDraft();
  const rail = useRailStore.getState();
  const view: AskView = o.returnFocus
    ? { kind: 'conversation', id, returnFocus: o.returnFocus }
    : { kind: 'conversation', id };
  rail.push(isMobile ? 'phone' : 'desktop', view);
  rail.focusComposer({ kind: 'draft', id });
  return id;
}

/**
 * History, pushed over what Ask shows. The header's History button pushes it
 * in place, and focus lands on its heading (a pointer open); the palette's
 * "Conversation history" shows Ask first and asks for the search field.
 */
export function openHistory(
  isMobile: boolean,
  o: { reveal?: boolean; focusSearch?: boolean; returnFocus?: string } = {}
): void {
  if (o.reveal ? !revealForCommand(isMobile) : !getAICapabilities().canChat) return;
  const rail = useRailStore.getState();
  const view: AskView = o.returnFocus ? { kind: 'history', returnFocus: o.returnFocus } : { kind: 'history' };
  rail.push(isMobile ? 'phone' : 'desktop', view);
  // Replaces the box request a reveal makes: History has no box.
  if (o.focusSearch) rail.requestFocus({ target: 'history-search' });
}

/**
 * Open a saved conversation from a row that names it: a History row, a
 * conversation row in Ask home's activity list, and the seam a deep link to a
 * conversation would call. Safe from anywhere: on desktop it leaves Zen, closes
 * an item on top through the one flushing close and summons Ask when it is not
 * showing.
 *
 *  - An ITEM's conversation opens its item, landing on the item's Conversation
 *    section, with a reveal request (`pendingReveal`, which the item's
 *    conversation consumes on mount and scrolls only its scroller to). On
 *    desktop the item takes the slot over whatever Ask view is showing, so
 *    Back returns there; on the phone it is pushed over the Ask tab's view
 *    (`{kind:'item'}`), the row that opened it named as for a conversation.
 *  - A general conversation, or an item's whose item is gone, is pushed, the
 *    row that opened it named in `returnFocus` so Back hands focus back to it.
 *    The view fetches its transcript if this browser has not read it, and says
 *    when the item is gone; the conversation can still go on, with no item to
 *    focus its context on. Nothing focuses the box: a row is not a request to
 *    type.
 */
export function openConversation(id: string, isMobile: boolean, o: { returnFocus?: string } = {}): void {
  if (!getAICapabilities().canChat) return;
  const rid = resolveConversationId(id);
  const conversations = useConversationsStore.getState();
  const itemId = conversations.summaries[rid]?.itemId ?? conversations.threads[rid]?.itemId ?? null;
  const item = itemId ? usePlannerStore.getState().items.find((i) => i.id === itemId) : undefined;

  if (isMobile) {
    showAskTab();
    const rail = useRailStore.getState();
    if (item) rail.setPendingReveal(item.id);
    const view: AskView = item ? { kind: 'item', itemId: item.id } : { kind: 'conversation', id: rid };
    rail.push('phone', o.returnFocus ? { ...view, returnFocus: o.returnFocus } : view);
    return;
  }

  if (item) {
    leaveZen();
    useRailStore.getState().setPendingReveal(item.id);
    openItemFromAsk(item);
    return;
  }

  leaveZen();
  if (useUIStore.getState().activeDialog?.type === 'edit-item') closeItemPanel();
  const rail = useRailStore.getState();
  if (railModeNow() !== 'ask') rail.summon();
  rail.push(
    'desktop',
    o.returnFocus ? { kind: 'conversation', id: rid, returnFocus: o.returnFocus } : { kind: 'conversation', id: rid }
  );
}

// ── Where a send goes ────────────────────────────────────────────────────────
//
// The one place that decides which conversation a composer's text lands in,
// and whether a view is pushed to show it. Every composer calls sendFrom; the
// store's send never chooses a thread.

/**
 * The conversation a binding sends into, and the view to push for it:
 *   home          a new draft, pushed (with `returnTo` for "?" over an item)
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
 * pushed on the rail (the phone: its Ask tab) with its box asked for. An item
 * open on top on desktop is closed first, through the one flushing close, or
 * the answer would stream in under it where nobody sees it; the phone's item
 * is a view on the same stack, which the push replaces (the level rule).
 */
export function askNew(text: string, o: { title: string; isMobile: boolean }): void {
  if (!revealChat(o.isMobile)) return;
  const id = useConversationsStore.getState().newDraft({ title: o.title });
  const surface: AskSurface = o.isMobile ? 'phone' : 'desktop';
  if (!o.isMobile) closeItemPanel();
  const rail = useRailStore.getState();
  rail.push(surface, { kind: 'conversation', id });
  rail.focusComposer({ kind: 'draft', id });
  void sendFrom({ kind: 'draft', id }, text, { surface });
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
