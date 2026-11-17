import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentAnswerer,
  agentMessageFromRow,
  agentOfAnswerer,
  agentTarget,
  messageFireText,
  parseAgentSend,
} from '@/lib/agent-messages';
import { isAnswerer } from '@/lib/conversation-types';
import { readInbox, replyToMessage } from '@/lib/ai-server/agent-messages';
import { answererDividerCopy } from '@/components/ai/chat-transcript';
import { toolByName } from '@/lib/mcp/tools';

/**
 * The agent inbox (migration 089, memory/plans/agent-chat.md): what the user
 * writes to an agent from Ask, and the agent's answer. The boundary: an agent
 * reads only rows addressed to it, and nothing on its side reads a saved
 * conversation.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('lib/agent-messages', () => {
  it('spells an agent answerer agent:<name>, and reads it back only for a real name', () => {
    expect(agentAnswerer('Claude')).toBe('agent:Claude');
    expect(agentOfAnswerer('agent:Claude')).toBe('Claude');
    expect(agentOfAnswerer('agent:openclaw')).toBeNull();
    expect(agentOfAnswerer('agent:')).toBeNull();
    expect(agentOfAnswerer('model')).toBeNull();
    expect(agentOfAnswerer(7)).toBeNull();
  });

  it('lets a saved reply name an agent, and nothing else new', () => {
    expect(isAnswerer('agent:Claude')).toBe(true);
    expect(isAnswerer('model')).toBe(true);
    expect(isAnswerer('openclaw')).toBe(true);
    expect(isAnswerer('agent:')).toBe(false);
    expect(isAnswerer('agent:a\nb')).toBe(false);
    expect(isAnswerer(`agent:${'x'.repeat(61)}`)).toBe(false);
    expect(isAnswerer('claude')).toBe(false);
  });

  it('addresses a message only to a connected app or key, never OpenClaw or a reserved word', () => {
    expect(agentTarget('Claude')).toBe('Claude');
    expect(agentTarget('openclaw')).toBeNull();
    expect(agentTarget('ai')).toBeNull();
    expect(agentTarget('')).toBeNull();
    expect(agentTarget(3)).toBeNull();
  });

  it('parses a send with ids and an agent only; the text comes from the saved message', () => {
    expect(parseAgentSend({ id: A, conversationId: B, messageId: C, agent: 'Claude' })).toEqual({
      id: A,
      conversationId: B,
      messageId: C,
      agent: 'Claude',
    });
    expect(parseAgentSend({ id: A, conversationId: B, messageId: 'x', agent: 'Claude' })).toBeNull();
    expect(parseAgentSend({ id: A, conversationId: B, messageId: C, agent: 'openclaw' })).toBeNull();
    expect(parseAgentSend(null)).toBeNull();
  });

  it('reads a row, and refuses one with an unknown status', () => {
    const row = {
      id: A,
      conversation_id: B,
      message_id: C,
      agent: 'Claude',
      status: 'answered',
      reply: 'Done',
      answered_at: '2026-11-14T10:00:00Z',
      delivered_at: null,
      created_at: '2026-11-14T09:00:00Z',
    };
    expect(agentMessageFromRow(row)).toMatchObject({ id: A, status: 'answered', reply: 'Done', delivered: false });
    expect(agentMessageFromRow({ ...row, status: 'odd' })).toBeNull();
  });

  it('wakes a routine with where to look, never the text', () => {
    expect(messageFireText(1)).toContain('dsul_my_messages');
    expect(messageFireText(2)).toContain('2 messages');
  });

  it("labels the transcript's divider with the agent", () => {
    expect(answererDividerCopy('agent:Claude')).toBe('Claude answers from here');
    expect(answererDividerCopy('openclaw')).toBe('OpenClaw answers from here');
  });
});

// ── The agent's side, over a fake service client ────────────────────────────

type Call = { table: string; ops: [string, unknown[]][] };

function fakeDb(answers: { data: unknown; error: unknown }[]) {
  const calls: Call[] = [];
  let n = 0;
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const answer = answers[n++] ?? { data: null, error: null };
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'ilike', 'in', 'is', 'order', 'limit', 'update']) {
        q[m] = (...args: unknown[]) => {
          call.ops.push([m, args]);
          return q;
        };
      }
      q.maybeSingle = async () => answer;
      q.then = (resolve: (v: unknown) => void) => resolve(answer);
      return q;
    },
  };
  return { db: db as never, calls };
}

const has = (call: Call, op: string, ...args: unknown[]) =>
  call.ops.some(([o, a]) => o === op && JSON.stringify(a) === JSON.stringify(args));

describe('readInbox', () => {
  it("serves only the caller's own waiting messages, with its own earlier exchange", async () => {
    const { db, calls } = fakeDb([
      {
        data: [
          { id: A, conversation_id: B, agent: 'Claude', content: 'Which gym?', created_at: '2026-11-14T10:00:00Z' },
          { id: C, conversation_id: B, agent: 'Cursor', content: 'Not for Claude', created_at: '2026-11-14T10:01:00Z' },
        ],
        error: null,
      },
      {
        data: [
          { conversation_id: B, agent: 'claude', content: 'Find gyms', reply: 'Three found', created_at: '2026-11-14T09:00:00Z' },
          { conversation_id: B, agent: 'Cursor', content: 'Secret', reply: 'x', created_at: '2026-11-14T09:30:00Z' },
        ],
        error: null,
      },
    ]);
    const read = await readInbox(db, 'u1', 'Claude');
    expect(read).toEqual({
      ok: true,
      messages: [
        {
          id: A,
          conversationId: B,
          text: 'Which gym?',
          sentAt: '2026-11-14T10:00:00Z',
          earlier: [{ you: 'Find gyms', agent: 'Three found', at: '2026-11-14T09:00:00Z' }],
        },
      ],
    });
    // Both reads are of the inbox, for this account; never a saved conversation.
    expect(calls.map((c) => c.table)).toEqual(['agent_messages', 'agent_messages']);
    expect(calls.every((c) => has(c, 'eq', 'user_id', 'u1'))).toBe(true);
    expect(has(calls[0], 'eq', 'status', 'waiting')).toBe(true);
  });

  it("asks the database for the caller's name only, without case, wildcards escaped", async () => {
    const { db, calls } = fakeDb([{ data: [], error: null }]);
    await readInbox(db, 'u1', 'My_bot 100%');
    expect(has(calls[0], 'ilike', 'agent', 'My\\_bot 100\\%')).toBe(true);
  });

  it('reads nothing more when nothing waits', async () => {
    const { db, calls } = fakeDb([{ data: [], error: null }]);
    expect(await readInbox(db, 'u1', 'Claude')).toEqual({ ok: true, messages: [] });
    expect(calls).toHaveLength(1);
  });

  it('says unavailable before 089, and server on any other failure', async () => {
    expect(await readInbox(fakeDb([{ data: null, error: { code: '42P01' } }]).db, 'u1', 'Claude')).toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(await readInbox(fakeDb([{ data: null, error: { code: 'XX000' } }]).db, 'u1', 'Claude')).toEqual({
      ok: false,
      error: 'server',
    });
  });
});

describe('replyToMessage', () => {
  it('answers a waiting message addressed to the caller, as a compare-and-set', async () => {
    const { db, calls } = fakeDb([
      { data: { id: A, agent: 'Claude', status: 'waiting' }, error: null },
      { data: [{ id: A }], error: null },
    ]);
    const result = await replyToMessage(db, 'u1', 'claude', A, 'The first one');
    expect(result).toMatchObject({ ok: true, id: A });
    expect(has(calls[1], 'eq', 'status', 'waiting')).toBe(true);
    expect(has(calls[1], 'eq', 'user_id', 'u1')).toBe(true);
  });

  it("is not_found for another agent's message, and answered for one already answered", async () => {
    expect(
      await replyToMessage(fakeDb([{ data: { id: A, agent: 'Cursor', status: 'waiting' }, error: null }]).db, 'u1', 'Claude', A, 'x')
    ).toEqual({ ok: false, error: 'not_found' });
    expect(await replyToMessage(fakeDb([{ data: null, error: null }]).db, 'u1', 'Claude', A, 'x')).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(
      await replyToMessage(fakeDb([{ data: { id: A, agent: 'Claude', status: 'answered' }, error: null }]).db, 'u1', 'Claude', A, 'x')
    ).toEqual({ ok: false, error: 'answered' });
    // Lost the race between the read and the write.
    expect(
      await replyToMessage(
        fakeDb([
          { data: { id: A, agent: 'Claude', status: 'waiting' }, error: null },
          { data: [], error: null },
        ]).db,
        'u1',
        'Claude',
        A,
        'x'
      )
    ).toEqual({ ok: false, error: 'answered' });
  });
});

describe('MCP tools', () => {
  it('reads the inbox and replies through the agent routes', () => {
    expect(toolByName('dsul_my_messages')?.plan({})).toEqual({ method: 'GET', path: '/api/agent/messages' });
    expect(toolByName('dsul_reply')?.plan({ id: A, text: 'Hi' })).toEqual({
      method: 'POST',
      path: `/api/agent/messages/${A}/reply`,
      body: { text: 'Hi' },
    });
    expect(toolByName('dsul_reply')?.plan({ id: A })).toHaveProperty('error');
  });
});

// ── The migration, as text ───────────────────────────────────────────────────

describe('089_agent_messages.sql', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/089_agent_messages.sql'), 'utf8');

  it('cascades with its conversation and its account', () => {
    expect(sql).toMatch(/user_id\s+uuid not null default auth\.uid\(\) references auth\.users \(id\) on delete cascade/);
    expect(sql).toMatch(/foreign key \(conversation_id, user_id\)\s+references public\.chat_conversations \(id, user_id\) on delete cascade/);
  });

  it('gives the browser select, the six send columns and delivered_at only', () => {
    expect(sql).toContain('revoke all on table public.agent_messages from public, anon, authenticated;');
    expect(sql).toContain('grant select on table public.agent_messages to authenticated;');
    expect(sql).toMatch(/grant insert \(id, user_id, conversation_id, message_id, agent, content\)\s+on public\.agent_messages to authenticated;/);
    expect(sql).toContain('grant update (delivered_at) on public.agent_messages to authenticated;');
    expect(sql).not.toMatch(/grant delete[^;]*agent_messages/);
  });

  it('holds the caps the app clips to', () => {
    expect(sql).toContain('char_length(content) between 1 and 8000');
    expect(sql).toContain('char_length(reply) between 1 and 40000');
    expect(sql).toContain('char_length(agent) between 1 and 60');
  });
});
