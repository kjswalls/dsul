import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { useProposalStore } from './proposal-store';
import { openEditFor, useUIStore } from './ui-store';
import { useSidebarStore } from './sidebar-store';
import { getAICapabilities, useAIConnectionStore } from './ai-connection-store';
import { useAISettingsStore } from './ai-settings-store';
import { useViewStore } from './view-store';
import type { Task } from './planner-types';

/**
 * rail-store.ts — what Ask shows under the item: a stack of views per surface,
 * the one pending focus request, and the composers' half-typed text.
 *
 * The item on top is NOT here: it stays ui-store's `edit-item` slot, so every
 * reader of the slot and every `openEditFor` caller is unchanged. This store
 * holds only the views beneath it (memory only, never persisted: a reload that
 * landed on yesterday's conversation would be a surprise).
 *
 * THE LEVEL RULE. A stack is always an ordered subset of
 * [history, conversation, item]: pushing a view first removes every view at
 * its level or above. So Back is predictable (it can only go down a level),
 * and a stack can never grow without bound.
 *
 * THE RAIL. Whether the right column shows at all is one pure rule,
 * `railMode`, over three stores: the item slot (ui-store), whether the user
 * keeps Ask open (sidebar-store's persisted `askOpen`) and whether Ask was
 * summoned this session (`summoned`, here). With nothing to answer the column
 * is only the item host, exactly today's panel. At or below 1180px Ask is an
 * overlay, and an overlay never comes up on its own: only an explicit summon
 * shows it there, never a persisted `askOpen` at boot.
 *
 * Client-safe (tests/unit/ai-server-boundary.test.ts).
 */

/** Below this the right column stops compressing the canvas and overlays it (DesktopShell). */
export const PANEL_OVERLAY_QUERY = '(max-width: 1180px)';

/**
 * What the right column holds back from the canvas while it is shown and
 * docked: the 420px column plus the 12px gap. The braindump's rendered width
 * and its sash's growth (lib/sidebar-store.ts) and the bulk bar's place read it.
 */
export const RAIL_RESERVE_PX = 432;

export type RailMode = 'item' | 'ask' | 'hidden';

/**
 * THE visibility rule, pure.
 *   item    an item is open: the column is its panel, with or without AI
 *   ask     Ask shows: kept open (or summoned), something answers, and either
 *           the column docks or Ask was summoned while it overlays
 *   hidden  nothing to show
 * `summoned` alone opens Ask only for the tour's non-persisting summon: every
 * other summon also sets `askOpen`, and closeRail clears both. An overlay
 * needs `summoned`, so a persisted `askOpen` never raises one at boot.
 */
export function railMode(i: {
  itemOpen: boolean;
  askOpen: boolean;
  canChat: boolean;
  overlays: boolean;
  summoned: boolean;
}): RailMode {
  if (i.itemOpen) return 'item';
  if ((i.askOpen || i.summoned) && i.canChat && (!i.overlays || i.summoned)) return 'ask';
  return 'hidden';
}

/** A view pushed over Ask home. `[]` is home. */
export type AskView =
  | { kind: 'history'; returnFocus?: string }
  /** `returnTo`: asked with "?" over an item; Back re-opens that item if it still exists. */
  | { kind: 'conversation'; id: string; returnTo?: { itemId: string }; returnFocus?: string }
  /** Phone only: on desktop the item is ui-store's slot. */
  | { kind: 'item'; itemId: string; returnFocus?: string };

export type AskSurface = 'desktop' | 'phone';

export const ASK_LEVEL = { history: 1, conversation: 2, item: 3 } as const;

/**
 * Where a composer sends (lib/open-chat.ts decides what each means):
 *   home          Ask home's box, or History's: a new conversation, pushed
 *   draft         a "+" new chat, not yet saved
 *   conversation  that conversation
 *   item          that item's one conversation, whatever its id turns out to be
 */
