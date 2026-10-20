import { agentStatusView, showsAgentChip } from './agent-status';
import { packIsStale, type PrepPack } from './prep-packs';

/**
 * ai-work.ts — the account-wide reading of the AI work badges
 * (components/ai/ai-work-badge.tsx), for the do stuff key: is anything being
 * worked on right now, and how many things are ready.
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
}

export interface AiWorkSummary {
  /** Something is being worked on: a prep ask in flight, or a live run. */
  working: boolean;
  /** Packs waiting on open items, written for the title the item has now. */
  ready: number;
}

/** Is a handed-off item's run live and not gone quiet? The row's relay rule. */
export function agentWorking(item: AiWorkItem, now: number): boolean {
  if (!showsAgentChip(item)) return false;
  const view = agentStatusView(item, now);
  return !!view && view.active && !view.stalled;
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
  const working = open.some((i) => prep.preparing[i.id] === true || agentWorking(i, now));
  let ready = 0;
  for (const item of open) {
    const pack = prep.packs[item.id];
    if (pack && !packIsStale(pack, item.title)) ready += 1;
  }
  return { working, ready };
}
