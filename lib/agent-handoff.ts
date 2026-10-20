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
  // Held by someone, unless it was only to get it ready and that is over:
  // "Hand off to…" then gives the whole job (background prep never does).
  if ('assignee' in item && item.assignee && !prepFinished(item)) return false;
  if (isRecurring(item)) return false;
  return isOpenLoopOn(item, ctx.todayStr) && !ctx.inactiveIds.has(item.id);
}

/** A get-it-ready hand-off whose run has ended, done or not. */
function prepFinished(item: Item): boolean {
  const status = (item as { aiStatus?: string }).aiStatus;
  return aiModeOf(item) === 'prepare' && (status === 'done' || status === 'failed');
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

/**
 * Hand it off: one undoable write, named so the undo strip offers ⌘Z. OpenClaw
 * hears it within seconds on GET /api/agent/events; an app with a wake is
 * woken once the write lands (lib/handoff-wake.ts, hooked at planner-store's
 * `dbUpdateItem`).
 *
 * `to` is OpenClaw unless the caller names another agent
 * (lib/agent-assignees.ts): a connected app reads its own queue through MCP's
 * `dsul_my_work` and is never woken, so it finds the item the next time it
 * looks.
 */
export function handOffItem(item: Item, to: string = DELEGATE_ASSIGNEE, opts: { mode?: AiMode } = {}): void {
  usePlannerStore
    .getState()
    .updateTask(
      item.id,
      { assignee: to, aiStatus: 'queued', ...modeWrite(item, opts.mode) },
      { label: opts.mode ? `Get ready with ${assigneeLabel(to)}: ${item.title}` : `Hand off to ${assigneeLabel(to)}: ${item.title}` }
    );
}

/**
 * How a hand-off may be worked (migration 078). 'prepare' is background
 * prep's: the agent drafts, plans and asks, and never sends, books, pays or
 * deletes (MCP's `dsul_my_work` says so to the agent).
 */
export type AiMode = 'prepare';

/** The item's mode, or none: a plain hand-off does the task. */
export function aiModeOf(item: Item): AiMode | undefined {
  return (item as { aiMode?: string }).aiMode === 'prepare' ? 'prepare' : undefined;
}

/**
 * The mode half of a hand-off or a take-back. Written only when it changes, so
 * a plain hand-off of an item that never had one names no new column, and an
 * item that was handed off to get ready loses the limit when it is handed off
 * to be done.
 */
function modeWrite(item: Item, mode: AiMode | undefined): { aiMode?: AiMode } {
  if (mode) return { aiMode: mode };
  return aiModeOf(item) ? { aiMode: undefined } : {};
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
      { assignee: undefined, aiStatus: undefined, aiResult: undefined, ...modeWrite(item, undefined) },
      { label: `Take back from ${who}: ${item.title}` }
    );
}