export type ComposerBinding =
  | { kind: 'home' }
  | { kind: 'draft'; id: string }
  | { kind: 'conversation'; id: string }
  | { kind: 'item'; itemId: string };

/**
 * The key a composer's draft text (and its "sending" flag) is kept under. A
 * draft and the conversation it becomes share one key, so the text survives
 * the first send turning one into the other.
 */
export function bindingKey(b: ComposerBinding): string {
  switch (b.kind) {
    case 'home':
      return 'home';
    case 'item':
      return `item:${b.itemId}`;
    default:
      return `conv:${b.id}`;
  }
}

/**
 * A consumable focus request: the matching field focuses when it is mounted,
 * or when it mounts next, and clears it. Set only by an explicit summon (a
 * keypress, a command, a chip), never because something mounted.
 */
export type FocusRequest = { target: 'composer'; binding?: ComposerBinding } | { target: 'history-search' };

interface RailState {
  stacks: Record<AskSurface, AskView[]>;
  /**
   * An explicit open this session (Ctrl+J, `?`, Ask AI, a settings button,
   * catch-up, the tour). It is what lets Ask show as an overlay at or below
   * 1180px. Memory only, so a reload never brings an overlay up.
   */
  summoned: boolean;
  pendingFocus: FocusRequest | null;
  /**
   * An item opened FOR its conversation (a History or activity row): its
   * conversation section consumes this on mount and scrolls the rail body to
   * it. Every other open lands at the item's top.
   */
  pendingReveal: { itemId: string } | null;
  /** Half-typed composer text by `bindingKey`. Memory only. */
  drafts: Record<string, string>;
  /** Which way the last move went, for the slide. */
  lastNav: 'push' | 'back' | null;
  /**
   * What the column holds back from the canvas: RAIL_RESERVE_PX while it is
   * shown and docked (an item or Ask alike), else 0. Published by the column
   * itself (DesktopShell's RailColumn), read by the braindump (which yields
   * to it), its sash and the bulk bar.
   */
  reservePx: number;
  /**
   * The last reserve change was the column's instant first reveal: Ask resting
   * open, shown when the gate answers at boot, without the slide. The
   * braindump yields with it in the same frame and without its own
   * transition, so a launch never slides either column.
   */
  reserveInstant: boolean;
  /**
   * The column shows as an overlay (at or below 1180px): an opaque card over
   * a canvas that is inert under it. Published by the column with its
   * reserve, and only by the desktop column, so it is always false on the
   * phone. The bulk bar stands down for it rather than floating over the card
   * and acting on rows nobody can see.
   */
  covers: boolean;

  /** Push by the level rule. */
  push(surface: AskSurface, view: AskView): void;
  /**
   * Pop the top. A conversation with `returnTo` re-opens its item if the item
   * still exists, and hands it the focus when the focus was the rail's.
   */
  back(surface: AskSurface): void;
  popToHome(surface: AskSurface): void;
  /** Drop a deleted conversation from both stacks (the views beneath show). */
  leaveConversation(id: string): void;
  /** The item-conflict rebind: a draft turned out to be the item's existing conversation. */
  rebindConversation(from: string, to: string): void;
  requestFocus(req: FocusRequest): void;
  focusComposer(binding?: ComposerBinding): void;
  /**
   * True exactly once, for the field the pending request names: a composer
   * matches a request with no binding, or one naming its own. Clears it.
   */
  consumeFocus(target: FocusRequest['target'], binding?: ComposerBinding): boolean;
  setDraft(key: string, text: string): void;
  /**
   * Open Ask: `askOpen` (persisted) and `summoned`. `focus` asks for the box
   * (an explicit open from the keyboard or a command), `home` pops the desktop
   * stack first, and `persist: false` (the tour) sets only `summoned`, so a
   * choice the user did not make is never written. Remembers where focus was,
   * so closing the rail can hand it back.
   */
  summon(o?: { focus?: boolean; home?: boolean; persist?: boolean }): void;
  /**
   * Un-summon (an overlay's click-away or Escape, the tour). `askOpen`
   * untouched. When that hides the rail, focus left in it goes back to where
   * it was before the summon, as for closeRail.
   */
  park(): void;
  /** Close Ask: `askOpen` and `summoned` both off. The caller closes an item first. */
  closeRail(): void;
  setPendingReveal(itemId: string | null): void;
  /** True exactly once, for the item the pending reveal names. Clears it. */
  consumeReveal(itemId: string): boolean;
  /** `instant`: the change lands without the braindump's transition (see reserveInstant). */
  setReserve(px: number, o?: { instant?: boolean }): void;
  setCovers(covers: boolean): void;
  /** Sign-out: both stacks home, not summoned, no focus or reveal request, no drafts. */
  reset(): void;
}

