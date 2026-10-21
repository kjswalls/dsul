import { canHandOff } from './agent-handoff';
import { isRecurring } from './recurrence';
import type { Item } from './planner-types';

/**
 * BACKGROUND PREP: while the page is open, the things the person keeps not
 * doing are got ready before they look (memory/plans/power-mode.md, "Background
 * prep"). Kirby's rules, 2026-10-20:
 *
 * - Prep only. Nothing is ever sent, booked, bought or deleted. The model
 *   writes packs (drafts, steps, a question); an agent gets the item handed
 *   over with `aiMode: 'prepare'` (migration 078), which MCP's `dsul_my_work`
 *   tells it means get it ready and stop.
 * - Each item once until it changes: an item is asked about again only when its
 *   title or notes change (an answered question changes the notes).
 * - A daily cap, DAILY_CAP asks a day, counted per browser.
 * - Off by default (the extension rule: nothing that costs money starts on).
 * - "Hand off to…" on an item still gives the agent the whole job; background
 *   prep only ever takes items nobody holds.
 *
 * This file is pure: the settings keys, the ledger, and who is a candidate. The
 * hook that runs it is hooks/use-background-prep.ts.
 */

/** Do stuff's config key for the switch (lib/settings/manifest.ts). */
export const BACKGROUND_PREP_KEY = 'background';
/** Do stuff's config key for who does it: 'model' or 'agent'. */
export const BACKGROUND_WORKER_KEY = 'backgroundWorker';

/** Asks a day, model and agent together. */
export const DAILY_CAP = 20;
/** How often the open page looks for more. */
export const TICK_MS = 10 * 60 * 1000;

export type BackgroundWorker = 'model' | 'agent';

export function backgroundPrepOn(config: Readonly<Record<string, unknown>> | undefined): boolean {
  return config?.[BACKGROUND_PREP_KEY] === true;
}

/** Do stuff's config key for the research switch (prep may search the web). */
export const RESEARCH_KEY = 'research';

/** Off until the person turns it on: every search is billed on their key. */
export function researchOn(config: Readonly<Record<string, unknown>> | undefined): boolean {
  return config?.[RESEARCH_KEY] === true;
}

export function backgroundPrepWorker(config: Readonly<Record<string, unknown>> | undefined): BackgroundWorker {
  return config?.[BACKGROUND_WORKER_KEY] === 'agent' ? 'agent' : 'model';
}

/**
 * What an item was asked about as: when this changes, it may be asked again.
 * Title and notes are what the ask reads of the item itself. A hash (FNV-1a),
 * so the ledger in browser storage holds no word the person wrote.
 */
export function prepSignature(item: Item): string {
  const notes = (item as { notes?: string }).notes ?? '';
  const text = `${item.title.trim()}\u0000${notes.trim()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** One browser's record of the day's asks. */
export interface PrepLedger {
  day: string;
  count: number;
  /** Item id → the signature it was last asked about as. */
  asked: Record<string, string>;
}

/** The ledger for `day`: a new day keeps what was asked but resets the count. */
export function ledgerFor(stored: PrepLedger | null, day: string): PrepLedger {
  if (!stored) return { day, count: 0, asked: {} };
  return stored.day === day ? stored : { day, count: 0, asked: stored.asked };
}

export function remainingToday(ledger: PrepLedger): number {
  return Math.max(0, DAILY_CAP - ledger.count);
}

/** The ledger after asking about `items`. */
export function recordAsked(ledger: PrepLedger, items: readonly Item[]): PrepLedger {
  const asked = { ...ledger.asked };
  for (const item of items) asked[item.id] = prepSignature(item);
  // Ids of items long gone would otherwise pile up in the browser forever.
  const ids = Object.keys(asked);
  if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete asked[id];
  return { ...ledger, count: ledger.count + items.length, asked };
}

export interface CandidateContext {
  todayStr: string;
  /** From lib/active.ts `inactiveItemIdsOn`: paused or switched-off work. */
  inactiveIds: ReadonlySet<string>;
  /** Items that already have a pack written for their current title. */
  hasPack: (item: Item) => boolean;
  ledger: PrepLedger;
}

/**
 * The items worth getting ready, best first: today's, then the braindump's.
 * A task only (the type prep writes for), open, one-off, top-level, held by
 * nobody, wanted today, and not already asked about as it is now.
 */
export function prepCandidates(items: readonly Item[], ctx: CandidateContext): Item[] {
  const today: Item[] = [];
  const dump: Item[] = [];
  for (const item of items) {
    if (item.type !== 'task') continue;
    if (item.status === 'completed' || item.status === 'cancelled') continue;
    if (isRecurring(item) || item.parentItemId || item.assignee) continue;
    if (ctx.inactiveIds.has(item.id)) continue;
    if (ctx.ledger.asked[item.id] === prepSignature(item)) continue;
    if (ctx.hasPack(item)) continue;
    if (item.startDate === ctx.todayStr) today.push(item);
    else if (!item.startDate && !item.isScheduled && !item.timeBucket) dump.push(item);
  }
  return [...today, ...dump];
}

/** The agent's share: what it would see in its queue, the hand-off gate's own rule. */
export function agentCandidates(
  candidates: readonly Item[],
  ctx: { todayStr: string; inactiveIds: ReadonlySet<string> }
): Item[] {
  return candidates.filter((item) => canHandOff(item, { canDelegate: true, ...ctx }));
}
