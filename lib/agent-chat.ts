import { agentMessageFromRow, type AgentMessageRow } from './agent-messages';
import { useAskToStore } from './ask-to-store';
import { useConversationsStore } from './conversations-store';

/**
 * Ask's side of talking to an agent (memory/plans/agent-chat.md, step 2).
 *
 * A message to Claude is saved in the conversation as every question is
 * (conversations-store `sendToAgent`), then handed to Claude's inbox here by
 * its ids (POST /api/ai/agent-messages; the server copies the text from the
 * saved message). Claude answers through MCP; `deliverAgentReplies` finds the
 * answers, saves each into its conversation as Claude's reply, and stamps it
 * delivered so no other browser saves it again (the reply's id is the inbox
 * row's, so two that race land it once anyway).
 *
 * Browser only. Nothing here throws: a failed send leaves "Not sent" on the
 * message, and a failed look waits for the next one.
 */

const BASE = '/api/ai/agent-messages';

async function json(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Hand one saved message to an agent's inbox. True once the inbox holds it. */
export async function postToAgent(conversationId: string, messageId: string, agent: string): Promise<boolean> {
  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: crypto.randomUUID(), conversationId, messageId, agent }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Send `text` to `agent` in `threadId`: saved first, then handed on. Returns
 * whether the message was written; the hand-off happens after the save lands.
 */
export function sendToAgent(threadId: string, text: string, agent: string): boolean {
  return useConversationsStore.getState().sendToAgent(threadId, text, agent, (conversationId, messageId) => {
    useAskToStore.getState().markWaiting(messageId, { threadId: conversationId, agent });
    void postToAgent(conversationId, messageId, agent).then((ok) => {
      if (!ok) useAskToStore.getState().markUnsent(messageId, agent);
    });
  });
}

async function readRows(query: string): Promise<AgentMessageRow[] | null> {
  try {
    const res = await fetch(`${BASE}?${query}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = await json(res);
    const list = Array.isArray(body?.messages) ? (body.messages as Record<string, unknown>[]) : [];
    // The route already answers the browser's shape; re-checked, never trusted blind.
    return list
      .map((m) =>
        agentMessageFromRow({
          id: m.id,
          conversation_id: m.conversationId,
          message_id: m.messageId,
          agent: m.agent,
          status: m.status,
          reply: m.reply,
          answered_at: m.answeredAt,
          delivered_at: m.delivered ? 'yes' : null,
          created_at: m.createdAt,
        })
      )
      .filter((m): m is AgentMessageRow => m !== null);
  } catch {
    return null;
  }
}

async function markDelivered(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await fetch(`${BASE}/delivered`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ ids: ids.slice(0, 50) }),
    });
  } catch {
    // The next pass finds them again; saving one twice lands once.
  }
}

/** Save each answered row into its conversation, then stamp the ones that landed. */
async function deliver(rows: AgentMessageRow[]): Promise<void> {
  const landed: string[] = [];
  for (const row of rows) {
    if (row.status !== 'answered' || !row.reply) continue;
    const ok = await useConversationsStore.getState().landAgentReply({
      id: row.id,
      conversationId: row.conversationId,
      messageId: row.messageId,
      agent: row.agent,
      reply: row.reply,
    });
    if (ok) {
      landed.push(row.id);
      useAskToStore.getState().clearWaiting(row.messageId);
    }
  }
  await markDelivered(landed);
}

let running: Promise<void> | null = null;

/**
 * One pass: every answer not yet saved into a conversation, account-wide (an
 * answer that came while no browser was open lands here too). One at a time.
 */
export function deliverAgentReplies(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const rows = await readRows('pending=1');
    if (rows) await deliver(rows);
  })().finally(() => {
    running = null;
  });
  return running;
}

/**
 * A conversation's rows, when it is opened: what still waits (so "Sent to
 * Claude" survives a reload) and any answer to save.
 */
export async function syncConversation(conversationId: string): Promise<void> {
  const rows = await readRows(`conversationId=${encodeURIComponent(conversationId)}`);
  if (!rows) return;
  const ask = useAskToStore.getState();
  for (const row of rows) {
    if (row.status === 'waiting') ask.markWaiting(row.messageId, { threadId: row.conversationId, agent: row.agent });
  }
  await deliver(rows.filter((r) => r.status === 'answered' && !r.delivered));
}
