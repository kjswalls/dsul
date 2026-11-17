/**
 * agent-question.ts — the answer half of an agent's `blocked`, in one place.
 *
 * Two surfaces answer an agent's question: the item's own AgentReply
 * (components/planner/item-detail-sections.tsx) and Ask home's Needs-you card
 * (components/ai/ask/needs-you.tsx). Both read the same tappable options and
 * write the same answer, so both rules live here, and the React half (the
 * fetch, and the options tagged to the question they belong to) lives in
 * hooks/use-agent-question.ts.
 *
 * Client-safe (tests/unit/ai-server-boundary.test.ts).
 */

import { create } from 'zustand'
import { recordAgentReply, type ItemEvent } from './db'
import type { SentAnswer } from './agent-exchange'
import { itemTypeName } from './item-registry'
import { assigneeLabel } from './chat-utils'
import { usePlannerStore } from './planner-store'
import { isPlannerPreviewing } from './planner-ready'
import type { Item } from './planner-types'

/**
 * The options the agent offered FOR THE QUESTION ON SCREEN, or none.
 *
 * `events` is the item's trail, newest first (lib/db.ts `fetchItemEvents`).
 * Two things this has to get right, both of which AgentReply got wrong first:
 *
 * 1. MATCH THE QUESTION, not just "the newest event". The question the user
 *    reads comes from `aiResult`, which `dsul_report_progress` can also set,
 *    and that path writes no `agent_question` event. So an agent that asked
 *    with options, then asked again through the old tool, would leave the new
 *    question on screen above the OLD question's buttons. Comparing the
 *    payload against `aiResult` ties the two together, and handles a lost
 *    event (no match, no buttons) and a truncated feed the same safe way.
 *
 * 2. STILL OPEN. A reply recorded AFTER the question means it was answered,
 *    and re-offering the choices would invite a duplicate answer.
 *
 * Only non-empty strings survive: whatever an agent wrote arrives unchecked.
 */
export function pickOpenQuestionOptions(
  events: readonly Pick<ItemEvent, 'action' | 'payload' | 'createdAt'>[],
  aiResult: string | null | undefined
): string[] {
  const question = events.find((e) => e.action === 'agent_question')
  if (!question) return []

  const asked = typeof question.payload?.question === 'string' ? question.payload.question : ''
  if (asked.trim() !== (aiResult ?? '').trim()) return []

  const answeredSince = events.find((e) => e.action === 'agent_reply')
  if (answeredSince && answeredSince.createdAt > question.createdAt) return []

  const raw = Array.isArray(question.payload?.options) ? (question.payload.options as unknown[]) : []
  return raw.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
}

/**
 * Write to the agent that holds the item: an answer to its question, or a
 * message after it reported (Kirby, 2026-11-14: a reply in an item handed to
 * Claude should simply reach Claude, whatever state the work is in).
 *
 * The message goes on the item's trail, which is where the agent reads it back
 * from (MCP `dsul_item_activity`, an `agent_reply` entry). Then, unless a run
 * is going, the status flips to `queued`: that is what takes a question out of
 * Needs you, reopens work the agent called done or could not finish, and wakes
 * a connected app's routine (lib/handoff-wake.ts `requeues`). A message that
 * did not re-queue would look sent and never move.
 *
 * A run that is `working` is left alone. Re-queueing it would move the item's
 * agent clock under the run, and the run's own next report would be refused
 * as stale. Its report hears the message instead: the progress route hands
 * back whatever the user wrote since the run's last report
 * (lib/agent-replies-server.ts), and puts finished work back in the queue.
 *
 * Returns false, writing nothing, for a blank message, for an item no agent
 * holds, and while the planner is the look-only preview: the store's write
 * barrier (lib/preview-write-guard.ts) would refuse the flip, leaving a reply
 * on the trail of an item that never re-queues.
 */
export function messageAgent(item: Item, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isPlannerPreviewing() || !heldByAgent(item)) return false;
  recordAgentReply(item.id, itemTypeName(item), trimmed);
  useAgentAnswers.getState().sent(item.id, { text: trimmed, at: Date.now() });
  if ((item as { aiStatus?: string }).aiStatus !== 'working') {
    usePlannerStore.getState().updateTask(item.id, { aiStatus: 'queued' });
  }
  return true;
}

