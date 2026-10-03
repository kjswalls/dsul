'use client';

import { useEffect, useRef } from 'react';
import { AskHome } from '@/components/ai/ask/ask-home';
import { ConversationView } from '@/components/ai/ask/conversation-view';
import { ConversationTitleMenu } from '@/components/ai/ask/conversation-title-menu';
import { HistoryButton, HistoryView } from '@/components/ai/ask/history-view';
import { keepInView } from '@/components/ai/ask/keep-in-view';
import { NewChatButton } from '@/components/ai/ask/new-chat-empty';
import { ComposerAwakeContext } from '@/components/ai/bound-composer';
import {
  RailHeader,
  conversationHeaderAction,
  useBackLabel,
  useConversationHeader,
  useConversationTitle,
} from '@/components/ai/rail/rail-header';
import { resolveConversationId, useConversationsStore } from '@/lib/conversations-store';
import { focusIsInRail, useRailStore, type AskView } from '@/lib/rail-store';
import { cn } from '@/lib/utils';

/** One key per view, so the view host remounts (and slides) exactly when the top changes. */
function viewKeyOf(view: AskView | undefined): string {
  if (!view) return 'home';
  if (view.kind === 'conversation') return `conv:${view.id}`;
  if (view.kind === 'item') return `item:${view.itemId}`;
  return 'history';
}

/**
 * A field that keeps its own Escape: anything typed into, except an empty Ask
 * box and an empty History search, where Escape goes back a view.
 */
function ownsEscape(el: HTMLElement): boolean {
  const typing =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el.isContentEditable;
  if (!typing) return false;
  if (el instanceof HTMLInputElement && el.hasAttribute('data-ask-search')) return el.value !== '';
  return !(el instanceof HTMLTextAreaElement && el.closest('[data-ask-composer]') && !el.value.trim());
}

const back = () => useRailStore.getState().back('desktop');
const close = () => useRailStore.getState().closeRail();

/**
 * Ask in the right column: the desktop Ask stack (lib/rail-store.ts) under one
 * header, Ask home at the bottom of it.
 *
 * MOUNTED UNDER THE ITEM. DesktopShell's column keeps this mounted while an
 * item is on top (whenever something answers and Ask is open or summoned),
 * `hidden` and `inert`, so Back finds Ask exactly as it was: the view's scroll,
 * the box's text, a conversation's plan card and its in-flight reply, the
 * catch-up card's ticks, and the control that opened the item, which the
 * item's own focus return hands focus back to once this shows again. Hidden,
 * it takes no key, no focus request and no click.
 *
 * ESCAPE, while it shows, goes back a view; at home it parks an overlay and
 * does nothing to a docked Ask, which is a resting surface. It yields to
 * anything that consumed the key first (a Radix menu or confirm dismisses in
 * the capture phase and calls preventDefault; a box with text blurs and does
 * the same), to focus outside the rail, and to a field being typed in.
 *
 * FOCUS ACROSS A MOVE. A push or Back unmounts the view that held focus, which
 * would drop it to <body> and send the next Tab to the top of the document.
 * So when focus was the rail's (inside it, or lost), the new view's heading
 * takes it, or after a Back the control that pushed the view (`returnFocus`,
 * its `data-ask-focus` key). A send that pushed a conversation asked for that
 * conversation's box instead (a pending request), and a move made from the
 * canvas never moves focus at all. The same holds across the item boundary:
 * Back onto an item hands it focus (rail-store `back`), and Back from one
 * shows Ask with its heading focused if nothing else took it (below).
 */
