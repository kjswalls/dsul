'use client';

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ChevronLeft, History } from 'lucide-react';
import { AskHome } from '@/components/ai/ask/ask-home';
import { ConversationView } from '@/components/ai/ask/conversation-view';
import { ConversationTitleMenu } from '@/components/ai/ask/conversation-title-menu';
import { HistoryView } from '@/components/ai/ask/history-view';
import { NewChatButton } from '@/components/ai/ask/new-chat-empty';
import { useBackLabel, useConversationTitle } from '@/components/ai/rail/rail-header';
import { ItemDialog, type ItemDialogState } from '@/components/planner/item-dialog';
import { SurfaceHeader } from '@/components/primitives/surface-header';
import { resolveConversationId, useConversationsStore } from '@/lib/conversations-store';
import { openHistory } from '@/lib/open-chat';
import { usePlannerStore } from '@/lib/planner-store';
import { phoneArrivalFocuses, useRailStore, type AskView } from '@/lib/rail-store';
import { cn } from '@/lib/utils';

/** One key per view, so the body remounts (and slides) exactly when the top changes. */
function viewKeyOf(view: AskView | undefined): string {
  if (!view) return 'home';
  if (view.kind === 'conversation') return `conv:${view.id}`;
  if (view.kind === 'item') return `item:${view.itemId}`;
  return 'history';
}

/**
 * How a conversation's header reads (the rail's rule, components/ai/rail/
 * right-rail.tsx): `saved`, its title is the ⌄ menu, then "+"; `unsaved`, its
 * title plainly, then "+"; `new`, "New chat", then History.
 */
type ConversationHeader = 'saved' | 'unsaved' | 'new';

const back = () => useRailStore.getState().back('phone');

/** Pop an item view that is still on top: it is gone, or it left for its own page. */
function leaveItem(itemId: string): void {
  const rail = useRailStore.getState();
  const top = rail.stacks.phone.at(-1);
  if (top?.kind === 'item' && top.itemId === itemId) rail.back('phone');
}

/**
 * The phone's Ask tab: Ask home, the same home as the desktop rail's, with the
 * same stack (`stacks.phone`, lib/rail-store.ts) under one capsule header.
 *
 *  - HEADER. At home: "Ask", then History (the clock; gone while saving is
 *    off, with nothing to list), "+" and the user menu. Pushed: "‹ <the view
 *    beneath>", the view's title (a saved conversation's is its ⌄ menu), "+"
 *    (History instead on a new chat) and the user menu. No ✕: the tab is the
 *    way out.
 *  - BODY, by the top of the stack: Ask home; History; a conversation with no
 *    box of its own (the dock's bar is this tab's one box, bound to what is
 *    on top: lib/open-chat.ts usePhoneComposerBinding); an item.
 *  - ITEMS PUSH. While this is mounted every `openEditFor` pushes the item
 *    over Ask instead of opening the drawer (rail-store's interceptor), so an
 *    item opened from here (a Needs-you title, an activity row, a History
 *    row) is a view like the others, and Back (the "‹", or a swipe right)
 *    returns to where it was opened. Today and Braindump never mount this, so
 *    they keep the drawer.
 *  - LEAVING THE TAB keeps everything: the stack and the drafts are
 *    rail-store's, and a conversation's plan card outlives its view (the
 *    `conv:` exemption), so coming back finds the same view, its card and the
 *    half-typed text.
 *  - FOCUS ACROSS A MOVE, as in the rail: a push or a Back removes what held
 *    focus, so when focus was this tab's (or lost), the new view's heading
 *    takes it, or after a Back the control that pushed the view
 *    (`returnFocus`). A send from the dock that pushed a conversation leaves
 *    focus with the dock; a move to Ask home or History takes it from the
 *    dock, so the keyboard goes down over what is there to tap.
 */