const EMPTY_STACKS: Record<AskSurface, AskView[]> = { desktop: [], phone: [] };

function conversationIds(stacks: Record<AskSurface, AskView[]>): Set<string> {
  const ids = new Set<string>();
  for (const stack of [stacks.desktop, stacks.phone]) {
    for (const v of stack) if (v.kind === 'conversation') ids.add(v.id);
  }
  return ids;
}

/**
 * A conversation's proposal card (surface `conv:<id>`) outlives its view
 * unmounting: a tab switch, an item opened over it or a closed rail must never
 * drop a plan the user paid a model call for (ProposalCard skips its
 * unmount-dismiss for `conv:`). It goes once its conversation is in NEITHER
 * stack, which is ProposalCard's own rule ("they closed the thing they asked
 * from"), with Back as the close.
 */
function dismissLeftCards(before: Record<AskSurface, AskView[]>, after: Record<AskSurface, AskView[]>) {
  const still = conversationIds(after);
  const proposals = useProposalStore.getState();
  const surface = proposals.lastRequest?.surface;
  if (!surface?.startsWith('conv:')) return;
  for (const id of conversationIds(before)) {
    if (!still.has(id) && surface === `conv:${id}`) {
      proposals.dismiss();
      return;
    }
  }
}

/** Re-open an item by id, as every opener does, if the planner still has it. True when it did. */
function reopenItem(itemId: string): boolean {
  const item = usePlannerStore.getState().items.find((i) => i.id === itemId);
  if (!item) return false;
  openEditFor(item as unknown as Task, item.type === 'habit' ? 'habit' : 'task');
  return true;
}

