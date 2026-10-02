import { create } from 'zustand';
import { usePlannerStore } from './planner-store';
import { useProposalStore } from './proposal-store';
import { openEditFor } from './ui-store';
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
 * Client-safe (tests/unit/ai-server-boundary.test.ts). The rail's own half
 * (summon, park, closeRail, railMode, the reserve) lands with the rail column.
 */

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
  pendingFocus: FocusRequest | null;
  /** Half-typed composer text by `bindingKey`. Memory only. */
  drafts: Record<string, string>;
  /** Which way the last move went, for the slide. */
  lastNav: 'push' | 'back' | null;

  /** Push by the level rule. */
  push(surface: AskSurface, view: AskView): void;
  /** Pop the top. A conversation with `returnTo` re-opens its item if the item still exists. */
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
  /** Sign-out: both stacks home, no focus request, no drafts. */
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

/** Re-open an item by id, as every opener does, if the planner still has it. */
function reopenItem(itemId: string): void {
  const item = usePlannerStore.getState().items.find((i) => i.id === itemId);
  if (!item) return;
  openEditFor(item as unknown as Task, item.type === 'habit' ? 'habit' : 'task');
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
    pendingFocus: null,
    drafts: {},
    lastNav: null,

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
      setStacks({ ...stacks, [surface]: stack.slice(0, -1) }, 'back');
      // After the pop, so the item opens over the view that was beneath.
      if (top.kind === 'conversation' && top.returnTo) reopenItem(top.returnTo.itemId);
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

    reset: () => set({ stacks: EMPTY_STACKS, pendingFocus: null, drafts: {}, lastNav: null }),
  };
});
