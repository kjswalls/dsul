/**
 * Messages the user sends an agent from Ask, outside any item (migration 089,
 * memory/plans/agent-chat.md).
 *
 * An agent connected over MCP (Claude, Cursor) is not a live chat:
 * the message waits in `agent_messages`, the agent's routine is woken, and the
 * agent answers through `dsul_reply`. The browser then saves that answer into
 * the conversation as a reply whose answerer is `agent:<name>`.
 *
 * THE BOUNDARY: an agent reads only rows addressed to it. Saved conversations
 * stay out of every agent route and MCP tool.
 *
 * Pure and client-safe: the shapes, the caps and the answerer spelling both
 * sides use.
 */

import { UUID_RE } from './conversation-types';
import { MAX_ASSISTANT_CHARS, MAX_MESSAGE_CHARS } from './ai-limits';
import { assigneeForName } from './agent-assignees';

/** A message to an agent, at most: the conversation's own cap (089's CHECK). */
export const AGENT_MESSAGE_MAX = MAX_MESSAGE_CHARS;
/** An agent's reply, at most: a saved reply's cap (089's CHECK). */
export const AGENT_REPLY_MAX = MAX_ASSISTANT_CHARS;
/** The most waiting messages one dsul_my_messages read returns. */
export const AGENT_INBOX_PAGE = 20;
/** The earlier exchanges an agent is given with each waiting message, newest last. */
export const AGENT_HISTORY_TURNS = 6;
/** An earlier exchange's text, at most, in that history (each side). */
export const AGENT_HISTORY_CHARS = 2_000;

const ANSWERER_PREFIX = 'agent:';

/** The stored answerer of a reply an agent wrote: `agent:<name>`. */
export function agentAnswerer(agent: string): `agent:${string}` {
  return `${ANSWERER_PREFIX}${agent}`;
}

/** The agent's name in an `agent:<name>` answerer, or null for any other value. */
export function agentOfAnswerer(answerer: unknown): string | null {
  if (typeof answerer !== 'string' || !answerer.startsWith(ANSWERER_PREFIX)) return null;
  const name = answerer.slice(ANSWERER_PREFIX.length);
  return assigneeForName(name) === name ? name : null;
}

/** Whether a value is an `agent:<name>` answerer 089's CHECK would take. */
export function isAgentAnswerer(v: unknown): v is `agent:${string}` {
  return agentOfAnswerer(v) !== null;
}

/**
 * The name a message may be addressed to: a connected app's or agent key's
 * name (lib/agent-assignees.ts). Null for anything else, OpenClaw included:
 * OpenClaw answers Ask live (lib/openclaw-browser/), so it never needs an inbox.
 */
export function agentTarget(raw: unknown): string | null {
  return assigneeForName(raw);
}

export type AgentMessageStatus = 'waiting' | 'answered';

/** One inbox row as the browser reads it. */
export interface AgentMessageRow {
  id: string;
  conversationId: string;
  messageId: string;
  agent: string;
  status: AgentMessageStatus;
  reply: string | null;
  answeredAt: string | null;
  delivered: boolean;
  createdAt: string;
}

/**
 * A send as the browser posts it, checked. No text: the route copies the
 * message from the conversation it was saved in, so what an agent reads is
 * exactly what the conversation holds.
 */
export interface AgentSend {
  id: string;
  conversationId: string;
  messageId: string;
  agent: string;
}

/** A send body, or null when any part is missing or malformed. */
export function parseAgentSend(body: unknown): AgentSend | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const ids = [b.id, b.conversationId, b.messageId];
  if (!ids.every((v) => typeof v === 'string' && UUID_RE.test(v))) return null;
  const agent = agentTarget(b.agent);
  if (!agent) return null;
  return {
    id: (b.id as string).toLowerCase(),
    conversationId: (b.conversationId as string).toLowerCase(),
    messageId: (b.messageId as string).toLowerCase(),
    agent,
  };
}

/** A database row as the browser reads it, or null when it is not one. */
export function agentMessageFromRow(row: Record<string, unknown>): AgentMessageRow | null {
  const status = row.status;
  if (status !== 'waiting' && status !== 'answered') return null;
  if (typeof row.id !== 'string' || typeof row.conversation_id !== 'string' || typeof row.message_id !== 'string') return null;
  if (typeof row.agent !== 'string') return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    agent: row.agent,
    status,
    reply: typeof row.reply === 'string' ? row.reply : null,
    answeredAt: typeof row.answered_at === 'string' ? row.answered_at : null,
    delivered: row.delivered_at !== null && row.delivered_at !== undefined,
    createdAt: String(row.created_at ?? ''),
  };
}

/** What a routine is told when the user writes to it. Ids only, as lib/agent-wake.ts fireText. */
export function messageFireText(count: number): string {
  const what = count === 1 ? 'a message' : `${count} messages`;
  return (
    `The user sent you ${what} in dsul's Ask. Read them with dsul_my_messages and answer each ` +
    'with dsul_reply. Then check dsul_my_work as usual.'
  );
}
