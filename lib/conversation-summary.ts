import type { ProposalOperation } from './planner-types';
import { assigneeLabel } from './chat-utils';
import { CHAT_LIMITS, type ConversationChanges, type ConversationSummary } from './conversation-types';

/**
 * What a conversation changed, as History's second line says it.
 *
 * Pure and client-safe. A conversation stores four counters (migration 057);
 * everything a row SAYS is derived here, at render time, from those counters
 * and the item as the planner holds it now. Live agent state must never freeze
 * into a row: "waiting on you" read from a column would still be saying it a
 * week after the answer.
 */

export const NO_CHANGES: Readonly<ConversationChanges> = Object.freeze({ added: 0, steps: 0, moved: 0, changed: 0 });

/** The scheduling fields: an update touching any of them MOVED the item. */
const MOVE_FIELDS = ['startDate', 'timeBucket', 'startTime'] as const;

/**
 * What one accepted proposal did, counted in DISTINCT items per bucket:
 *   - a create with `parentItemId` is a step under that item;
 *   - any other create is an added item;
 *   - an update touching startDate, timeBucket or startTime moved its item;
 *   - any other update changed it.
 * An item both moved and changed in one proposal counts once, as moved: the
 * line is about what the user will notice. Each counter is at most
 * CHAT_LIMITS.changesPerCall (a proposal carries at most 20 operations), so a
 * tally always fits one PATCH.
 */
export function tallyOperations(ops: readonly ProposalOperation[]): ConversationChanges {
  let added = 0;
  let steps = 0;
  const moved = new Set<string>();
  const changed = new Set<string>();
  for (const op of ops) {
    if (op.kind === 'create') {
      if (op.parentItemId) steps += 1;
      else added += 1;
      continue;
    }
    const touchesSchedule = MOVE_FIELDS.some((f) => op[f] !== undefined);
    if (touchesSchedule) moved.add(op.itemId);
    else changed.add(op.itemId);
  }
  for (const id of moved) changed.delete(id);
  const cap = (n: number) => Math.min(n, CHAT_LIMITS.changesPerCall);
  return { added: cap(added), steps: cap(steps), moved: cap(moved.size), changed: cap(changed.size) };
}

export function hasChanges(c: ConversationChanges | null | undefined): boolean {
  return !!c && c.added + c.steps + c.moved + c.changed > 0;
}

/** The counters after another tally, each held to the column's ceiling (100,000). */
export function addChanges(a: ConversationChanges, b: Partial<ConversationChanges>): ConversationChanges {
  const sum = (x: number, y: number | undefined) => Math.min(100_000, x + Math.max(0, y ?? 0));
  return {
    added: sum(a.added, b.added),
    steps: sum(a.steps, b.steps),
    moved: sum(a.moved, b.moved),
    changed: sum(a.changed, b.changed),
  };
}

const items = (n: number) => (n === 1 ? '1 item' : `${n} items`);

/**
 * The non-zero counters, joined with " · ", in a fixed order: moved, added,
 * steps, changed. Null when nothing changed.
 */
export function changePhrase(c: ConversationChanges): string | null {
  const parts: string[] = [];
  if (c.moved > 0) parts.push(`Moved ${items(c.moved)}`);
  if (c.added > 0) parts.push(`Added ${items(c.added)}`);
  if (c.steps > 0) parts.push(c.steps === 1 ? 'Added a step' : `Broke it into ${c.steps} steps`);
  if (c.changed > 0) parts.push(`Changed ${items(c.changed)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The fields of a live item the second line reads. */
export interface SecondLineItem {
  assignee?: string | null;
  aiStatus?: string | null;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * History's second line for one conversation. The first rule that applies:
 *
 *   item conversation, item live, delegated and blocked   "With OpenClaw · waiting on you"
 *   …same, queued or working                               "With OpenClaw · working on it"
 *   item conversation, item live                           "Item conversation · moved 1 item" / "· no changes"
 *   item conversation, item gone                           "Item conversation · item deleted"
 *   general, with changes                                  "Moved 3 items · Added 1 item"
 *   general, none                                          "No changes"
 *
 * "OpenClaw" is whoever the item is delegated to, as the user reads it
 * (`assigneeLabel`: a stored 'beacon' reads "AI"). `item` is the planner's
 * live item, or null/undefined when it is gone.
 */
export function historySecondLine(
  summary: Pick<ConversationSummary, 'itemId' | 'changes'>,
  item: SecondLineItem | null | undefined
): string {
  const phrase = changePhrase(summary.changes);
  if (summary.itemId === null) return phrase ?? 'No changes';
  if (!item) return 'Item conversation · item deleted';
  if (item.assignee) {
    const who = assigneeLabel(item.assignee);
    if (item.aiStatus === 'blocked') return `With ${who} · waiting on you`;
    if (item.aiStatus === 'queued' || item.aiStatus === 'working') return `With ${who} · working on it`;
  }
  return `Item conversation · ${phrase ? lowerFirst(phrase) : 'no changes'}`;
}
