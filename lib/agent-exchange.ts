/**
 * agent-exchange.ts — what an agent and the user said to each other about an
 * item, as a conversation (components/ai/agent-exchange.tsx).
 *
 * An agent never writes to the item's saved conversation: its questions, the
 * user's answers and its result live on the item's trail (`item_events`) and
 * its `aiResult`. Read as Activity lines they were truncated and easy to miss
 * (Kirby, 2026-10-14: a Claude question about a dentist sat unseen for hours),
 * so this folds them into turns that read like the item's chat. Nothing new is
 * stored, and nothing here reaches a model.
 *
 * Pure: the trail (newest first, as lib/db.ts `fetchItemEvents` returns it),
 * the item, and any answers sent this session that the trail does not show yet.
 * Client-safe.
 */

import type { ItemEvent } from './db'
import { assigneeLabel } from './chat-utils'

export type ExchangeEntry =
  /** The hand-off that started this exchange: a divider line. */
  | { kind: 'handoff'; key: string; at: number; to: string }
  /** The agent speaking: a question, or what it came back with. */
  | {
      kind: 'agent'
      key: string
      at: number
      text: string
      question: boolean
      failed?: boolean
      /** It finished after the user's answer without a word: `text` says so, drawn muted. */
      silent?: boolean
    }
  /** The user's answer. */
  | { kind: 'you'; key: string; at: number; text: string }

export interface AgentExchange {
  /** The agent's name, as the item's assignee reads ("Claude", "OpenClaw"). */
  agent: string
  entries: ExchangeEntry[]
  /** The question waiting on the user, if one is. */
  openQuestion: boolean
  /** The agent has the ball (queued or working) after something was said. */
  working: boolean
}

/** An answer sent from this device that the trail may not carry yet. */
export interface SentAnswer {
  text: string
  at: number
}

