import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_ASSISTANT_CHARS, MAX_MESSAGE_CHARS } from '@/lib/ai-limits';
import { CHAT_LIMITS, ERROR_CODE_RE } from '@/lib/conversation-types';

/**
 * Migration 057 (saved AI conversations), read as text.
 *
 * This cannot run the SQL; the replay against a real Postgres is in the PR
 * description. What it catches are the edits whose damage is silent:
 *   - a guard dropped, so a re-run or an empty-database replay (CI's E2E job,
 *     local-setup.sh) fails;
 *   - a privilege widened: an UPDATE or DELETE on messages, a column of a
 *     conversation that must never move, an INSERT past the columns
 *     chat_append writes, a grant to anon or PUBLIC, a function granted to
 *     anon, a service_role grant beyond Supabase's default;
 *   - the revokes moved after the grants, which would strip authenticated of
 *     every privilege (REVOKE ALL drops column grants too) and turn the whole
 *     feature into logged 500s;
 *   - the dense-pos trigger dropped, so an owner's direct insert can forge a
 *     pos that wedges every later save;
 *   - a cap that drifts from the one the app clips to, so a save the client
 *     shortened is still refused (or one it should have shortened is not);
 *   - SECURITY DEFINER, which would turn the auth.uid() checks inside the
 *     functions into the only access control.
 */
const FILE = readFileSync(resolve(__dirname, '../../supabase/migrations/057_chat_conversations.sql'), 'utf8');

/** The file with every `--` comment removed, lower-cased: the header and comments discuss the very words refused below. */
const SQL = FILE.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();

/** Whitespace runs as one space, for matching statements that wrap. */
const FLAT = SQL.replace(/\s+/g, ' ');

/** One function's `$$` body. */
function body(name: string): string {
  const start = FLAT.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`057: no function ${name}`);
  const open = FLAT.indexOf('as $$', start);
  const close = FLAT.indexOf('$$;', open + 5);
  return FLAT.slice(open + 5, close);
}

/** One function's head: the signature and its attributes. */
function head(name: string): string {
  const start = FLAT.indexOf(`create or replace function public.${name}(`);
  return FLAT.slice(start, FLAT.indexOf('as $$', start));
}

/** The three RPCs. */
const FUNCTIONS = ['chat_append', 'chat_note_changes', 'chat_search'];
/** The trigger function that holds pos dense. Not an RPC: no grant, revoked from everyone. */
const TRIGGER_FN = 'chat_messages_next_pos';
const SIGNATURES = [
  'public.chat_append(uuid, jsonb, jsonb)',
  'public.chat_note_changes(uuid, integer, integer, integer, integer)',
  'public.chat_search(text, integer)',
];