export function AskTab({ headerAccessory }: { headerAccessory?: ReactNode }) {
  const top = useRailStore((s) => s.stacks.phone.at(-1));
  const beneath = useRailStore((s) => s.stacks.phone.at(-2));
  const lastNav = useRailStore((s) => s.lastNav);
  const backTo = useBackLabel(top ?? null, beneath);
  const conversationTitle = useConversationTitle(top?.kind === 'conversation' ? top.id : null);
  const conversationHeader = useConversationsStore((s): ConversationHeader | null => {
    if (top?.kind !== 'conversation') return null;
    const id = resolveConversationId(top.id);
    if (s.summaries[id]) return 'saved';
    const t = s.threads[id];
    return t && (t.messages.length > 0 || t.load === 'gone' || t.saved) ? 'unsaved' : 'new';
  });
  const itemTitle = usePlannerStore((s) =>
    top?.kind === 'item' ? (s.items.find((i) => i.id === top.itemId)?.title ?? '') : ''
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const viewKey = viewKeyOf(top);

  // Counted while mounted, in an effect (StrictMode's double mount nets out):
  // the openEditFor interceptor pushes an item over Ask only while a tab is
  // here to show it.
  useEffect(() => useRailStore.getState().hostPhoneAsk(), []);

  // The first AI surface on screen warms the conversation list (History's
  // first page); it never blocks, and never rejects.
  useEffect(() => {
    void useConversationsStore.getState().ensureLoaded();
  }, []);

  const shown = useRef({ key: viewKey, top });
  useEffect(() => {
    const was = shown.current.top;
    const moved = shown.current.key !== viewKey;
    shown.current = { key: viewKey, top };
    const root = rootRef.current;
    if (!moved || !root) return;
    const active = document.activeElement;
    // A move made from outside the tab keeps its focus (the dock's box
    // sending, which pushes the conversation it typed into), except the
    // dock's box itself when the move lands on Ask home or History: those
    // are tap targets, and the keyboard it holds up would hide them
    // (phoneArrivalFocuses, as on arrival).
    const box =
      active instanceof HTMLElement && active.closest('[data-ask-composer]') && !root.contains(active)
        ? active
        : null;
    const lost = !active || active === document.body || root.contains(active);
    if (!lost && !(box && !phoneArrivalFocuses(useRailStore.getState().stacks.phone))) return;
    if (useRailStore.getState().pendingFocus) return;
    const returnTo = useRailStore.getState().lastNav === 'back' ? was?.returnFocus : undefined;
    setTimeout(() => {
      // Only focus that is still lost, parked on the heading React kept from
      // view to view, or still in the box being let go: anything the user
      // moved to meanwhile keeps it.
      const now = document.activeElement as HTMLElement | null;
      const parked = !!now && root.contains(now) && now.hasAttribute('data-ask-heading');
      if (now && now !== document.body && !parked && now !== box) return;
      const opener = returnTo
        ? Array.from(root.querySelectorAll<HTMLElement>('[data-ask-focus]')).find(
            (el) => el.dataset.askFocus === returnTo
          )
        : undefined;
      (opener ?? root.querySelector<HTMLElement>('[data-ask-heading]'))?.focus({ preventScroll: true });
    }, 0);
  }, [viewKey, top]);

  let header: ReactNode;
  let body: ReactNode;
  if (!top) {
    header = (
      <SurfaceHeader title={<Heading>Ask</Heading>} className="mx-[10px]">
        <PhoneHistoryButton />
        <NewChatButton surface="phone" />
        {headerAccessory}
      </SurfaceHeader>
    );
    body = <AskHome variant="mobile" />;
  } else if (top.kind === 'history') {
    header = (
      <SurfaceHeader icon={<BackButton label={backTo} titled />} title={<Heading>History</Heading>} className="mx-[10px]">
        <NewChatButton surface="phone" />
        {headerAccessory}
      </SurfaceHeader>
    );
    body = <HistoryView surface="phone" />;
  } else if (top.kind === 'conversation') {
    const id = resolveConversationId(top.id);
    const title = conversationHeader === 'new' ? 'New chat' : (conversationTitle ?? 'New chat');
    header = (
      <SurfaceHeader
        icon={<BackButton label={backTo} titled />}
        title={
          <Heading>
            {conversationHeader === 'saved' ? <ConversationTitleMenu key={id} id={id} title={title} /> : title}
          </Heading>
        }
        className="mx-[10px]"
      >
        {conversationHeader === 'new' ? <PhoneHistoryButton /> : <NewChatButton surface="phone" />}
        {headerAccessory}
      </SurfaceHeader>
    );
    body = <ConversationView id={top.id} surface="phone" composer={false} />;
  } else {
    // The item's own title field is its visible heading, a line below; the
    // capsule's heading names it for a screen reader only.
    header = (
      <SurfaceHeader
        icon={<BackButton label={backTo} />}
        title={<Heading className="sr-only">{itemTitle}</Heading>}
        className="mx-[10px]"
      >
        {headerAccessory}
      </SurfaceHeader>
    );
    body = <PhoneItemView key={top.itemId} itemId={top.itemId} />;
  }

  return (
    <div ref={rootRef} data-ask-tab="" className="flex h-full min-h-0 flex-col gap-2">
      {header}
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
    </div>
  );
}

/**
 * The view's heading, focusable on request (tabIndex -1), which is where focus
 * goes when a move removes what held it. One element whatever it holds, so a
 * saved conversation found deleted elsewhere, whose ⌄ goes, keeps the focus.
 * A row, as the rail's is, so the ⌄ menu truncates its own title and keeps
 * its chevron; plain words truncate in a span of their own.
 */
function Heading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span tabIndex={-1} data-ask-heading="" className={cn('flex min-w-0 items-center outline-none', className)}>
      {typeof children === 'string' ? <span className="truncate">{children}</span> : children}
    </span>
  );
}