export const useRailStore = create<RailState>()((set, get) => {
  /** Apply new stacks, then drop any card whose conversation just left both. */
  const setStacks = (next: Record<AskSurface, AskView[]>, lastNav: RailState['lastNav']) => {
    const before = get().stacks;
    set({ stacks: next, lastNav });
    dismissLeftCards(before, next);
  };

  return {
    stacks: EMPTY_STACKS,
    summoned: false,
    pendingFocus: null,
    pendingReveal: null,
    drafts: {},
    lastNav: null,
    reservePx: 0,
    reserveInstant: false,
    covers: false,

    push: (surface, view) => {
      const { stacks } = get();
      const kept = stacks[surface].filter((v) => ASK_LEVEL[v.kind] < ASK_LEVEL[view.kind]);
      setStacks({ ...stacks, [surface]: [...kept, view] }, 'push');
    },

    back: (surface) => {
      const { stacks } = get();
      const stack = stacks[surface];
      const top = stack.at(-1);
      if (!top) return;
      // Read before the pop: the control that held focus is about to go.
      const handBack = focusIsInRail();
      setStacks({ ...stacks, [surface]: stack.slice(0, -1) }, 'back');
      // After the pop, so the item opens over the view that was beneath. Ask
      // goes hidden under it, so the item takes the focus the rail held
      // (ui-store's focusItemPanel), or it would be left on <body>.
      if (top.kind === 'conversation' && top.returnTo && reopenItem(top.returnTo.itemId) && handBack) {
        useUIStore.getState().focusItemPanel();
      }
    },

    popToHome: (surface) => {
      const { stacks } = get();
      if (stacks[surface].length === 0) return;
      setStacks({ ...stacks, [surface]: [] }, 'back');
    },

    leaveConversation: (id) => {
      const { stacks } = get();
      const drop = (stack: AskView[]) => stack.filter((v) => !(v.kind === 'conversation' && v.id === id));
      const next = { desktop: drop(stacks.desktop), phone: drop(stacks.phone) };
      if (next.desktop.length === stacks.desktop.length && next.phone.length === stacks.phone.length) return;
      setStacks(next, 'back');
    },

    rebindConversation: (from, to) => {
      if (from === to) return;
      const { stacks, drafts, pendingFocus } = get();
      const swap = (stack: AskView[]) =>
        stack.map((v) => {
          if (v.kind !== 'conversation') {
            return v.returnFocus === `conv:${from}` ? { ...v, returnFocus: `conv:${to}` } : v;
          }
          const moved = v.id === from ? { ...v, id: to } : v;
          return moved.returnFocus === `conv:${from}` ? { ...moved, returnFocus: `conv:${to}` } : moved;
        });
      const fromKey = `conv:${from}`;
      const toKey = `conv:${to}`;
      const nextDrafts = { ...drafts };
      if (fromKey in nextDrafts) {
        if (!nextDrafts[toKey]) nextDrafts[toKey] = nextDrafts[fromKey];
        delete nextDrafts[fromKey];
      }
      const b = pendingFocus?.target === 'composer' ? pendingFocus.binding : undefined;
      const nextFocus =
        b && b.kind !== 'home' && b.kind !== 'item' && b.id === from
          ? { target: 'composer' as const, binding: { ...b, id: to } }
          : pendingFocus;
      // A rebind is the same conversation under its real id: no card goes.
      set({ stacks: { desktop: swap(stacks.desktop), phone: swap(stacks.phone) }, drafts: nextDrafts, pendingFocus: nextFocus });
    },

    requestFocus: (req) => set({ pendingFocus: req }),

    focusComposer: (binding) => set({ pendingFocus: binding ? { target: 'composer', binding } : { target: 'composer' } }),

    consumeFocus: (target, binding) => {
      const req = get().pendingFocus;
      if (!req || req.target !== target) return false;
      if (req.target === 'composer' && req.binding) {
        if (!binding || bindingKey(req.binding) !== bindingKey(binding)) return false;
      }
      set({ pendingFocus: null });
      return true;
    },

    setDraft: (key, text) =>
      set((s) => {
        if ((s.drafts[key] ?? '') === text) return s;
        const drafts = { ...s.drafts };
        if (text) drafts[key] = text;
        else delete drafts[key];
        return { drafts };
      }),

    summon: (o = {}) => {
      if (railModeNow() !== 'ask') rememberFocus();
      if (o.persist !== false) useSidebarStore.getState().setAskOpen(true);
      if (o.home) get().popToHome('desktop');
      set(o.focus ? { summoned: true, pendingFocus: { target: 'composer' } } : { summoned: true });
    },

    park: () => {
      if (!get().summoned) return;
      const handBack = focusIsInRail();
      set({ summoned: false });
      // A docked Ask kept open stays where it is, and so does its record.
      if (railModeNow() !== 'hidden') return;
      const el = takeFocusRecord();
      if (handBack) restoreFocus(el);
    },

    closeRail: () => {
      const handBack = focusIsInRail();
      useSidebarStore.getState().setAskOpen(false);
      set({ summoned: false });
      // Taken either way: a record left behind would answer a later, unrelated close.
      const el = takeFocusRecord();
      if (handBack) restoreFocus(el);
    },

    setPendingReveal: (itemId) => set({ pendingReveal: itemId ? { itemId } : null }),

    consumeReveal: (itemId) => {
      if (get().pendingReveal?.itemId !== itemId) return false;
      set({ pendingReveal: null });
      return true;
    },

    setReserve: (px, o) => {
      const next = Number.isFinite(px) && px > 0 ? px : 0;
      if (get().reservePx !== next) set({ reservePx: next, reserveInstant: !!o?.instant });
    },

    setCovers: (covers) => {
      if (get().covers !== covers) set({ covers });
    },

    // `reservePx` (and its `reserveInstant`), like `covers`, is layout, not the
    // account's: the column that published it is still on screen after a
    // sign-out.
    reset: () => {
      focusBeforeSummon = null;
      set({ stacks: EMPTY_STACKS, summoned: false, pendingFocus: null, pendingReveal: null, drafts: {}, lastNav: null });
    },
  };
});