/** The answer half of `blocked`: a message to the agent (`messageAgent`). */
export function answerAgentQuestion(item: Item, text: string): boolean {
  return messageAgent(item, text);
}

/**
 * Messages sent to an agent from this device, per item, so the item's
 * exchange (lib/agent-exchange.ts) shows one the moment it is sent: the
 * trail's write is fire and forget, and a re-read straight after can miss it.
 * Memory only; the trail is the record. And, per item, whether the item's box
 * has been pointed at the user's own model instead of the agent holding it.
 */
interface AgentAnswersState {
  byItem: Record<string, SentAnswer[]>
  /** Items whose box the user pointed back at their own model. */
  toModel: Record<string, true>
  sent: (itemId: string, answer: SentAnswer) => void
  setToModel: (itemId: string, on: boolean) => void
}

export const useAgentAnswers = create<AgentAnswersState>((set) => ({
  byItem: {},
  toModel: {},
  sent: (itemId, answer) =>
    set((s) => ({ byItem: { ...s.byItem, [itemId]: [...(s.byItem[itemId] ?? []), answer].slice(-10) } })),
  setToModel: (itemId, on) =>
    set((s) => {
      const toModel = { ...s.toModel }
      if (on) toModel[itemId] = true
      else delete toModel[itemId]
      return { toModel }
    }),
}))

/** An agent holds this item: it was handed to one, in any state of the work. */
export function heldByAgent(item: Item | undefined | null): item is Item & { assignee: string } {
  const held = item as { assignee?: unknown } | null | undefined;
  return typeof held?.assignee === 'string' && held.assignee.trim() !== '';
}

/** An agent holds this item and is waiting on the user's answer. */
export function awaitsAnswer(item: Item | undefined | null): item is Item & { assignee: string } {
  return heldByAgent(item) && (item as { aiStatus?: string }).aiStatus === 'blocked';
}

/**
 * Does the item's box talk to the agent rather than the model? Whenever an
 * agent holds the item, by default: the box under an agent's work is where you
 * talk to that agent (Kirby, 2026-10-15 for an open question; 2026-11-14 for
 * every state). The user can point it at their own model for this item
 * (`useAgentAnswers.setToModel`, the box's who chip).
 */
export function boxAnswersAgent(item: Item | undefined | null, toModel: Record<string, true>): boolean {
  return heldByAgent(item) && !toModel[item.id];
}

/**
 * The one place the item's box hands a message to the agent instead of the
 * model (lib/open-chat.ts `sendFrom` asks this first). True when it did.
 */
export function routeItemSendToAgent(itemId: string, text: string): boolean {
  const item = usePlannerStore.getState().items.find((i) => i.id === itemId);
  if (!boxAnswersAgent(item, useAgentAnswers.getState().toModel)) return false;
  return messageAgent(item as Item, text);
}

/**
 * The agent the item's box talks to right now, by name ("Claude"), or null when
 * it talks to the model as usual. For the box's placeholder and its who chip
 * (components/ai/answerer-chip.tsx).
 */
export function useBoxAnswersAgent(itemId: string | null): string | null {
  const item = usePlannerStore((s) => (itemId ? s.items.find((i) => i.id === itemId) : undefined));
  const toModel = useAgentAnswers((s) => s.toModel);
  if (!itemId || !boxAnswersAgent(item, toModel)) return null;
  return assigneeLabel((item as { assignee: string }).assignee);
}

/** The agent holding this item, by name, whichever way the box points; null when none does. */
export function useItemAgent(itemId: string | null): string | null {
  return usePlannerStore((s) => {
    const item = itemId ? s.items.find((i) => i.id === itemId) : undefined;
    return heldByAgent(item) ? assigneeLabel(item.assignee) : null;
  });
}

/** What the box's placeholder says while it talks to an agent. */
export function agentPlaceholder(name: string, blocked: boolean): string {
  return blocked ? `Answer ${name}…` : `Message ${name}…`;
}

/** An agent is waiting on the user's answer on this item (whichever way the box points). */
export function useAgentQuestionOpen(itemId: string | null): boolean {
  return usePlannerStore((s) => (itemId ? awaitsAnswer(s.items.find((i) => i.id === itemId)) : false))
}
