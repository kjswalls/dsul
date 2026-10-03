'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, Pencil, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { openclawWasAsked, resolveConversationId, useConversationsStore } from '@/lib/conversations-store';
import { CHAT_LIMITS } from '@/lib/conversation-types';
import { useUIStore } from '@/lib/ui-store';

/**
 * A saved conversation's own controls: the ⌄ on its title in Ask (Rename,
 * Star, Delete…) and the ⌄ on an item's Conversation section (Star, Delete
 * conversation…; no Rename, since that title is the item's). "Open wide" joins
 * the title's menu in 2c.
 *
 * Every change is optimistic in the store (lib/conversations-store.ts) and
 * comes back on failure, with a toast saying so. A delete asks first, through
 * the app's one confirm (ui-store `confirm`).
 */

export const CONVERSATION_COPY = Object.freeze({
  renameFailed: "Couldn't rename that conversation.",
  /** One string, for Star and Unstar alike. */
  starFailed: "Couldn't star that conversation.",
  deleteFailed: "Couldn't delete that conversation.",
  deleteTitle: 'Delete this conversation?',
  deleteDescription: "It's removed from all your devices. Changes it made to your planner stay. This can't be undone.",
  deleteItemTitle: "Delete this item's conversation?",
  deleteItemDescription: "The item stays. The conversation is removed from all your devices. This can't be undone.",
  /**
   * Added when OpenClaw ever answered in it (`openclawSeen`, never cleared),
   * not when it answered last: a conversation OpenClaw answered three times
   * and a model once still went through OpenClaw's own sessions. And when
   * OpenClaw was asked in it from this browser, answered or not.
   */
  openclawCopy: ' OpenClaw may keep its own copy.',
});

/** The delete confirm's body, for a conversation or an item's. */
export function deleteDescription(o: { item: boolean; openclawSeen: boolean }): string {
  const base = o.item ? CONVERSATION_COPY.deleteItemDescription : CONVERSATION_COPY.deleteDescription;
  return o.openclawSeen ? base + CONVERSATION_COPY.openclawCopy : base;
}

/** The first Ask heading on screen: the view a delete fell back to. */
function focusShownHeading(): void {
  const headings = Array.from(document.querySelectorAll<HTMLElement>('[data-ask-heading]'));
  headings.find((h) => !h.closest('[hidden], [inert]'))?.focus({ preventScroll: true });
}

/**
 * Whether OpenClaw may hold any of a conversation, as this browser knows it:
 * the server's `openclawSeen`; an OpenClaw reply held here whose save is still
 * on its way, waiting for a retry, or never landed (the server's own rule,
 * over the same messages); or OpenClaw ASKED here and no reply kept, a turn
 * stopped before its first token, or a plan asked of an OpenClaw gateway
 * (conversations-store `openclawWasAsked`). OpenClaw has the words either way.
 */
function openclawSeenIn(id: string): boolean {
  const s = useConversationsStore.getState();
  const rid = resolveConversationId(id);
  if (s.summaries[rid]?.openclawSeen || openclawWasAsked(rid)) return true;
  return !!s.threads[rid]?.messages.some((m) => m.role === 'assistant' && m.answerer === 'openclaw');
}

/**
 * Ask before deleting a conversation, then delete it (optimistic: the view
 * showing it goes at once, rail-store's leaveConversation, and comes back with
 * a toast if the server refuses). `item`: an item's conversation, from the
 * item's own section; the item stays, and its next send starts afresh.
 *
 * The control that opened the confirm goes with the conversation, so the
 * confirm is told where focus goes instead (`fallbackFocus`, which
 * ConfirmDialog runs once its exit animation is over): the heading of the
 * view beneath, or the item, whose Conversation section went; a caller that
 * knows better (the inline section, whose box stays) says so.
 */
export function confirmDeleteConversation(id: string, o: { item?: boolean; fallbackFocus?: () => void } = {}): void {
  const item = !!o.item;
  useUIStore.getState().confirm({
    title: item ? CONVERSATION_COPY.deleteItemTitle : CONVERSATION_COPY.deleteTitle,
    description: deleteDescription({ item, openclawSeen: openclawSeenIn(id) }),
    confirmLabel: 'Delete',
    destructive: true,
    testId: item ? 'item-conversation-delete-confirm' : 'conversation-delete-confirm',
    onConfirm: () => {
      void useConversationsStore
        .getState()
        .remove(id)
        .then((ok) => {
          if (!ok) toast.error(CONVERSATION_COPY.deleteFailed);
        });
    },
    fallbackFocus: o.fallbackFocus ?? (item ? () => useUIStore.getState().focusItemPanel() : focusShownHeading),
  });
}

