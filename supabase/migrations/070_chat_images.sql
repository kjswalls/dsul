-- 070_chat_images: a question remembers how many pictures went with it (AI step 2c).
--
-- WHY. Pictures in the chat box (#480) go to the connected model with one message and are
-- never stored. Kirby decided on 2026-10-11 to keep it that way, but asked that a reload
-- not forget them entirely: the transcript shows a placeholder where each picture was.
-- So the COUNT is kept; the pictures, their names, sizes and types never are.
--
-- WHAT. chat_append (068) learns one optional key per user message, "imageCount": a whole
-- number. It is cleaned here, whoever sent it: 1 to 3 (more is 3; lib/chat-images.ts
-- MAX_CHAT_IMAGES and lib/conversation-types.ts CHAT_LIMITS.images, pinned by
-- tests/unit/chat-images-migration.test.ts); anything else is none. It lands in
-- chat_messages.meta as {"images": n}; a question without pictures keeps meta '{}', and a
-- reply's meta is 068's {"actions": [...]} exactly as before. Same signature, same answers,
-- same grants (CREATE OR REPLACE keeps its EXECUTE grant; 068's column grant on meta is
-- what lets this SECURITY INVOKER function write the key, and it is not touched here).
--
-- ACCESS. Unchanged from 068: meta is owner-asserted, read only in its owner's own
-- transcript, and the app reads nothing from a question's meta but "images", cleaned again
-- on the way out (lib/ai-server/conversations.ts toMessage).
--
-- DEPLOY ORDER. Safe either way round. Before this is applied, 068's chat_append ignores
-- the key it does not know, so a question saves without its count and a reload shows no
-- placeholder, exactly as on main before this PR. Apply to prod only on Kirby's typed OK;
-- if applied out-of-band, record ledger version 070.
--
-- Idempotent and replayable onto an empty database: CREATE OR REPLACE only. It needs 068
-- (the meta grant) and 057 (the table and the function) before it.

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
  v_actions  jsonb;
  v_images   integer;
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

    -- A reply's action lines: at most 16 strings, each one line of at most 200
    -- characters, blanks and non-strings dropped. Anything else is no lines.
    v_actions := '[]'::jsonb;
    if v_role = 'assistant' and jsonb_typeof(v_msg->'actions') = 'array' then
      select coalesce(jsonb_agg(to_jsonb(left(btrim(regexp_replace(a.e #>> '{}',
                                                  '[[:space:][:cntrl:]]+', ' ', 'g')), 200))
                                order by a.n), '[]'::jsonb)
        into v_actions
        from jsonb_array_elements(v_msg->'actions') with ordinality as a(e, n)
       where a.n <= 16
         and jsonb_typeof(a.e) = 'string'
         and btrim(regexp_replace(a.e #>> '{}', '[[:space:][:cntrl:]]+', ' ', 'g')) <> '';
    end if;

    -- A question's picture count: a whole number, 1 to 3 (more is 3). Anything else,
    -- a fraction or a string included, is none. Never the pictures themselves.
    -- Nested, so the cast is only reached once the value is known to be a number.
    v_images := 0;
    if v_role = 'user' and jsonb_typeof(v_msg->'imageCount') = 'number' then
      if (v_msg->>'imageCount')::numeric = trunc((v_msg->>'imageCount')::numeric)
         and (v_msg->>'imageCount')::numeric >= 1 then
        v_images := least((v_msg->>'imageCount')::numeric, 3)::integer;
      end if;
    end if;

    insert into public.chat_messages
      (id, conversation_id, user_id, pos, role, content, status, error_code, reply_to, answerer, model, meta)
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
      nullif(v_msg->>'model', ''),
      case when jsonb_array_length(v_actions) > 0
           then jsonb_build_object('actions', v_actions)
           when v_images > 0
           then jsonb_build_object('images', v_images)
           else '{}'::jsonb end
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
