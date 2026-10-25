import { agentStatusView, showsAgentChip } from './agent-status';
import { packIsQuestion, packIsStale, type PrepPack } from './prep-packs';

/**
 * ai-work.ts — the account-wide reading of the AI's work, for the do stuff key
 * and the dock's one line about it (components/notices/ai-work-notice.tsx): is
 * anything being worked on right now, and how many things are ready.
 *
 * Pure, like agent-status.ts, and built from the same two sources the rows
 * read, so the key never disagrees with the rows under it: an item handed off
 * with a live run that has not gone quiet, and the prep store's asks and packs.
 */

export interface AiWorkItem {
  id: string;
  title: string;
  status?: string;
  assignee?: string;
  aiStatus?: string;
  aiStatusAt?: string;
  aiMode?: string;
}

export interface AiWorkSummary {
  /** Something is being worked on: a prep ask in flight, or a live run. */
  working: boolean;
  /** How many open items are being worked on. */
  workingCount: number;
  /** Packs waiting on open items, written for the title the item has now. */
  ready: number;
  /** Of `ready`, the packs that are a question for the person. */
  questions: number;
}

/** Is a handed-off item's run live and not gone quiet? The row's relay rule. */
export function agentWorking(item: AiWorkItem, now: number): boolean {
  if (!showsAgentChip(item)) return false;
  const view = agentStatusView(item, now);
  return !!view && view.active && !view.stalled;
}

/**
 * Did an agent finish getting an open item ready? Background prep hands an
 * item over with aiMode 'prepare' (lib/background-prep.ts); 'done' then means
 * the prep is done, never the item, so it reads as ready like a pack.
 */
export function agentPrepReady(item: Pick<AiWorkItem, 'assignee' | 'aiStatus' | 'aiMode' | 'status'>): boolean {
  if (item.status === 'completed' || item.status === 'cancelled') return false;
  return !!item.assignee && item.aiMode === 'prepare' && item.aiStatus === 'done';
}

/**
 * Did an agent finish an open item it was handed, and is the item waiting for
 * the user to check the work and tick it? An agent's 'done' is its report,
 * never the item (lib/agent-finish.ts): the row says so until the item is
 * ticked off. Prep is the exception, read by `agentPrepReady`.
 */
export function agentFinished(item: Pick<AiWorkItem, 'assignee' | 'aiStatus' | 'aiMode' | 'status'>): boolean {
  if (item.status === 'completed' || item.status === 'cancelled') return false;
  return !!item.assignee && item.aiStatus === 'done' && item.aiMode !== 'prepare';
}

/** Handed-off items with a live state at all: whether the key needs a clock. */
export function hasLiveRun(items: readonly AiWorkItem[]): boolean {
  return items.some((i) => showsAgentChip(i) && (i.aiStatus === 'queued' || i.aiStatus === 'working'));
}

export function aiWorkSummary(
  items: readonly AiWorkItem[],
  prep: { preparing: Readonly<Record<string, true>>; packs: Readonly<Record<string, PrepPack>> },
  now: number
): AiWorkSummary {
  const open = items.filter((i) => i.status !== 'completed' && i.status !== 'cancelled');
  const workingCount = open.filter((i) => prep.preparing[i.id] === true || agentWorking(i, now)).length;
  let ready = 0;
  let questions = 0;
  for (const item of open) {
    const pack = prep.packs[item.id];
    const fresh = !!pack && !packIsStale(pack, item.title);
    if (fresh || agentPrepReady(item)) ready += 1;
    if (fresh && packIsQuestion(pack.pack)) questions += 1;
  }
  return { working: workingCount > 0, workingCount, ready, questions };
}
