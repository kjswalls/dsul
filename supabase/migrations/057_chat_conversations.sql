-- 057_chat_conversations: saved AI conversations (AI step 2a, "Move and save").
--
-- WHY. Until now a transcript lived in one browser for 24 hours (lib/chat-store.ts:
-- 'dsul-chat-history', 'dsul-item-chat-*'). Kirby approved saving conversations to the
-- account, "Forever, with delete" (Full Chat Design, 2026-09-30). This supersedes the
-- "no global persistent transcript" half of memory/plans/ai-vision.md locked decision 1.
--
-- WHAT IS STORED, VERBATIM. What the user typed (<= 8,000 chars; the client clips once at
-- send, so this is exactly what the model was sent) and what came back (<= 40,000), one row
-- per message; a title; star and rename flags; four counters of what accepted proposals
-- changed; who answered, and which model; whether OpenClaw ever answered in it.
-- A failed reply stores a short error CODE, never copy and never provider text.
-- NOT STORED: the planner context sent with each turn, custom instructions, the system
-- prompt, any key or token, the gateway session key (rebuilt from ids on every request).
-- Not end-to-end encrypted: like the rest of the planner, readable by the database operator.
--
-- RETENTION. Forever, hard delete. Deleting a conversation cascades to its messages;
-- deleting the account cascades from auth.users. No cron, no soft delete, no trash.
--
-- NO FK TO ITEMS (as 023_item_events.sql). The 30-day trash purge hard-deletes items, and
-- a conversation about one must outlive it: item_id is an address, not a reference. ONE
-- conversation per item is the partial unique index below; chat_append answers
-- {status:'conflict', conversationId} so a second device converges on the first.
--
-- ACCESS. Owner-only RLS through the session client (lib/ai-server/conversations.ts). No
-- service-role code path reads or writes these tables; service_role keeps exactly
-- Supabase's default ALL, restated below. authenticated is granted exactly what
-- chat_append and the routes use, after a REVOKE ALL (Supabase's default privileges grant
-- it ALL on new tables, which would include TRUNCATE, REFERENCES and TRIGGER). Messages are
-- APPEND-ONLY: select and insert policies only, a select grant and a column INSERT grant
-- only. They go away only by cascade, which Postgres runs as the referencing table's owner.
-- A conversation's id, user_id, item_id and created_at are not updatable. The three RPCs
-- and the pos trigger are SECURITY INVOKER with an empty search_path (050), and the RPCs
-- check auth.uid() themselves.
--
-- OWNER-ASSERTED FIELDS. Because the functions are SECURITY INVOKER, authenticated holds
-- these grants itself, so an owner can write their OWN rows through PostgREST with their
-- own JWT, skipping chat_append, the routes' parsers and their rate limits. The grants
-- narrow that to the columns chat_append writes: a message's meta and created_at, and a
-- new conversation's counters, flags and timestamps, are out of reach, and
-- chat_messages_dense_pos holds pos to the next position, so a forged pos cannot make a
-- conversation's later saves overflow. What stays owner-asserted: a message's role,
-- status, content, reply_to, answerer and model (chat_append checks reply_to; a direct
-- insert meets only the CHECKs), and, by UPDATE, a conversation's answerer, openclaw_seen,
-- four counters, message_count and last_message_at. Server code must never trust those
-- beyond the owner's own display. Nothing crosses to another user: RLS and the composite FK
-- hold every write to the caller's own rows.
--
-- WRITE COST (037: the Disk IO budget is spent on writes). One chat_append per FINISHED
-- turn, never per streamed token: at most two message inserts and one conversation update.
-- No trigram/tsvector index: search is a bounded scan of the caller's own rows.
--
-- DEPLOY ORDER. The app tolerates this migration's absence: 42P01 / PGRST205 / PGRST202 /
-- 42883 / 42703 / PGRST204 become 503 'unavailable' (lib/ai-server/schema-codes.ts), and
-- the client latches "saving off" for the session (chat works unsaved, History hidden).
-- Apply to prod only on Kirby's typed OK, after `pnpm db:list` confirms the remote tip. 056
-- (#366) is on main: if it is still unapplied, push 056 and 057 together, in order; never
-- 057 alone. If applied out-of-band, record ledger version 057.
--
-- Idempotent and replayable onto an empty database (CI's E2E job and local-setup.sh run
-- `supabase db reset`): every object is guarded, or created with "or replace", and the
-- privileges are revoked and re-granted to the same end state on every run.
-- tests/unit/chat-migration.test.ts pins the caps against lib/conversation-types.ts.

-- ── chat_conversations ────────────────────────────────────────────────────────
create table if not exists public.chat_conversations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id         uuid,
  title           text not null,
  renamed         boolean not null default false,
  starred         boolean not null default false,
  answerer        text,
  openclaw_seen   boolean not null default false,  -- any saved reply from OpenClaw (delete confirm)
  added_count     integer not null default 0,
  steps_count     integer not null default 0,
  moved_count     integer not null default 0,
  changed_count   integer not null default 0,
  message_count   integer not null default 0,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_conversations_title_check') then
    alter table public.chat_conversations add constraint chat_conversations_title_check
      check (char_length(title) between 1 and 200 and btrim(title) <> '' and title !~ '[[:cntrl:]]');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_conversations_answerer_check') then
    alter table public.chat_conversations add constraint chat_conversations_answerer_check
      check (answerer is null or answerer in ('model', 'openclaw'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_conversations_counts_check') then
    alter table public.chat_conversations add constraint chat_conversations_counts_check
      check (added_count   between 0 and 100000
         and steps_count   between 0 and 100000
         and moved_count   between 0 and 100000
         and changed_count between 0 and 100000
         and message_count >= 0);
  end if;
  -- The composite-FK target for chat_messages (036_goals.sql's pattern).
  if not exists (select 1 from pg_constraint where conname = 'chat_conversations_id_user_id_key') then
    alter table public.chat_conversations add constraint chat_conversations_id_user_id_key
      unique (id, user_id);
  end if;
end$$;

-- One conversation per item.
create unique index if not exists chat_conversations_user_item_key
  on public.chat_conversations (user_id, item_id)
  where item_id is not null;

-- History: newest first, keyset-paged on (last_message_at, id).
create index if not exists chat_conversations_user_recent_idx
  on public.chat_conversations (user_id, last_message_at desc, id desc);

drop trigger if exists chat_conversations_updated_at on public.chat_conversations;
create trigger chat_conversations_updated_at
  before update on public.chat_conversations
  for each row execute function public.update_updated_at();

-- ── chat_messages ─────────────────────────────────────────────────────────────
create table if not exists public.chat_messages (
  id              uuid primary key,
  conversation_id uuid not null,
  user_id         uuid not null default auth.uid(),
  pos             integer not null,
  role            text not null,
  content         text not null default '',
  status          text not null default 'complete',
  error_code      text,
  reply_to        uuid,
  answerer        text,
  model           text,
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

do $$
begin
  -- Same owner by construction; cascades with its conversation.
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_conversation_fkey') then
    alter table public.chat_messages add constraint chat_messages_conversation_fkey
      foreign key (conversation_id, user_id)
      references public.chat_conversations (id, user_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_role_check') then
    alter table public.chat_messages add constraint chat_messages_role_check
      check (role in ('user', 'assistant') and pos >= 1);
  end if;
  -- Error copy is never content: an error is a status plus a short code.
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_status_check') then
    alter table public.chat_messages add constraint chat_messages_status_check
      check (status in ('complete', 'stopped', 'error')
         and (status = 'error') = (error_code is not null)
         and (error_code is null or error_code ~ '^[a-z_]{1,32}$'));
  end if;
  -- A user message is exactly what was typed: complete, 1..8000 chars, not blank.
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_user_check') then
    alter table public.chat_messages add constraint chat_messages_user_check
      check (role <> 'user' or (
            status = 'complete' and reply_to is null and answerer is null and model is null
        and char_length(content) between 1 and 8000
        and btrim(content, E' \t\r\n') <> ''));
  end if;
  -- A reply answers a user message, names its answerer, is <= 40000 chars, and is
  -- non-empty unless it is an error (a stop with nothing streamed stores no reply row).
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_assistant_check') then
    alter table public.chat_messages add constraint chat_messages_assistant_check
      check (role <> 'assistant' or (
            reply_to is not null
        and answerer is not null and answerer in ('model', 'openclaw')
        and char_length(content) <= 40000
        and (status = 'error' or content <> '')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_model_check') then
    alter table public.chat_messages add constraint chat_messages_model_check
      check (model is null or (char_length(model) between 1 and 200 and model !~ '[[:space:][:cntrl:]]'));
  end if;
  -- The 2b/2c seam. 2a never writes it, and authenticated cannot: it is outside the
  -- column INSERT grant below. A later grant that adds it makes it owner-asserted (see
  -- ACCESS), so 2b/2c must validate it on read either way.
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_meta_check') then
    alter table public.chat_messages add constraint chat_messages_meta_check
      check (jsonb_typeof(meta) = 'object' and octet_length(meta::text) <= 16384);
  end if;
end$$;

-- The read index, the order, and the cascade's lookup (leading conversation_id).
create unique index if not exists chat_messages_conversation_pos_key
  on public.chat_messages (conversation_id, pos);

-- pos is the conversation's next position, or the insert fails (23514). chat_append
-- already writes it so, under the conversation's row lock; this holds an owner's direct
-- insert (ACCESS) to the same rule, so a forged pos such as 2147483647 cannot make every
-- later chat_append on that conversation fail at v_pos + 1. One backward step on
-- chat_messages_conversation_pos_key per message, and no write. Rows an earlier row of
-- the same statement inserted are visible here, and a retried id still passes (its pos is
-- the next one) before ON CONFLICT skips it. INVOKER: the read sees only the caller's rows,
-- and a conversation's messages are all its owner's (the composite FK), so it neither
-- under-counts for the owner nor reveals anything to anyone else.
create or replace function public.chat_messages_next_pos()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.pos is distinct from (
    select coalesce(max(m.pos), 0) + 1
      from public.chat_messages m
     where m.conversation_id = new.conversation_id
  ) then
    raise exception 'pos is not the next position' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_dense_pos on public.chat_messages;
create trigger chat_messages_dense_pos
  before insert on public.chat_messages
  for each row execute function public.chat_messages_next_pos();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.chat_conversations enable row level security;
alter table public.chat_messages      enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'chat_conversations' and policyname = 'chat_conversations_own') then
    create policy chat_conversations_own on public.chat_conversations
      for all to authenticated
      using      (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'chat_messages' and policyname = 'chat_messages_select_own') then
    create policy chat_messages_select_own on public.chat_messages
      for select to authenticated
      using (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'chat_messages' and policyname = 'chat_messages_insert_own') then
    create policy chat_messages_insert_own on public.chat_messages
      for insert to authenticated
      with check (user_id = (select auth.uid()));
  end if;
end$$;

-- ── Privileges (not left to Supabase's default ALL) ──────────────────────────
-- REVOKE ALL also drops every column grant, so the revokes come first and the grants
-- below re-add exactly what is used: a re-run lands in the same state. Conversations:
-- INSERT on the four columns chat_append names (every other column takes its default),
-- UPDATE on the columns that may move (id, user_id, item_id, created_at stay immutable;
-- updated_at is written only by the trigger, whose writes are not privilege-checked), and
-- no TRUNCATE. Messages: INSERT on the eleven columns chat_append names (never meta or
-- created_at), and no UPDATE, DELETE or TRUNCATE at all.
revoke all on table public.chat_conversations from public, anon, authenticated;
revoke all on table public.chat_messages      from public, anon, authenticated;

grant select, delete on table public.chat_conversations to authenticated;
grant insert (id, user_id, item_id, title) on public.chat_conversations to authenticated;
grant update (title, renamed, starred, answerer, openclaw_seen, added_count, steps_count,
              moved_count, changed_count, message_count, last_message_at)
  on public.chat_conversations to authenticated;

grant select on table public.chat_messages to authenticated;
grant insert (id, conversation_id, user_id, pos, role, content, status, error_code, reply_to,
              answerer, model)
  on public.chat_messages to authenticated;

grant all on table public.chat_conversations to service_role;
grant all on table public.chat_messages to service_role;

-- ── chat_append: the one write per turn ──────────────────────────────────────
-- p_create:   null to append to an existing conversation, or
--             {"itemId": uuid|null, "title": text} to create it on its first write.
-- p_messages: 1..2 of {"id","role","content","status","errorCode","replyTo","answerer","model"}
--             (a user message, optionally followed by its reply).
-- Returns {"status":"ok","inserted":n,"messageCount":n}
--       | {"status":"gone"}                                  (no such conversation of yours)
--       | {"status":"conflict","conversationId":uuid}        (that item already has one).
-- Idempotent: an existing message id is skipped, so a retry or a keepalive duplicate lands once.
create or replace function public.chat_append(
  p_conversation uuid,
  p_create       jsonb,
  p_messages     jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_item     uuid;
  v_title    text;
  v_existing uuid;
  v_pos      integer;
  v_inserted integer := 0;
  v_rows     integer;
  v_answerer text;
  v_openclaw boolean := false;
  v_role     text;
  v_msg      jsonb;
begin
  -- 28000, not 42501: 42501 is every privilege and RLS refusal, which the app must log
  -- as a fault, never read as "no such conversation".
  if v_uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_conversation is null
     or jsonb_typeof(p_messages) is distinct from 'array'
     or jsonb_array_length(p_messages) not between 1 and 2 then
    raise exception 'bad append' using errcode = '22023';
  end if;

  if p_create is not null then
    v_item  := nullif(p_create->>'itemId', '')::uuid;
    v_title := left(btrim(regexp_replace(coalesce(p_create->>'title', ''),
                                         '[[:space:][:cntrl:]]+', ' ', 'g')), 200);
    if v_title = '' then v_title := 'New chat'; end if;

    -- No conflict target: every unique index is an arbiter, so neither a retried create
    -- (this id, possibly racing its own first attempt from a keepalive) nor a create that
    -- lost the race for this item's one conversation can raise 23505. A target of (id)
    -- alone would let the race surface on (id, user_id) or on the item index instead.
    insert into public.chat_conversations (id, user_id, item_id, title)
    values (p_conversation, v_uid, v_item, v_title)
    on conflict do nothing;

    -- Nothing inserted: either this conversation already exists (a retry; carry on), or
    -- the item already has another one (re-read: a fresh snapshot sees a racer's commit).
    if not found and v_item is not null then
      select c.id into v_existing
        from public.chat_conversations c
       where c.user_id = v_uid and c.item_id = v_item;
      if v_existing is not null and v_existing <> p_conversation then
        return jsonb_build_object('status', 'conflict', 'conversationId', v_existing);
      end if;
    end if;
  end if;

  -- The row lock serialises appends to one conversation, which keeps pos dense.
  perform 1
     from public.chat_conversations c
    where c.id = p_conversation and c.user_id = v_uid
      for update;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;

  select coalesce(max(m.pos), 0) into v_pos
    from public.chat_messages m
   where m.conversation_id = p_conversation;

  for v_msg in
    select e from jsonb_array_elements(p_messages) with ordinality as t(e, n) order by n
  loop
    v_role := v_msg->>'role';
    if v_role = 'assistant' and not exists (
      select 1 from public.chat_messages m
       where m.id = nullif(v_msg->>'replyTo', '')::uuid
         and m.conversation_id = p_conversation
         and m.role = 'user'
    ) then
      raise exception 'reply_to must name a user message in this conversation'
        using errcode = '23503';
    end if;

    insert into public.chat_messages
      (id, conversation_id, user_id, pos, role, content, status, error_code, reply_to, answerer, model)
    values (
      (v_msg->>'id')::uuid,
      p_conversation,
      v_uid,
      v_pos + 1,
      v_role,
      left(coalesce(v_msg->>'content', ''), case when v_role = 'user' then 8000 else 40000 end),
      coalesce(nullif(v_msg->>'status', ''), 'complete'),
      nullif(v_msg->>'errorCode', ''),
      nullif(v_msg->>'replyTo', '')::uuid,
      nullif(v_msg->>'answerer', ''),
      nullif(v_msg->>'model', '')
    )
    on conflict (id) do nothing;

    get diagnostics v_rows = row_count;
    if v_rows = 1 then
      v_pos      := v_pos + 1;
      v_inserted := v_inserted + 1;
      if v_role = 'assistant' then
        v_answerer := nullif(v_msg->>'answerer', '');
        v_openclaw := v_openclaw or coalesce(v_answerer = 'openclaw', false);
      end if;
    end if;
  end loop;

  if v_inserted > 0 then
    update public.chat_conversations c
       set message_count   = v_pos,
           last_message_at = now(),
           answerer        = coalesce(v_answerer, c.answerer),
           openclaw_seen   = c.openclaw_seen or v_openclaw
     where c.id = p_conversation and c.user_id = v_uid;
  end if;

  return jsonb_build_object('status', 'ok', 'inserted', v_inserted, 'messageCount', v_pos);
end;
$$;

-- ── chat_note_changes: what an accepted proposal did, for History's second line ─
-- Atomic increments (two devices may accept in one conversation). Each argument is
-- clamped to 0..20 (a proposal carries at most 20 operations, packages/types/src/
-- schemas.ts ProposalSchema; CHAT_LIMITS.changesPerCall) and each counter to 100000.
-- Answers the conversation as it now is, from the statement that commits the tally, so
-- the route reads nothing after it: a read-back that failed would answer 500 for a tally
-- that had landed, and a retry would count it twice. No row when not yours, or gone.
create or replace function public.chat_note_changes(
  p_conversation uuid,
  p_added        integer,
  p_steps        integer,
  p_moved        integer,
  p_changed      integer
) returns table (
  id              uuid,
  item_id         uuid,
  title           text,
  renamed         boolean,
  starred         boolean,
  answerer        text,
  openclaw_seen   boolean,
  added_count     integer,
  steps_count     integer,
  moved_count     integer,
  changed_count   integer,
  message_count   integer,
  last_message_at timestamptz,
  created_at      timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  update public.chat_conversations c
     set added_count   = least(100000, c.added_count   + greatest(0, least(20, coalesce(p_added,   0)))),
         steps_count   = least(100000, c.steps_count   + greatest(0, least(20, coalesce(p_steps,   0)))),
         moved_count   = least(100000, c.moved_count   + greatest(0, least(20, coalesce(p_moved,   0)))),
         changed_count = least(100000, c.changed_count + greatest(0, least(20, coalesce(p_changed, 0))))
   where c.id = p_conversation
     and c.user_id = (select auth.uid())
  returning c.id, c.item_id, c.title, c.renamed, c.starred, c.answerer, c.openclaw_seen,
            c.added_count, c.steps_count, c.moved_count, c.changed_count,
            c.message_count, c.last_message_at, c.created_at;
$$;

-- ── chat_search: title, linked item's current title, message text ────────────
-- A bounded scan of the caller's own rows, not an index (a GIN would cost a write per
-- message insert, 037). strpos on lower(), not ILIKE, so % and _ are literal and nothing
-- needs escaping. One row per conversation: a title hit wins; otherwise the latest
-- matching message supplies a ~160-character snippet. items RLS applies (invoker); an
-- item in the trash has no current title, as it has none in the planner, so History
-- shows (and search matches) the stored title instead.
-- Messages are searched per conversation of the caller's (LATERAL, newest pos first, the
-- first match only), so the read walks chat_messages_conversation_pos_key backward from
-- each of their own conversations. A join on msg.user_id instead is planned before
-- auth.uid() is known, from the average rows per user, and with few users that is a
-- sequential scan of every user's messages, then a sort of every match.
-- The query's 2..100 is char_length: code points, as parseSearch counts them.
create or replace function public.chat_search(p_query text, p_limit integer default 30)
returns table (
  id              uuid,
  item_id         uuid,
  title           text,
  renamed         boolean,
  starred         boolean,
  answerer        text,
  openclaw_seen   boolean,
  added_count     integer,
  steps_count     integer,
  moved_count     integer,
  changed_count   integer,
  message_count   integer,
  last_message_at timestamptz,
  created_at      timestamptz,
  item_title      text,
  matched         text,
  snippet         text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select lower(btrim(p_query)) as needle
     where char_length(btrim(coalesce(p_query, ''))) between 2 and 100
  ),
  mine as (
    select c.*, i.title as item_title
      from public.chat_conversations c
      left join public.items i
        on i.id = c.item_id and i.user_id = c.user_id and i.deleted_at is null
     where c.user_id = (select auth.uid())
  ),
  title_hits as (
    select m.id, 'title'::text as matched, null::text as snippet, 0 as rank
      from mine m cross join q
     where strpos(lower(m.title), q.needle) > 0
        or strpos(lower(coalesce(m.item_title, '')), q.needle) > 0
  ),
  message_hits as (
    select m.id, 'message'::text as matched, h.snippet, 1 as rank
      from mine m
     cross join q
     cross join lateral (
       select substr(msg.content, greatest(1, strpos(lower(msg.content), q.needle) - 60), 160) as snippet
         from public.chat_messages msg
        where msg.conversation_id = m.id
          and msg.user_id = m.user_id
          and strpos(lower(msg.content), q.needle) > 0
        order by msg.pos desc
        limit 1
     ) h
  ),
  best as (
    select distinct on (h.id) h.id, h.matched, h.snippet
      from (select * from title_hits union all select * from message_hits) h
     order by h.id, h.rank
  )
  select m.id, m.item_id, m.title, m.renamed, m.starred, m.answerer, m.openclaw_seen,
         m.added_count, m.steps_count, m.moved_count, m.changed_count,
         m.message_count, m.last_message_at, m.created_at,
         m.item_title, b.matched, b.snippet
    from best b
    join mine m on m.id = b.id
   order by m.last_message_at desc, m.id desc
   limit least(greatest(coalesce(p_limit, 30), 1), 50);
$$;

revoke all on function public.chat_append(uuid, jsonb, jsonb)                              from public, anon;
revoke all on function public.chat_note_changes(uuid, integer, integer, integer, integer) from public, anon;
revoke all on function public.chat_search(text, integer)                                   from public, anon;
grant execute on function public.chat_append(uuid, jsonb, jsonb)                              to authenticated;
grant execute on function public.chat_note_changes(uuid, integer, integer, integer, integer) to authenticated;
grant execute on function public.chat_search(text, integer)                                   to authenticated;
-- A trigger function cannot be called on its own, and firing it checks no EXECUTE.
revoke all on function public.chat_messages_next_pos() from public, anon, authenticated;

comment on table public.chat_conversations is
  'Saved AI conversations (AI step 2a). Owner-only RLS. One per item at most (partial unique). Forever, hard delete. See memory/plans/ai-vision.md, step 2a privacy statement.';
comment on table public.chat_messages is
  'Append-only messages: select/insert policies, a select grant and a column insert grant only. The app writes them only through chat_append, once per finished turn; an owner can also insert directly (RLS-scoped), limited to chat_append''s columns and the next pos, so role, status, content, reply_to, answerer and model are owner-asserted. Errors are status+error_code, never content.';

-- PostgREST caches the schema; without this a freshly pushed table or function answers
-- PGRST205 / PGRST202 until the next reload, and every client latches "saving off".
notify pgrst, 'reload schema';