describe('migration 057 chat_conversations', () => {
  it('opens with the stored / not-stored header', () => {
    expect(FILE.startsWith('-- 057_chat_conversations: saved AI conversations')).toBe(true);
    const header = FILE.slice(0, FILE.indexOf('create table'));
    for (const section of ['WHAT IS STORED', 'NOT STORED', 'RETENTION', 'NO FK TO ITEMS', 'ACCESS', 'DEPLOY ORDER', 'Idempotent']) {
      expect(header, section).toContain(section);
    }
    expect(header).toContain('Not end-to-end encrypted');
  });

  it('guards every object, so a re-run and an empty-database replay both apply', () => {
    for (const m of FLAT.matchAll(/create (unique )?(table|index) (?!if not exists)/g)) {
      throw new Error(`unguarded: ${FLAT.slice(m.index, m.index + 80)}`);
    }
    expect(FLAT).not.toMatch(/create function /);
    expect(FLAT.match(/create or replace function /g)).toHaveLength(FUNCTIONS.length + 1);

    // Every constraint is added under a pg_constraint guard naming that same constraint.
    const added = [...FLAT.matchAll(/add constraint ([a-z_]+)/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThanOrEqual(10);
    for (const name of added) {
      expect(FLAT, name).toContain(`if not exists (select 1 from pg_constraint where conname = '${name}') then alter table`);
    }
    // Every policy under a pg_policies guard naming it.
    const policies = [...FLAT.matchAll(/create policy ([a-z_]+)/g)].map((m) => m[1]);
    expect(policies.sort()).toEqual(['chat_conversations_own', 'chat_messages_insert_own', 'chat_messages_select_own']);
    for (const name of policies) expect(FLAT, name).toContain(`policyname = '${name}') then create policy ${name}`);
    // Each trigger is dropped before it is created.
    expect(FLAT).toContain(
      'drop trigger if exists chat_conversations_updated_at on public.chat_conversations; create trigger chat_conversations_updated_at'
    );
    expect(FLAT).toContain(
      'drop trigger if exists chat_messages_dense_pos on public.chat_messages; create trigger chat_messages_dense_pos'
    );
    // Nothing is ever dropped with data in it.
    expect(/drop (table|column|index|policy)/.test(FLAT)).toBe(false);
    expect(/drop [^;]*cascade/.test(FLAT)).toBe(false);
  });

  it('enables RLS on both tables, owner-only', () => {
    expect(FLAT).toContain('alter table public.chat_conversations enable row level security');
    expect(FLAT).toContain('alter table public.chat_messages enable row level security');
    expect(FLAT).toContain(
      'create policy chat_conversations_own on public.chat_conversations for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))'
    );
    expect(FLAT).toContain(
      'create policy chat_messages_select_own on public.chat_messages for select to authenticated using (user_id = (select auth.uid()))'
    );
    expect(FLAT).toContain(
      'create policy chat_messages_insert_own on public.chat_messages for insert to authenticated with check (user_id = (select auth.uid()))'
    );
    // Messages have no update or delete policy: append-only.
    expect(FLAT).not.toMatch(/on public\.chat_messages for (update|delete|all)/);
  });

  it('revokes everything first, then grants exactly what chat_append and the routes use, to nobody else', () => {
    const revokeConv = 'revoke all on table public.chat_conversations from public, anon, authenticated;';
    const revokeMsg = 'revoke all on table public.chat_messages from public, anon, authenticated;';
    expect(FLAT).toContain(revokeConv);
    expect(FLAT).toContain(revokeMsg);

    // Every GRANT statement in the file, whatever its grantee: the whole list, in order. A
    // statement starts the file or follows a ';' (the table comments' text says "grant" too).
    const grants = [...FLAT.matchAll(/(?<=(?:^|;) ?)grant [^;]+;/g)];
    expect(grants.map((m) => m[0])).toEqual([
      'grant select, delete on table public.chat_conversations to authenticated;',
      expect.stringMatching(/^grant insert \([a-z_, ]+\) on public\.chat_conversations to authenticated;$/),
      expect.stringMatching(/^grant update \([a-z_, ]+\) on public\.chat_conversations to authenticated;$/),
      'grant select on table public.chat_messages to authenticated;',
      expect.stringMatching(/^grant insert \([a-z_, ]+\) on public\.chat_messages to authenticated;$/),
      'grant all on table public.chat_conversations to service_role;',
      'grant all on table public.chat_messages to service_role;',
      ...SIGNATURES.map((sig) => `grant execute on function ${sig} to authenticated;`),
    ]);
    // Never to PUBLIC or anon (PUBLIC is inherited by authenticated, past the column lists).
    for (const [g] of grants) {
      expect(g, g).toMatch(/ to (authenticated|service_role);$/);
    }

    // REVOKE ALL drops column grants too: the revokes must come before every grant on their
    // table, or authenticated is left with nothing and every route answers a logged 500.
    const firstGrantOn = (table: string) => Math.min(...grants.filter((m) => m[0].includes(` ${table} `)).map((m) => m.index));
    expect(FLAT.indexOf(revokeConv)).toBeLessThan(firstGrantOn('public.chat_conversations'));
    expect(FLAT.indexOf(revokeMsg)).toBeLessThan(firstGrantOn('public.chat_messages'));
    for (const sig of SIGNATURES) {
      expect(FLAT.indexOf(`revoke all on function ${sig} from public, anon;`), sig).toBeLessThan(
        FLAT.indexOf(`grant execute on function ${sig} to authenticated;`)
      );
    }

    // No TRUNCATE, REFERENCES or TRIGGER to anyone but the owner and service_role's ALL.
    expect(FLAT).not.toMatch(/grant [^;]*\b(truncate|references|trigger)\b/);
    // The grant is never "all" to authenticated or anon, and never a table-level INSERT.
    expect(FLAT).not.toMatch(/grant all [^;]* to (authenticated|anon)/);
    expect(FLAT).not.toMatch(/grant [a-z, ]*\binsert\b[a-z, ]* on table/);
  });

  it("grants INSERT on exactly the columns chat_append writes: never meta, a counter, a flag or a timestamp", () => {
    const list = (re: RegExp, text: string) => {
      const m = re.exec(text);
      expect(m, String(re)).not.toBeNull();
      return m![1].split(',').map((c) => c.trim());
    };
    const conv = list(/grant insert \(([^)]*)\) on public\.chat_conversations to authenticated;/, FLAT);
    const msg = list(/grant insert \(([^)]*)\) on public\.chat_messages to authenticated;/, FLAT);
    expect(conv).toEqual(['id', 'user_id', 'item_id', 'title']);
    expect(msg).toEqual([
      'id',
      'conversation_id',
      'user_id',
      'pos',
      'role',
      'content',
      'status',
      'error_code',
      'reply_to',
      'answerer',
      'model',
    ]);
    // In step with what chat_append names, so a column it starts writing is granted with it.
    const append = body('chat_append');
    expect(list(/insert into public\.chat_conversations \(([^)]*)\)/, append)).toEqual(conv);
    expect(list(/insert into public\.chat_messages \(([^)]*)\)/, append)).toEqual(msg);
    for (const never of ['meta', 'created_at']) expect(msg, never).not.toContain(never);
    for (const never of [
      'renamed',
      'starred',
      'answerer',
      'openclaw_seen',
      'added_count',
      'message_count',
      'last_message_at',
      'created_at',
      'updated_at',
    ]) {
      expect(conv, never).not.toContain(never);
    }
  });

  it('holds pos to the next position on every insert, an owner\'s direct one included', () => {
    const h = head(TRIGGER_FN);
    expect(h).toContain('returns trigger');
    expect(h).toContain('security invoker');
    expect(h).toContain("set search_path = ''");
    expect(body(TRIGGER_FN)).toContain(
      "if new.pos is distinct from ( select coalesce(max(m.pos), 0) + 1 from public.chat_messages m where m.conversation_id = new.conversation_id ) then raise exception 'pos is not the next position' using errcode = '23514';"
    );
    expect(FLAT).toContain(
      `create trigger chat_messages_dense_pos before insert on public.chat_messages for each row execute function public.${TRIGGER_FN}();`
    );
    // Not callable by anyone (firing a trigger checks no EXECUTE), and granted to no one.
    expect(FLAT).toContain(`revoke all on function public.${TRIGGER_FN}() from public, anon, authenticated;`);
    expect(FLAT).not.toMatch(new RegExp(`grant [^;]* on function public\\.${TRIGGER_FN}`));
  });

  it("grants UPDATE on exactly the conversation columns that may move, openclaw_seen included", () => {
    const m = /grant update \(([^)]*)\) on public\.chat_conversations to authenticated;/.exec(FLAT);
    expect(m).not.toBeNull();
    const columns = m![1].split(',').map((c) => c.trim());
    expect(columns).toEqual([
      'title',
      'renamed',
      'starred',
      'answerer',
      'openclaw_seen',
      'added_count',
      'steps_count',
      'moved_count',
      'changed_count',
      'message_count',
      'last_message_at',
    ]);
    for (const frozen of ['id', 'user_id', 'item_id', 'created_at', 'updated_at']) {
      expect(columns, frozen).not.toContain(frozen);
    }
  });

  it('gives service_role exactly the two table grants, and no function', () => {
    const lines = SQL.split('\n').filter((l) => l.includes('service_role'));
    expect(lines.map((l) => l.trim().replace(/\s+/g, ' '))).toEqual([
      'grant all on table public.chat_conversations to service_role;',
      'grant all on table public.chat_messages to service_role;',
    ]);
  });

  it('declares openclaw_seen, and only chat_append sets it', () => {
    expect(FLAT).toContain('openclaw_seen boolean not null default false');
    expect(body('chat_append')).toContain('openclaw_seen = c.openclaw_seen or v_openclaw');
    // chat_note_changes answers it (its RETURNING) but never sets it.
    expect(body('chat_note_changes')).not.toMatch(/openclaw_seen\s*=/);
    expect(body('chat_search')).toContain('m.openclaw_seen');
  });

  it('answers a tally with the row it committed, the summary columns chat_search answers', () => {
    const returnsTable = (name: string) => {
      const m = /returns table \(([^)]*)\)/.exec(head(name));
      expect(m, name).not.toBeNull();
      return m![1].split(',').map((c) => c.trim().split(' ')[0]);
    };
    const summary = returnsTable('chat_note_changes');
    expect(summary).toEqual(returnsTable('chat_search').slice(0, summary.length));
    expect(summary).toHaveLength(14);
    const returning = /returning ([^;]*?)\s*;?\s*$/.exec(body('chat_note_changes'));
    expect(returning).not.toBeNull();
    expect(returning![1].split(',').map((c) => c.trim().replace(/^c\./, ''))).toEqual(summary);
  });

  it('holds the caps the app clips to', () => {
    expect(CHAT_LIMITS.userChars).toBe(MAX_MESSAGE_CHARS);
    expect(CHAT_LIMITS.assistantChars).toBe(MAX_ASSISTANT_CHARS);
    // The CHECKs.
    expect(FLAT).toContain(`char_length(content) between 1 and ${CHAT_LIMITS.userChars}`);
    expect(FLAT).toContain(`char_length(content) <= ${CHAT_LIMITS.assistantChars}`);
    expect(FLAT).toContain(`char_length(title) between 1 and ${CHAT_LIMITS.titleChars}`);
    expect(FLAT).toContain(`error_code ~ '${ERROR_CODE_RE.source}'`);
    // chat_append clips to the same numbers rather than refusing a length.
    const append = body('chat_append');
    expect(append).toContain(
      `case when v_role = 'user' then ${CHAT_LIMITS.userChars} else ${CHAT_LIMITS.assistantChars} end`
    );
    expect(append).toContain(`'[[:space:][:cntrl:]]+', ' ', 'g')), ${CHAT_LIMITS.titleChars})`);
    expect(append).toContain("v_title := 'new chat'");
    // Search: the query length, in char_length's code points (parseSearch counts the same), and the row cap.
    const search = body('chat_search');
    expect(search).toContain(
      `where char_length(btrim(coalesce(p_query, ''))) between ${CHAT_LIMITS.searchMin} and ${CHAT_LIMITS.searchMax}`
    );
    expect(search).toContain(`limit least(greatest(coalesce(p_limit, 30), 1), ${CHAT_LIMITS.searchResults})`);
    // A proposal's 20 operations per tally, the cap the route refuses past.
    expect(
      body('chat_note_changes').match(new RegExp(`least\\(${CHAT_LIMITS.changesPerCall}, coalesce\\(p_`, 'g'))
    ).toHaveLength(4);
  });

  it('keeps errors as a status plus a code, never content', () => {
    expect(FLAT).toContain("status in ('complete', 'stopped', 'error') and (status = 'error') = (error_code is not null)");
  });

  it('makes a cross-tenant message unrepresentable and one conversation per item a rule', () => {
    expect(FLAT).toContain(
      'foreign key (conversation_id, user_id) references public.chat_conversations (id, user_id) on delete cascade'
    );
    expect(FLAT).toContain('unique (id, user_id)');
    expect(FLAT).toContain(
      'create unique index if not exists chat_conversations_user_item_key on public.chat_conversations (user_id, item_id) where item_id is not null'
    );
    expect(FLAT).toContain(
      'create index if not exists chat_conversations_user_recent_idx on public.chat_conversations (user_id, last_message_at desc, id desc)'
    );
    // item_id is an address, not a reference: a conversation outlives the trash purge.
    expect(FLAT).not.toMatch(/references public\.items/);
  });

  it("creates with a target-less ON CONFLICT, so no create race can raise 23505", () => {
    const append = body('chat_append');
    expect(append).toContain(
      'insert into public.chat_conversations (id, user_id, item_id, title) values (p_conversation, v_uid, v_item, v_title) on conflict do nothing;'
    );
    expect(append).not.toContain('exception when');
    // Messages keep their (id) target: a (conversation_id, pos) clash is a bug, not a retry.
    expect(append).toContain('on conflict (id) do nothing');
    // The lock that keeps pos dense.
    expect(append).toContain('for update');
  });

  it('makes all three functions SECURITY INVOKER with an empty search_path, for signed-in users only', () => {
    expect(FLAT).not.toContain('security definer');
    for (const name of [...FUNCTIONS, TRIGGER_FN]) {
      expect(head(name), name).toContain('security invoker');
      expect(head(name), name).toContain("set search_path = ''");
    }
    expect(head('chat_search')).toMatch(/\bstable\b/);
    // 28000, never 42501: the app reads 42501 (any privilege or RLS refusal) as a logged fault.
    expect(body('chat_append')).toContain("raise exception 'not signed in' using errcode = '28000'");
    expect(body('chat_append')).not.toContain("'42501'");
    for (const sig of SIGNATURES) {
      expect(FLAT, sig).toContain(`revoke all on function ${sig} from public, anon;`);
      expect(FLAT, sig).toContain(`grant execute on function ${sig} to authenticated;`);
    }
    expect(FLAT).not.toMatch(/grant execute on function [^;]* to (anon|public|service_role)/);
  });

  it('scopes every read and write inside the functions to auth.uid()', () => {
    expect(body('chat_append')).toContain('v_uid uuid := auth.uid()');
    expect(body('chat_note_changes')).toContain('c.user_id = (select auth.uid())');
    // Once, in `mine`: messages are reached only through the caller's own conversations.
    expect(body('chat_search').match(/\(select auth\.uid\(\)\)/g)).toHaveLength(1);
    // The linked item's title: items RLS (invoker), same owner, not in the trash.
    expect(body('chat_search')).toContain('i.id = c.item_id and i.user_id = c.user_id and i.deleted_at is null');
  });

  it("searches messages per conversation of the caller's, newest first, one match each (the pos index, not a scan)", () => {
    const search = body('chat_search');
    expect(search).toContain(
      'message_hits as ( select m.id, \'message\'::text as matched, h.snippet, 1 as rank from mine m cross join q cross join lateral ( select substr(msg.content, greatest(1, strpos(lower(msg.content), q.needle) - 60), 160) as snippet from public.chat_messages msg where msg.conversation_id = m.id and msg.user_id = m.user_id and strpos(lower(msg.content), q.needle) > 0 order by msg.pos desc limit 1 ) h )'
    );
    expect(search).not.toContain('distinct on (msg.conversation_id)');
  });

  it('reloads the PostgREST schema cache', () => {
    expect(FLAT.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});