interface ExchangeItem {
  assignee?: string
  aiStatus?: string
  aiResult?: string
  aiStatusAt?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const time = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

export function buildAgentExchange(
  events: readonly ItemEvent[],
  item: ExchangeItem,
  sent: readonly SentAnswer[] = []
): AgentExchange | null {
  if (!item.assignee) return null
  const agent = assigneeLabel(item.assignee)

  // Only the current hand-off's exchange: a new hand-off starts a new one.
  const oldestFirst = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  let start = 0
  oldestFirst.forEach((e, i) => {
    if (e.action === 'update' && e.payload && 'assignee' in e.payload && str(e.payload.assignee)) start = i
  })

  const entries: ExchangeEntry[] = []
  const asked = new Set<string>()
  for (const e of oldestFirst.slice(start)) {
    const p = e.payload ?? {}
    const at = time(e.createdAt)
    if (e.action === 'update' && 'assignee' in p && str(p.assignee)) {
      entries.push({ kind: 'handoff', key: e.id, at, to: assigneeLabel(str(p.assignee)) })
    } else if (e.action === 'agent_question') {
      const text = str(p.question)
      if (!text) continue
      asked.add(text)
      entries.push({ kind: 'agent', key: e.id, at, text, question: true })
    } else if (e.action === 'agent_reply') {
      const text = str(p.text)
      if (text) entries.push({ kind: 'you', key: e.id, at, text })
    } else if (e.action === 'update' && p.by === 'agent') {
      const result = str(p.aiResult)
      const status = str(p.aiStatus)
      // A question asked through dsul_report_progress alone writes no
      // agent_question event; its `blocked` result IS the question.
      if (status === 'blocked' && result && !asked.has(result)) {
        asked.add(result)
        entries.push({ kind: 'agent', key: e.id, at, text: result, question: true })
      } else if ((status === 'done' || status === 'failed') && result) {
        entries.push({ kind: 'agent', key: e.id, at, text: result, question: false, failed: status === 'failed' })
      }
    }
  }

  // A trail that is gone (180 days) or lost an event still shows where things stand.
  const result = str(item.aiResult)
  if (item.aiStatus === 'blocked' && result && !asked.has(result)) {
    entries.push({ kind: 'agent', key: `now-${item.aiStatusAt ?? ''}`, at: time(item.aiStatusAt), text: result, question: true })
  }

  if ((item.aiStatus === 'done' || item.aiStatus === 'failed') && result) {
    const known = entries.some((e) => e.kind === 'agent' && e.text === result)
    if (!known) {
      entries.push({
        kind: 'agent',
        key: `now-${item.aiStatusAt ?? ''}`,
        at: time(item.aiStatusAt),
        text: result,
        question: false,
        failed: item.aiStatus === 'failed',
      })
    }
  }

  // Answers sent here that the trail does not show yet (its write is fire and forget),
  // and only those sent since this hand-off: the store outlives a re-hand-off.
  const handoffAt = entries.find((e) => e.kind === 'handoff')?.at ?? 0
  for (const s of sent) {
    if (s.at < handoffAt) continue
    const known = entries.some((e) => e.kind === 'you' && e.text === s.text && Math.abs(e.at - s.at) < 5 * 60_000)
    if (!known) entries.push({ kind: 'you', key: `sent-${s.at}`, at: s.at, text: s.text })
  }
  entries.sort((a, b) => a.at - b.at)

  // Finished after the user's answer with nothing new to say (Kirby, 2026-10-24:
  // Claude marked a gym question done two minutes after being answered, and the
  // answer read as the last word). Say so rather than leave the answer hanging.
  const tail = entries[entries.length - 1]
  if ((item.aiStatus === 'done' || item.aiStatus === 'failed') && tail?.kind === 'you') {
    const failed = item.aiStatus === 'failed'
    entries.push({
      kind: 'agent',
      key: `silent-${item.aiStatusAt ?? ''}`,
      at: Math.max(time(item.aiStatusAt), tail.at),
      text: failed ? 'Stopped without replying to your answer.' : 'Marked it done without replying to your answer.',
      question: false,
      failed,
      silent: true,
    })
  }

  const said = entries.some((e) => e.kind !== 'handoff')
  if (!said) return null

  const last = entries[entries.length - 1]
  const openQuestion = item.aiStatus === 'blocked' && last.kind === 'agent' && last.question
  const working = (item.aiStatus === 'queued' || item.aiStatus === 'working') && last.kind !== 'agent'
  return { agent, entries, openQuestion, working }
}

/**
 * The last exchange drawn for each item, so the item's conversation with the
 * user's own model can be told what the agent said (Kirby, 2026-11-14: a box
 * switched from Claude to the model should not be blind to Claude's findings).
 * Filled by hooks/use-agent-exchange.ts while the item is open; memory only.
 * The agent never sees the model's side: nothing here goes the other way.
 */
const remembered = new Map<string, AgentExchange>();
const REMEMBER_MAX = 50;

export function rememberExchange(itemId: string, exchange: AgentExchange | null): void {
  remembered.delete(itemId);
  if (!exchange) return;
  remembered.set(itemId, exchange);
  if (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value as string);
}

export function rememberedExchange(itemId: string): AgentExchange | null {
  return remembered.get(itemId) ?? null;
}

/** How much of the exchange the model is told: the newest turns, each clipped. */
const CONTEXT_TURNS = 8;
const CONTEXT_CHARS = 1200;

/**
 * The exchange as lines for the model's context (lib/ai-context.ts), newest
 * turns last. Empty when nothing was said. Silent markers are left out: they
 * are the app's words, not the agent's.
 */
export function exchangeContextLines(exchange: AgentExchange | null): string[] {
  if (!exchange) return [];
  const said = exchange.entries.filter(
    (e): e is Exclude<ExchangeEntry, { kind: 'handoff' }> => e.kind !== 'handoff' && !(e.kind === 'agent' && e.silent)
  );
  if (said.length === 0) return [];
  const clip = (t: string) => (t.length > CONTEXT_CHARS ? `${t.slice(0, CONTEXT_CHARS)}…` : t);
  return said.slice(-CONTEXT_TURNS).map((e) => {
    if (e.kind === 'you') return `- The user, to ${exchange.agent}: ${clip(e.text)}`;
    const how = e.kind === 'agent' && e.question ? 'asked' : e.kind === 'agent' && e.failed ? "couldn't finish" : 'reported';
    return `- ${exchange.agent} ${how}: ${clip(e.text)}`;
  });
}
