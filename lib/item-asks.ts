import { selectOverdue } from './overdue';
import { getItemTypeConfig, itemTypeName } from './item-registry';
import { isRecurring } from './recurrence';
import type { Item } from './planner-types';

/**
 * WHAT CAN BE ASKED OF THE AI ABOUT ONE ITEM, declared once.
 *
 * The item's right-click menu (components/planner/item-context-menu.tsx) lists
 * these under "Ask AI"; the item panel's "Break it down" button asks
 * `canBreakDown` too, so the menu and the panel can never disagree about
 * whether an item can be broken down. What each one DOES lives in
 * lib/open-chat.ts (`askAboutItem`, `breakDownItem`, `findTimeFor`), the one
 * place that decides where a message lands; this module only gates, labels
 * and words, and is pure over (item, context).
 *
 * The submenu is short on purpose: no item shows more than four rows. "Help me
 * start" and "Help me get unstuck" are one row whose wording follows the item,
 * and a habit gets its own one ask instead of the task-shaped ones.
 *
 * COPY CONTRACT (lib/ai-openers.ts, shared with proposal-card.tsx and
 * morning-check.tsx): every prompt is phrased as the user, who is the one
 * saying it; none names a failure, counts a miss or implies lateness. They say
 * "this", never the title: an item's conversation already tells the model
 * which item it is about (lib/ai-context.ts, the focused-item section).
 */

export type ItemAskId = 'ask' | 'breakdown' | 'start' | 'findTime' | 'keep';

export interface ItemAskContext {
  /** Wall-clock today, yyyy-MM-dd in the user's zone. */
  todayStr: string;
  /** From lib/active.ts `inactiveItemIdsOn`: paused work is set aside, not sitting. */
  inactiveIds: ReadonlySet<string>;
  /** Goal milestones: their start date is a target date, so nothing here moves one. */
  milestoneIds: ReadonlySet<string>;
  /** The item already has its one saved conversation (conversations-store `itemIndex`). */
  hasConversation: boolean;
  /** From the gate (lib/ai-registry.ts), never re-derived. */
  canChat: boolean;
  canPropose: boolean;
}

export interface ItemAsk {
  id: ItemAskId;
  label: (item: Item, ctx: ItemAskContext) => string;
  eligible: (item: Item, ctx: ItemAskContext) => boolean;
  /**
   * How it runs:
   *   compose    open the item's conversation with its box focused; nothing is sent
   *   send       send `prompt` into the item's conversation
   *   breakdown  the panel's "Break it down" card (proposal-store, `item:<id>`)
   *   propose    a plan card on Ask home (proposal-store 'ask'), built from `prompt`
   */
  kind: 'compose' | 'send' | 'breakdown' | 'propose';
  prompt?: (item: Item, ctx: ItemAskContext) => string;
}

function isSubtask(item: Item): boolean {
  return 'parentItemId' in item && !!item.parentItemId;
}

/**
 * A one-off that is done or cancelled: there is nothing left to start, break
 * down or find a time for. A repeating item is never finished as a whole.
 */
function isFinished(item: Item): boolean {
  if (item.type === 'habit' || isRecurring(item)) return false;
  return item.status === getItemTypeConfig(itemTypeName(item)).doneStatus || item.status === 'cancelled';
}

/** Past its date and still wanted (lib/overdue.ts, the one definition). */
export function isSitting(item: Item, ctx: Pick<ItemAskContext, 'todayStr' | 'inactiveIds'>): boolean {
  return selectOverdue([item], ctx.todayStr, ctx.inactiveIds).length > 0;
}

/**
 * "Break it down": a type that may carry subtasks, and not a subtask itself.
 * One level is all the panel renders; the validator and lib/db.ts both refuse
 * a grandchild, so offering it on a subtask would only produce a rejected
 * operation.
 */
export function canBreakDown(item: Item, canPropose: boolean): boolean {
  return canPropose && getItemTypeConfig(itemTypeName(item)).subtasks && !isSubtask(item);
}

/** A streak-counting type (habits) gets "Make this easier to keep" instead of the task-shaped asks. */
function keepsStreak(item: Item): boolean {
  return getItemTypeConfig(itemTypeName(item)).counters.streak;
}

export const ITEM_ASKS: Record<ItemAskId, ItemAsk> = {
  ask: {
    id: 'ask',
    kind: 'compose',
    label: (_item, ctx) => (ctx.hasConversation ? 'Continue conversation' : 'Ask about this…'),
    eligible: (_item, ctx) => ctx.canChat,
  },
  breakdown: {
    id: 'breakdown',
    kind: 'breakdown',
    label: () => 'Break it down',
    eligible: (item, ctx) => canBreakDown(item, ctx.canPropose) && !isFinished(item),
  },
  start: {
    id: 'start',
    kind: 'send',
    label: (item, ctx) => (isSitting(item, ctx) ? 'Help me get unstuck' : 'Help me start'),
    eligible: (item, ctx) => ctx.canChat && !keepsStreak(item) && !isFinished(item),
    prompt: (item, ctx) =>
      isSitting(item, ctx)
        ? "I'd like to get this moving. Help me figure out what's in the way, and one small step I could take now."
        : "Help me get started on this. What's the smallest first step I could take?",
  },
  findTime: {
    id: 'findTime',
    kind: 'propose',
    label: () => 'Find a time for this',
    // A plan card can move a one-off; a repeating item's schedule is its
    // series, which no card may rewrite. A time already set is a time found.
    eligible: (item, ctx) => {
      if (!ctx.canChat || !ctx.canPropose || isFinished(item) || isSubtask(item)) return false;
      if (item.type === 'habit' || isRecurring(item) || ctx.milestoneIds.has(item.id)) return false;
      if (!getItemTypeConfig(itemTypeName(item)).dateAddressable) return false;
      return !item.startTime;
    },
    // The id rides along: the plan's context lists at most sixty items
    // (lib/proposal.ts buildProposalContext), and this one may not be among them.
    prompt: (item) =>
      `Find a good time for "${item.title}" [${item.id}] in the next few days, around what's already planned. ` +
      'Only schedule this one item; leave everything else where it is.',
  },
  keep: {
    id: 'keep',
    kind: 'send',
    label: () => 'Make this easier to keep',
    eligible: (item, ctx) => ctx.canChat && keepsStreak(item),
    prompt: () => 'Help me make this easier to keep up. Could it be smaller, or tied to something I already do?',
  },
};

/** Menu order. */
export const ITEM_ASK_ORDER: readonly ItemAskId[] = ['ask', 'breakdown', 'start', 'findTime', 'keep'];

/** The asks to offer on this item, in menu order. Empty when nothing can answer. */
export function itemAsksFor(item: Item, ctx: ItemAskContext): ItemAsk[] {
  return ITEM_ASK_ORDER.map((id) => ITEM_ASKS[id]).filter((a) => a.eligible(item, ctx));
}
