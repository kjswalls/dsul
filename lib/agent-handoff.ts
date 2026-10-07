import { isOpenLoopOn } from './active';
import { hasAgentState } from './agent-status';
import { assigneeLabel } from './chat-utils';
import { getItemTypeConfig, itemTypeName } from './item-registry';
import { isRecurring } from './recurrence';
import { usePlannerStore } from './planner-store';
import type { Item } from './planner-types';

/**
 * HANDING AN ITEM TO THE AGENT, and taking it back: the hand-off half of
 * delegation (lib/agent-question.ts holds the answer half).
 *
 * The right-click menu's "Hand off to OpenClaw" asks here. Offered means the
 * agent will actually see the item: `canHandOff` is the agent's own queue
 * filter (lib/mcp/tools.ts `selectAssignedWork`: an assignable type, still
 * wanting doing today, not paused or switched off by a routine or season), so
 * nothing is handed off to sit at "Queued" forever, picked up by no one.
 *
 * A repeating task is not offered either: an item carries one agent status,
 * so once a run is done the series never goes back in the queue, and
 * delegation is for one-off work (memory/plans/ai-vision.md, decision 5).
 *
 * Only an agent can do background work: the gate is `canDelegate` (an
 * OpenClaw agent paired, whoever answers chat), never "a model is connected",
 * and `openclaw` is the only assignee anything consumes.
 */

/** The only assignee the agent API and MCP queue consume. Never `beacon`. */
export const DELEGATE_ASSIGNEE = 'openclaw';

/** The delegate's name as the user sees it ("OpenClaw"). */
export function delegateName(): string {
  return assigneeLabel(DELEGATE_ASSIGNEE);
}

export interface HandOffContext {
  /** From the gate (lib/ai-registry.ts), never re-derived. */
  canDelegate: boolean;
  /** Wall-clock today, yyyy-MM-dd in the user's zone. */
  todayStr: string;
  /** From lib/active.ts `inactiveItemIdsOn`: paused or switched-off work. */
  inactiveIds: ReadonlySet<string>;
}

/** May this item be handed to the agent now? */
export function canHandOff(item: Item, ctx: HandOffContext): boolean {
  if (!ctx.canDelegate) return false;
  if (!getItemTypeConfig(itemTypeName(item)).agentAssignable) return false;
  if ('assignee' in item && item.assignee) return false;
  if (isRecurring(item)) return false;
  return isOpenLoopOn(item, ctx.todayStr) && !ctx.inactiveIds.has(item.id);
}

/**
 * The item's agent fields as the agent's queue reads them: an assignment to
 * the delegate with no status yet is queued work (lib/mcp/tools.ts
 * `selectAssignedWork` serves it as 'queued'; the agent API can write an
 * assignee alone).
 */
export function heldState(item: Item): { assignee?: string; aiStatus?: string; aiStatusAt?: string } {
  const held = item as { assignee?: string; aiStatus?: string; aiStatusAt?: string };
  if (held.assignee === DELEGATE_ASSIGNEE && held.aiStatus === undefined) return { ...held, aiStatus: 'queued' };
  return held;
}

/**
 * May the user take it back? Whenever the agent holds it in a live state
 * (queued, working, needs you, couldn't finish). Never gated on `canDelegate`:
 * taking your own item back must not depend on the agent being paired. Not
 * once it is done: taking back clears the agent's report, which the item
 * panel keeps.
 */
export function canTakeBack(item: Item): boolean {
  return hasAgentState(heldState(item));
}

/** Hand it off: one undoable write, named so the undo strip offers ⌘Z. */
export function handOffItem(item: Item): void {
  usePlannerStore
    .getState()
    .updateTask(
      item.id,
      { assignee: DELEGATE_ASSIGNEE, aiStatus: 'queued' },
      { label: `Hand off to ${delegateName()}: ${item.title}` }
    );
}

/**
 * Take it back: clears the assignment, its status and any report. The status
 * write moves the agent clock, so a late report from the run it was on is
 * refused (the progress route answers 409 for an unassigned item).
 */
export function takeBackItem(item: Item): void {
  const who = 'assignee' in item && item.assignee ? assigneeLabel(item.assignee) : delegateName();
  usePlannerStore
    .getState()
    .updateTask(
      item.id,
      { assignee: undefined, aiStatus: undefined, aiResult: undefined },
      { label: `Take back from ${who}: ${item.title}` }
    );
}
