-- 089_agent_messages: what the user writes to an agent (Claude, Cursor, OpenClaw) from Ask,
-- outside any item (memory/plans/agent-chat.md; Kirby, 2026-11-14: "talk to any agent from
-- any chat box").
--
-- WHY. An agent connected over MCP is not a live chat: it runs when its routine is woken
-- or when someone opens it, reads its queue, and answers. Until now the only queue was
-- items (dsul_my_work), and a message to an agent lived on an item's trail
-- (item_events agent_reply). A message from Ask home has no item, so it needs a row of its
-- own: this table is the agent's inbox, and the only thing about a conversation an agent
-- can ever read.
--
-- THE BOUNDARY. Saved conversations (057) stay unreadable to agents: no agent route, no
-- MCP tool and no service-role path reads chat_conversations or chat_messages. When the
-- user sends a message to an agent, the browser saves it in the conversation as it always
-- has AND copies it here, addressed to that agent. The agent reads only rows addressed to
-- it (`agent`, matched to the caller's queue name as dsul_my_work is), writes its answer
-- into `reply`, and the browser then saves that answer into the conversation as a reply
-- (chat_append, answerer 'agent:<name>'), so the client stays the one writer of
-- conversations. What the user said to their own model, or to another agent, never lands
-- here, so no agent ever sees it.
--
-- WHAT IS STORED, VERBATIM. The message as sent (<= 8,000 chars, the conversation's own
-- cap) and the agent's reply (<= 40,000), who it was for, when each was written, and when
-- a browser had saved the reply into the conversation. Nothing else: no planner context,
-- no earlier turns (an agent reads its own earlier rows in the same conversation, which
-- are again only what was sent to it).
--
-- RETENTION. Rows go with their conversation: the composite FK cascades, so the user's
-- Delete on a conversation deletes what was sent to agents from it too, and deleting the
-- account cascades from auth.users. What the agent itself kept (its own logs, memory) is
-- outside dsul, as OpenClaw's session memory already is.
--
-- ACCESS. Owner RLS through the session client for the browser: select, insert of the
-- six columns a send names, and update of delivered_at only. Agents reach it only
-- through service-role routes under /api/agent/messages, which filter on user_id AND the
-- caller's queue name, and whose one write is the compare-and-set waiting -> answered.
-- An owner can insert directly with their own JWT (as 057's ACCESS note explains for
-- chat_messages): that writes only into their own account, so `content` is owner-asserted
-- and an agent must treat it as the user's words, never as an instruction from dsul.
--
-- WRITE COST (037). One insert per message sent to an agent, one update per reply, one
-- update when a browser saves the reply. No trigram index.
--
-- ANSWERER. 057 allowed only 'model' and 'openclaw' as a reply's answerer. A reply from
-- an agent saved into a conversation is 'agent:<name>' (the assignee name, 1..60 chars,
-- no control characters), so both answerer CHECKs are replaced with the wider rule.
--
-- DEPLOY ORDER. The app tolerates this migration's absence: the routes answer 503
-- 'unavailable' on the missing-schema codes (lib/ai-server/schema-codes.ts), and the To
-- picker leaves agents out until a send succeeds. Apply to prod only on Kirby's typed OK.
--
-- Idempotent and replayable onto an empty database: every object is guarded or created
-- "or replace", the two CHECKs are dropped and re-added to the same end state, and the
-- privileges are revoked and re-granted on every run.

-- ── Who may answer a saved reply ─────────────────────────────────────────────
alter table public.chat_messages drop constraint if exists chat_messages_assistant_check;
alter table public.chat_messages add constraint chat_messages_assistant_check
  check (role <> 'assistant' or (
        reply_to is not null
    and answerer is not null
    and (answerer in ('model', 'openclaw')
         or (answerer ~ '^agent:' and char_length(answerer) between 7 and 66 and answerer !~ '[[:cntrl:]]'))
    and char_length(content) <= 40000
    and (status = 'error' or content <> '')));

alter table public.chat_conversations drop constraint if exists chat_conversations_answerer_check;
alter table public.chat_conversations add constraint chat_conversations_answerer_check
  check (answerer is null
      or answerer in ('model', 'openclaw')
      or (answerer ~ '^agent:' and char_length(answerer) between 7 and 66 and answerer !~ '[[:cntrl:]]'));

-- ── agent_messages ───────────────────────────────────────────────────────────
create table if not exists public.agent_messages (
  id              uuid primary key default gen_random_uuid(),  -- also the saved reply's chat_messages id
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid not null,
  message_id      uuid not null,                               -- the user's chat_messages row
  agent           text not null,                               -- the assignee name it is for
  content         text not null,
  status          text not null default 'waiting',
  reply           text,
  answered_at     timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now()
);

do $$
begin
  -- Goes with its conversation (the user's Delete), and the conversation with its account.
  if not exists (select 1 from pg_constraint where conname = 'agent_messages_conversation_fkey') then
    alter table public.agent_messages add constraint agent_messages_conversation_fkey
      foreign key (conversation_id, user_id)
      references public.chat_conversations (id, user_id) on delete cascade;
  end if;
  -- One inbox row per message sent, so a retried send lands once.
  if not exists (select 1 from pg_constraint where conname = 'agent_messages_message_key') then
    alter table public.agent_messages add constraint agent_messages_message_key unique (message_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_messages_agent_check') then
    alter table public.agent_messages add constraint agent_messages_agent_check
      check (char_length(agent) between 1 and 60 and btrim(agent) = agent and agent !~ '[[:cntrl:]]');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_messages_content_check') then
    alter table public.agent_messages add constraint agent_messages_content_check
      check (char_length(content) between 1 and 8000 and btrim(content, E' \t\r\n') <> '');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_messages_status_check') then
    alter table public.agent_messages add constraint agent_messages_status_check
      check ((status = 'waiting' and reply is null and answered_at is null and delivered_at is null)
          or (status = 'answered' and reply is not null and answered_at is not null
              and char_length(reply) between 1 and 40000 and btrim(reply, E' \t\r\n') <> ''));
  end if;
end$$;

-- The agent's read: its waiting messages, oldest first.
create index if not exists agent_messages_user_status_idx
  on public.agent_messages (user_id, status, created_at);

-- The browser's read: one conversation's rows, and the cascade's lookup.
create index if not exists agent_messages_conversation_idx
  on public.agent_messages (conversation_id, created_at);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.agent_messages enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'agent_messages' and policyname = 'agent_messages_select_own') then
    create policy agent_messages_select_own on public.agent_messages
      for select to authenticated
      using (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'agent_messages' and policyname = 'agent_messages_insert_own') then
    create policy agent_messages_insert_own on public.agent_messages
      for insert to authenticated
      with check (user_id = (select auth.uid()) and status = 'waiting');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'agent_messages' and policyname = 'agent_messages_update_own') then
    create policy agent_messages_update_own on public.agent_messages
      for update to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end$$;

-- ── Privileges (not left to Supabase's default ALL) ──────────────────────────
-- The browser inserts the six columns a send names (status, reply and the stamps take
-- their defaults; the insert policy holds status to 'waiting'), and may only stamp
-- delivered_at. No DELETE (a row goes with its conversation), no TRUNCATE. Agents write
-- `status`, `reply` and `answered_at` through the service role only.
revoke all on table public.agent_messages from public, anon, authenticated;
grant select on table public.agent_messages to authenticated;
grant insert (id, user_id, conversation_id, message_id, agent, content)
  on public.agent_messages to authenticated;
grant update (delivered_at) on public.agent_messages to authenticated;
grant all on table public.agent_messages to service_role;

comment on table public.agent_messages is
  'What the user sent an agent from Ask, and its reply (memory/plans/agent-chat.md). The only conversation text an agent can read: rows addressed to it. Cascades with its conversation. Browser: select, insert, update delivered_at. Agents: service-role routes under /api/agent/messages only.';

notify pgrst, 'reload schema';
