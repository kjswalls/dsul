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

import { recordAgentReply, type ItemEvent } from './db'
import { itemTypeName } from './item-registry'
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
 * Answer the agent. Two writes, and the second is the load-bearing one: the
 * reply goes on the item's trail, which is where the agent reads it back from,
 * and the status flips to `queued` so the next scheduled run picks the work up
 * again. A reply that did not re-queue would look answered and never move.
 *
 * The flip is what takes the item out of Needs you and puts it under With AI
 * activity, spinning: the honest next state. Returns false, writing nothing,
 * for a blank answer, and while the planner is the look-only preview: the
 * store's write barrier (lib/preview-write-guard.ts) would refuse the flip,
 * leaving a reply on the trail of an item that never re-queues.
 */
export function answerAgentQuestion(item: Item, text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || isPlannerPreviewing()) return false
  recordAgentReply(item.id, itemTypeName(item), trimmed)
  usePlannerStore.getState().updateTask(item.id, { aiStatus: 'queued' })
  return true
}