/**
 * A menu item whose action opens something that takes focus (the confirm) or
 * replaces the trigger (the rename field) runs once the menu has closed:
 * focus is put home on the trigger first, so the confirm hands it back there
 * when it closes (DetailHead's pattern, components/planner/organize/
 * detail-parts.tsx). `keepFocus: false` leaves focus alone instead, for a
 * field that takes it itself.
 */
function useActionAfterClose(triggerRef: RefObject<HTMLButtonElement | null>) {
  const pending = useRef<{ run: () => void; keepFocus: boolean } | null>(null);
  return {
    after: (run: () => void, o: { keepFocus?: boolean } = {}) => {
      pending.current = { run, keepFocus: o.keepFocus ?? true };
    },
    onCloseAutoFocus: (event: Event) => {
      const action = pending.current;
      pending.current = null;
      if (!action) return;
      event.preventDefault();
      if (action.keepFocus) triggerRef.current?.focus();
      action.run();
    },
  };
}

async function toggleStar(id: string, starred: boolean): Promise<void> {
  const ok = await useConversationsStore.getState().setStarred(id, starred);
  if (!ok) toast.error(CONVERSATION_COPY.starFailed);
}

/**
 * The title of a saved conversation, as Ask's header shows it, inside the
 * header's own heading (RailHeader's: one element whatever it holds): the
 * title is the ⌄ menu's trigger (the title names it; the menu is
 * "Conversation options" to a screen reader too). Rename turns the title into
 * a field in place: Enter or leaving it saves the trimmed text, an empty one
 * cancels, and Escape cancels without also going back a view (it is consumed).
 *
 * Only for a conversation with a row: a draft has nothing to rename, star or
 * delete, so its header names it plainly.
 */
export function ConversationTitleMenu({ id, title }: { id: string; title: string }) {
  const starred = useConversationsStore((s) => !!s.summaries[id]?.starred);
  const [renaming, setRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menu = useActionAfterClose(triggerRef);

  if (renaming) {
    return (
      <RenameField
        id={id}
        title={title}
        onDone={(refocus) => {
          setRenaming(false);
          if (refocus) setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
        }}
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-testid="conversation-title-menu"
          className="-ml-1.5 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          <span className="truncate">{title}</span>
          <span className="sr-only">, conversation options</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48" onCloseAutoFocus={menu.onCloseAutoFocus}>
        <DropdownMenuItem
          data-testid="conversation-rename"
          onSelect={() => menu.after(() => setRenaming(true), { keepFocus: false })}
        >
          <Pencil aria-hidden />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="conversation-star" onSelect={() => void toggleStar(id, !starred)}>
          <Star aria-hidden />
          {starred ? 'Unstar' : 'Star'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          data-testid="conversation-delete"
          onSelect={() => menu.after(() => confirmDeleteConversation(id))}
        >
          <Trash2 aria-hidden />
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RenameField({ id, title, onDone }: { id: string; title: string; onDone: (refocus: boolean) => void }) {
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  // Deferred past the menu's own close, which would otherwise hand focus back
  // to the trigger this field replaced.
  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus({ preventScroll: true });
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const finish = (save: boolean, refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(refocus);
    const next = value.trim();
    if (!save || !next || next === title.trim()) return;
    void useConversationsStore
      .getState()
      .rename(id, next)
      .then((ok) => {
        if (!ok) toast.error(CONVERSATION_COPY.renameFailed);
      });
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      maxLength={CHAT_LIMITS.titleChars}
      aria-label="Conversation name"
      data-testid="conversation-rename-input"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(true, true);
        } else if (e.key === 'Escape') {
          // Consumed: the rail's Escape would otherwise also go back a view.
          e.preventDefault();
          finish(false, true);
        }
      }}
      onBlur={() => finish(true, false)}
      className="field -ml-1.5 h-7 min-w-0 flex-1 border bg-transparent px-1.5 text-sm font-medium text-foreground outline-none"
    />
  );
}

/**
 * The ⌄ on an item's Conversation section: Star, and Delete conversation… The
 * item stays either way; deleting its conversation means its next send starts
 * a fresh one (the store's itemIndex goes to null). `fallbackFocus`: where
 * focus goes once a delete has taken this ⌄ with it (default: the item panel).
 */
export function ItemConversationMenu({ id, fallbackFocus }: { id: string; fallbackFocus?: () => void }) {
  const starred = useConversationsStore((s) => !!s.summaries[id]?.starred);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menu = useActionAfterClose(triggerRef);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-testid="item-conversation-menu"
          aria-label="Conversation options"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={menu.onCloseAutoFocus}>
        <DropdownMenuItem data-testid="item-conversation-star" onSelect={() => void toggleStar(id, !starred)}>
          <Star aria-hidden />
          {starred ? 'Unstar' : 'Star'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          data-testid="item-conversation-delete"
          onSelect={() => menu.after(() => confirmDeleteConversation(id, { item: true, fallbackFocus }))}
        >
          <Trash2 aria-hidden />
          Delete conversation…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