export function RightRail({
  visible,
  leaving = false,
  overlays,
}: {
  visible: boolean;
  /**
   * Closing out of a docked column (DesktopShell's RailColumn): still painted
   * while the column eases shut, so the close slides it out as the open slid
   * it in, but `inert` and, like any hidden Ask, with none of its listeners.
   */
  leaving?: boolean;
  overlays: boolean;
}) {
  const top = useRailStore((s) => s.stacks.desktop.at(-1));
  const beneath = useRailStore((s) => s.stacks.desktop.at(-2));
  const lastNav = useRailStore((s) => s.lastNav);
  const backTo = useBackLabel(top ?? null, beneath);
  const conversationTitle = useConversationTitle(top?.kind === 'conversation' ? top.id : null);
  // How a conversation's header reads (rail-header.tsx, the phone's rule too).
  const conversationHeader = useConversationHeader(top);
  const asideRef = useRef<HTMLElement>(null);
  const viewKey = viewKeyOf(top);

  // The first AI surface on screen warms the conversation list (History's
  // first page); it never blocks, and never rejects.
  useEffect(() => {
    if (visible) void useConversationsStore.getState().ensureLoaded();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A popover or menu inside the rail owns Escape while it is up.
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && (!el.closest('[data-rail]') || ownsEscape(el))) return;
      const rail = useRailStore.getState();
      if (rail.stacks.desktop.length > 0) rail.back('desktop');
      else if (overlays) rail.park();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, overlays]);

  const shownKey = useRef(viewKey);
  const shownTop = useRef(top);
  useEffect(() => {
    const was = shownTop.current;
    const moved = shownKey.current !== viewKey;
    shownKey.current = viewKey;
    shownTop.current = top;
    if (!moved || !visible || !focusIsInRail()) return;
    if (useRailStore.getState().pendingFocus) return;
    const returnTo = useRailStore.getState().lastNav === 'back' ? was?.returnFocus : undefined;
    setTimeout(() => {
      const root = asideRef.current;
      // Only focus that is still lost: a box that took a request, or anything
      // the user moved to meanwhile, keeps it. The header's heading and its
      // back control count as lost: React keeps both from view to view, so a
      // Back pressed on either (Escape on the heading a push parked focus on;
      // a click or Enter on "‹ History") would otherwise leave focus there, on
      // a control that now names a different view, not on the one that pushed
      // the view Back left.
      const active = document.activeElement as HTMLElement | null;
      const parked =
        !!active &&
        !!root?.contains(active) &&
        (active.hasAttribute('data-ask-heading') || active.hasAttribute('data-rail-back'));
      if (!root || (active && active !== document.body && !parked)) return;
      const opener = returnTo
        ? Array.from(root.querySelectorAll<HTMLElement>('[data-ask-focus]')).find(
            (el) => el.dataset.askFocus === returnTo
          )
        : undefined;
      (opener ?? root.querySelector<HTMLElement>('[data-ask-heading]'))?.focus({ preventScroll: true });
      // History puts its list back where it was first; this is the backstop.
      if (opener) keepInView(opener);
    }, 0);
  }, [viewKey, top, visible]);

  // Shown again by an explicit open (`summoned`: Back from an item, a summon
  // with no box to focus), or mounted already shown by one: the control that
  // held focus was the item's, now gone, and at an overlay the item's own
  // return can only aim at the canvas, which is inert. Focus still lost then
  // (on <body>, or on something hidden or inert) goes to the heading. A box
  // that took a request, or the item's return landing on a live row, wins;
  // and the reveal at boot (askOpen persisted, never summoned) moves nothing.
  useEffect(() => {
    if (!visible || !useRailStore.getState().summoned || useRailStore.getState().pendingFocus) return;
    const timer = setTimeout(() => {
      const root = asideRef.current;
      const active = document.activeElement;
      if (!root || root.hidden) return;
      const lost = !active || active === document.body || !!active.closest('[hidden], [inert]');
      if (lost) root.querySelector<HTMLElement>('[data-ask-heading]')?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [visible]);

  let header;
  let body = null;
  if (!top) {
    const actions = (
      <>
        <HistoryButton />
        <NewChatButton />
      </>
    );
    header = <RailHeader home title="Ask" actions={actions} onClose={close} />;
    body = <AskHome />;
  } else if (top.kind === 'history') {
    header = <RailHeader back={{ label: backTo, onBack: back }} title="History" actions={<NewChatButton />} onClose={close} />;
    body = <HistoryView />;
  } else if (top.kind === 'conversation') {
    const id = resolveConversationId(top.id);
    const title = conversationHeader === 'new' ? 'New chat' : (conversationTitle ?? 'New chat');
    const action = conversationHeaderAction(conversationHeader, beneath);
    header = (
      <RailHeader
        back={{ label: backTo, onBack: back }}
        title={title}
        heading={conversationHeader === 'saved' ? <ConversationTitleMenu key={id} id={id} title={title} /> : undefined}
        actions={action === 'new-chat' ? <NewChatButton /> : action === 'history' ? <HistoryButton /> : undefined}
        onClose={close}
      />
    );
    body = <ConversationView id={top.id} />;
  } else {
    header = <RailHeader back={{ label: backTo, onBack: back }} onClose={close} />;
  }

  return (
    <aside
      ref={asideRef}
      data-rail-view=""
      aria-label="Ask"
      hidden={!visible && !leaving}
      inert={!visible}
      className="flex h-full w-[420px] flex-col overflow-hidden outline-none"
    >
      {header}
      <ComposerAwakeContext.Provider value={visible}>
        <div
          key={viewKey}
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            // A slide only: an entrance fade would carry the lime accent
            // through a parent's opacity.
            lastNav === 'push' && 'animate-in slide-in-from-right-2 duration-200 motion-reduce:animate-none',
            lastNav === 'back' && 'animate-in slide-in-from-left-2 duration-200 motion-reduce:animate-none'
          )}
        >
          {body}
        </div>
      </ComposerAwakeContext.Provider>
    </aside>
  );
}