/**
 * "‹ <the view beneath>". Beside a title it keeps its words up to 45% of the
 * row (a long item title truncates there); without one (an item) it takes the
 * row.
 */
function BackButton({ label, titled = false }: { label: string; titled?: boolean }) {
  return (
    <button
      type="button"
      onClick={back}
      data-testid="ask-back"
      aria-label={`Back to ${label}`}
      className={cn(
        '-ml-1.5 flex items-center gap-0.5 rounded-md py-1 pr-2 pl-0.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        titled ? 'max-w-[45%] shrink-0' : 'min-w-0'
      )}
    >
      <ChevronLeft className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * History, as the phone's capsule draws it: the clock, named "History". Gone
 * while saving is off (the migration is missing): there would be nothing to
 * list. Back from History hands focus back here (`data-ask-focus`).
 */
function PhoneHistoryButton() {
  const off = useConversationsStore((s) => s.saving === 'off');
  if (off) return null;
  return (
    <button
      type="button"
      data-testid="ask-history"
      data-ask-focus="history"
      aria-label="History"
      title="History"
      onClick={() => openHistory(true, { returnFocus: 'history' })}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <History className="size-4" aria-hidden />
    </button>
  );
}

/**
 * An item pushed over Ask: the item panel's body laid into the tab
 * (`presentation="inline"`, which autosaves and has no Escape, click-away,
 * Done or ✕), with its conversation's transcript at the foot
 * (`conversation="transcript"`; the dock's bar asks about the item). The
 * scroller is the item's rail body, so a History row's reveal and a new
 * turn scroll only it.
 *
 * THE PAYLOAD IS A SNAPSHOT, keyed on the item's id alone, exactly as
 * /item/[id] keys its own: ItemDialog reads the live item by id on every
 * render, and treats a new payload as a retarget, which disarms its delete,
 * reset and pause confirms and folds the revealed "+ Add property" chips. A
 * payload rebuilt from every planner write (the panel's own autosave
 * included) would close a confirm mid-edit.
 *
 * Its `onOpenChange(false)` means only that the item is gone (or left for its
 * page), and so does finding no item at all (deleted while the tab was away):
 * either way the view beneath shows.
 */
function PhoneItemView({ itemId }: { itemId: string }) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === itemId));
  const itemKey = item?.id;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo<ItemDialogState | null>(() => (item ? { mode: 'edit', item } : null), [itemKey]);

  useEffect(() => {
    if (!itemKey) leaveItem(itemId);
  }, [itemKey, itemId]);

  if (!state) return null;
  return (
    <div data-rail-body="" data-testid="ask-item" className="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-4">
      <ItemDialog
        presentation="inline"
        conversation="transcript"
        state={state}
        onOpenChange={(open) => {
          if (!open) leaveItem(itemId);
        }}
      />
    </div>
  );
}