// ── Focus across a summon ────────────────────────────────────────────────────
//
// Closing the rail (Ctrl+J, ✕, an overlay parked) removes the control that
// held focus, which would drop it to <body> and send the next Tab back to the
// top of the document. So the rail keeps ONE record of where focus came from:
// the summon that opens Ask notes what held focus before it, and focus
// entering the column from outside notes where it came from (noteRailEntry:
// Ask resting open from boot has no summon to note anything). Closing hands
// focus back to it when focus was inside the rail (or already lost), and only
// if it is STILL lost when the hand-back runs: the item panel's own return,
// or anything the user moved to meanwhile, wins. The record is per showing:
// a close takes it, and the column hiding by any other path drops it
// (clearRailFocusRecord), so an old one never answers a later close.
// Module state, not store state: it is a DOM node, and nothing renders from it.

let focusBeforeSummon: HTMLElement | null = null;

function activeElement(): Element | null {
  return typeof document === 'undefined' ? null : document.activeElement;
}

/**
 * The summon that opens Ask: focus outside the rail is the record; focus lost
 * to <body> means there is nothing to go back to. Focus already inside the
 * column (an item open on top) keeps what its entry noted.
 */
function rememberFocus(): void {
  const el = activeElement();
  if (el && el.closest('[data-rail]')) return;
  focusBeforeSummon = el && el !== document.body ? (el as HTMLElement) : null;
}

/**
 * Focus moved into the column (the item or Ask) from `from`: the column's
 * focusin, with its relatedTarget. An element outside the column becomes the
 * record; focus arriving from nowhere (a window regaining focus, a click from
 * <body>) leaves the record as it is.
 */
export function noteRailEntry(from: EventTarget | null): void {
  if (typeof HTMLElement === 'undefined' || !(from instanceof HTMLElement)) return;
  if (from === document.body || from.closest('[data-rail]')) return;
  focusBeforeSummon = from;
}

/** The column went hidden without a close that took the record (Done, Escape on the item). */
export function clearRailFocusRecord(): void {
  focusBeforeSummon = null;
}

function takeFocusRecord(): HTMLElement | null {
  const el = focusBeforeSummon;
  focusBeforeSummon = null;
  return el;
}

/** Focus is inside the rail, or lost to <body>: either way the rail's to move. */
export function focusIsInRail(): boolean {
  const el = activeElement();
  return !el || el === document.body || !!el.closest('[data-rail]');
}

function restoreFocus(el: HTMLElement | null): void {
  if (!el) return;
  // Deferred past the commit that hides the rail, as a FocusRequest's focus
  // is: a Radix layer closing in the same tick hands focus back on its own
  // setTimeout(0), and would otherwise win. And only onto focus still lost
  // then (on <body>, or inside the rail): ItemDialog's own return to the row
  // that opened the item lands in that commit, and must not be overridden by
  // an element from before an earlier summon.
  setTimeout(() => {
    if (!focusIsInRail()) return;
    if (el.isConnected) el.focus({ preventScroll: true });
  }, 0);
}

// ── Reading the rule ─────────────────────────────────────────────────────────

function overlaysNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PANEL_OVERLAY_QUERY).matches
    : false;
}

function modeFromStores(overlays: boolean): RailMode {
  return railMode({
    itemOpen: useUIStore.getState().activeDialog?.type === 'edit-item',
    askOpen: useSidebarStore.getState().askOpen,
    canChat: getAICapabilities().canChat,
    overlays,
    summoned: useRailStore.getState().summoned,
  });
}

/**
 * railMode read imperatively, for a command deciding what a key or `?` does
 * (lib/open-chat.ts). Zen replaces the desktop shell and the rail with it, so
 * nothing shows there whatever the stores say.
 */
export function railModeNow(): RailMode {
  if (useViewStore.getState().zenOpen) return 'hidden';
  return modeFromStores(overlaysNow());
}

/** Every store the rule reads, as one subscription. */
function subscribeRail(onChange: () => void): () => void {
  const offs = [
    useUIStore.subscribe(onChange),
    useSidebarStore.subscribe(onChange),
    useRailStore.subscribe(onChange),
    useAIConnectionStore.subscribe(onChange),
    useAISettingsStore.subscribe(onChange),
  ];
  return () => offs.forEach((off) => off());
}

/**
 * railMode from the stores, as ONE external-store read: the component
 * re-renders only when the mode itself changes, never for a push, a draft or
 * a status recheck. `overlays` is the caller's PANEL_OVERLAY_QUERY reading.
 */
export function useRailMode(overlays: boolean): RailMode {
  return useSyncExternalStore(
    subscribeRail,
    () => modeFromStores(overlays),
    () => 'hidden'
  );
}

/**
 * Whether the column shows as an overlay over the canvas: DesktopShell's one
 * rail read (`covered`, which makes <main> inert). Constant false while the
 * column docks (`overlays` false), so a docked open or close, Ctrl+J at any
 * width above 1180px, never re-renders the shell and the planner it lays out;
 * the column is its own memo'd component and re-renders alone.
 */
export function useRailCovers(overlays: boolean): boolean {
  return useSyncExternalStore(
    subscribeRail,
    () => overlays && modeFromStores(overlays) !== 'hidden',
    () => false
  );
}

function subscribeOverlays(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(PANEL_OVERLAY_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** PANEL_OVERLAY_QUERY as a hook, for a reader outside DesktopShell (the docks). False on the server. */
export function usePanelOverlays(): boolean {
  return useSyncExternalStore(subscribeOverlays, overlaysNow, () => false);
}

// ── Labels ───────────────────────────────────────────────────────────────────

/**
 * The name a back control shows ("‹ <label>"): the view it goes back to.
 *   `view`     what is on top: an Ask view, or null for the desktop item in
 *              ui-store's slot (it goes back to the stack's top)
 *   `beneath`  the view under it; undefined is Ask home
 * A conversation asked with `?` over an item (`returnTo`) goes back to that
 * item, so it names it by its LIVE title while the item exists. Once it is
 * deleted Back cannot reopen it (`back` checks the same store), so the label
 * names the view beneath instead and never promises a dead item; so does a
 * blank title, which has nothing to show. `conversationTitle` names a
 * conversation beneath (summary or draft title); an unnamed one is a new chat.
 */
export function backLabel(
  view: AskView | null,
  beneath: AskView | undefined,
  items: readonly { id: string; title: string }[],
  conversationTitle: (id: string) => string | null | undefined = () => null
): string {
  if (view?.kind === 'conversation' && view.returnTo) {
    const itemId = view.returnTo.itemId;
    const title = items.find((i) => i.id === itemId)?.title.trim();
    if (title) return title;
  }
  if (!beneath) return 'Ask';
  switch (beneath.kind) {
    case 'history':
      return 'History';
    case 'conversation':
      return conversationTitle(beneath.id)?.trim() || 'New chat';
    case 'item':
      return items.find((i) => i.id === beneath.itemId)?.title.trim() || 'Ask';
  }
}
