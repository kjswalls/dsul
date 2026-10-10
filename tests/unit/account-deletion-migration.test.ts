import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Deleting an account is one call: GoTrue's admin delete removes the
 * auth.users row, and the database deletes everything else, because every
 * table that holds a user's data cascades from that row
 * (memory/plans/account-deletion.md; lib/account-server/delete.ts). Nothing in
 * the app lists tables to delete. This file is what keeps that true: it reads
 * every migration, in order, as text, and holds two rules.
 *
 *   1. EVERY KEY TO auth.users CASCADES, and every key between public tables
 *      cascades or sets null. A `set null` to auth.users keeps the row (006's
 *      bug_reports kept a deleted account's email), and a key with no action
 *      makes one account's row block another account's deletion (007's
 *      tasks.parent_task_id: a forged cross-account parent fails GoTrue's
 *      transaction, since a foreign key check skips RLS). Each was replaced by
 *      063, which this file checks did so.
 *
 *   2. EVERY USER COLUMN HAS A CASCADING PATH TO auth.users. A column named
 *      user_id, *_user_id or owner*, in a public table, carries its own
 *      `references auth.users … on delete cascade` (inline or as a foreign key
 *      constraint anywhere in the migrations), or is listed below with its
 *      reason and the composite key that carries it, which this file also
 *      finds. A table with a user column and no key at all would keep its rows
 *      after a deletion, and a service-role write in flight (the reminder scan,
 *      the agent API) could even add rows for an account that is gone: only a
 *      foreign key refuses a row whose user no longer exists. That is the shape
 *      a new table would most easily take (065's `devices` cascades).
 *
 * TEXT, NOT A DATABASE, like tests/unit/migration-text.test.ts. Comments and
 * string literals are stripped first, so a header that discusses a clause is
 * not read as one. scripts/verify-063.sh is the replay: it deletes seeded users
 * on a real Postgres and runs the same user-column rule as a catalog query.
 */

const DIR = join(process.cwd(), 'supabase/migrations');

interface Migration {
  name: string;
  src: string;
}

/**
 * Without comments and string literals, lower-cased. One pass, left to right,
 * so whichever opens first wins. Stripping block comments first would let a
 * slash-star inside a `--` comment (a path like lib/devices/*.ts) pair with the
 * star-slash in a later cron string, '*\/5 * * * *', and erase every statement
 * between the two.
 */
function code(sql: string): string {
  return sql
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (m) => (m.startsWith("'") ? "''" : ' '))
    .toLowerCase();
}

const ALL: Migration[] = readdirSync(DIR)
  .filter((name) => /^\d{3}_.+\.sql$/.test(name))
  .sort()
  .map((name) => ({ name, src: code(readFileSync(join(DIR, name), 'utf8')) }));

type Action = 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';

interface Ref {
  file: string;
  table: string;
  columns: string[];
  target: string;
  action: Action;
}

interface UserColumn {
  file: string;
  table: string;
  column: string;
}

/** `public.items`, `"items"` and `items` are one table; another schema keeps its prefix. */
const tableName = (raw: string) => raw.replace(/"/g, '').replace(/^public\./, '');
const isPublic = (raw: string) => !raw.replace(/"/g, '').includes('.') || raw.replace(/"/g, '').startsWith('public.');
const cols = (list: string) =>
  list
    .split(',')
    .map((c) => c.trim().replace(/"/g, ''))
    .filter(Boolean);

const USER_COLUMN = /^(?:user_id|\w+_user_id|owner\w*)$/;
const NOT_A_COLUMN = new Set(['constraint', 'primary', 'foreign', 'unique', 'check', 'exclude', 'like']);

const REF =
  /\breferences\s+([\w."]+)\s*(?:\(([^)]*)\))?\s*(?:match\s+(?:simple|full|partial)\s*)?((?:on\s+(?:delete|update)\s+(?:cascade|restrict|no\s+action|set\s+null(?:\s*\([^)]*\))?|set\s+default(?:\s*\([^)]*\))?)\s*)*)/g;

function actionOf(clauses: string): Action {
  const m = /on\s+delete\s+(cascade|restrict|no\s+action|set\s+null|set\s+default)/.exec(clauses);
  return (m ? m[1].replace(/\s+/g, ' ') : 'no action') as Action;
}

/** The `( … )` that opens at `open`, without its parentheses. */
function balanced(src: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return { body: src.slice(open + 1, i), end: i };
  }
  return { body: src.slice(open + 1), end: src.length };
}

/** Top-level comma-separated items. */
function items(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (body[i] === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const CREATE = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/g;
const HEADER = /\b(?:create\s+table\s+(?:if\s+not\s+exists\s+)?|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?)([\w."]+)/g;
/**
 * A column an alter table adds: `add [column] [if not exists] <name>`. COLUMN
 * is optional in Postgres, so `add owner_id uuid` adds one too. The other ADD
 * forms (a constraint, a key, a check, PG 18's `add not null`) name none.
 */
const ADD_COLUMN =
  /\badd\s+(?:column\s+)?(?!constraint\b|primary\b|foreign\b|unique\b|check\b|exclude\b|not\b)(?:if\s+not\s+exists\s+)?"?(\w+)"?/g;

/** Every foreign key a migration declares, and every user column it adds. */
function scan(m: Migration): { refs: Ref[]; userColumns: UserColumn[] } {
  const refs: Ref[] = [];
  const userColumns: UserColumn[] = [];
  const covered: [number, number][] = [];

  // Create table bodies: a key belongs to the item it sits in.
  for (const c of m.src.matchAll(CREATE)) {
    const open = c.index! + c[0].length - 1;
    const { body, end } = balanced(m.src, open);
    covered.push([open, end]);
    const table = tableName(c[1]);
    for (const item of items(body)) {
      const first = item.split(/\s+/)[0].replace(/"/g, '');
      const fk = /foreign\s+key\s*\(([^)]*)\)/.exec(item);
      const columns = fk ? cols(fk[1]) : NOT_A_COLUMN.has(first) ? [] : [first];
      for (const r of item.matchAll(REF)) {
        refs.push({ file: m.name, table, columns, target: tableName(r[1]), action: actionOf(r[3]) });
      }
      if (!fk && !NOT_A_COLUMN.has(first) && USER_COLUMN.test(first) && isPublic(c[1])) {
        userColumns.push({ file: m.name, table, column: first });
      }
    }
  }

  // Everything else is an alter table: a key belongs to the column the
  // statement adds, or to its `foreign key ( … )`, whichever comes last.
  const headers = [...m.src.matchAll(HEADER)];
  const headerBefore = (at: number) => headers.filter((h) => h.index! < at).at(-1);
  const inCreate = (at: number) => covered.some(([a, b]) => at > a && at < b);
  for (const r of m.src.matchAll(REF)) {
    if (inCreate(r.index!)) continue;
    const header = headerBefore(r.index!);
    if (!header) continue;
    const stmt = m.src.slice(header.index!, r.index!);
    const fk = [...stmt.matchAll(/foreign\s+key\s*\(([^)]*)\)/g)].at(-1);
    const add = [...stmt.matchAll(ADD_COLUMN)].at(-1);
    const columns = fk && (!add || fk.index! > add.index!) ? cols(fk[1]) : add ? [add[1]] : [];
    refs.push({ file: m.name, table: tableName(header[1]), columns, target: tableName(r[1]), action: actionOf(r[3]) });
  }
  for (const a of m.src.matchAll(ADD_COLUMN)) {
    if (inCreate(a.index!) || !USER_COLUMN.test(a[1])) continue;
    const header = headerBefore(a.index!);
    if (header && isPublic(header[1])) userColumns.push({ file: m.name, table: tableName(header[1]), column: a[1] });
  }
  return { refs, userColumns };
}

function scanAll(migrations: Migration[]) {
  const scanned = migrations.map(scan);
  return { refs: scanned.flatMap((s) => s.refs), userColumns: scanned.flatMap((s) => s.userColumns) };
}

/** Keys that were wrong when written, each replaced by a later migration with the action named. */
const SUPERSEDED = [
  {
    file: '006_bug_reports.sql',
    table: 'bug_reports',
    column: 'supabase_user_id',
    target: 'auth.users',
    by: '063_account_deletion.sql',
    action: 'cascade',
  },
  {
    file: '007_future_proofing.sql',
    table: 'tasks',
    column: 'parent_task_id',
    target: 'tasks',
    by: '063_account_deletion.sql',
    action: 'set null',
  },
] as const;

/** Rule 1. */
function keyViolations(migrations: Migration[]): string[] {
  const { refs } = scanAll(migrations);
  const out: string[] = [];
  for (const ref of refs) {
    const wanted: Action[] = ref.target === 'auth.users' ? ['cascade'] : ['cascade', 'set null'];
    if (wanted.includes(ref.action)) continue;
    const excuse = SUPERSEDED.find(
      (s) => s.file === ref.file && s.table === ref.table && ref.columns.includes(s.column) && s.target === ref.target,
    );
    const replaced =
      excuse !== undefined &&
      excuse.by > excuse.file &&
      refs.some(
        (r) =>
          r.file === excuse.by &&
          r.table === excuse.table &&
          r.columns.includes(excuse.column) &&
          r.target === excuse.target &&
          r.action === excuse.action,
      );
    if (!replaced) {
      out.push(`${ref.file}: ${ref.table}(${ref.columns.join(', ')}) → ${ref.target} is on delete ${ref.action}`);
    }
  }
  return out;
}

/**
 * User columns whose only path to auth.users is a composite key to a table
 * that cascades from it. Each needs its reason, and the key is checked.
 */
const ALLOWLIST: Record<string, { via: string; reason: string }> = {
  'chat_messages.user_id': {
    via: 'chat_conversations',
    reason:
      'composite key (conversation_id, user_id) to chat_conversations (id, user_id) on delete cascade, ' +
      '057:146-147, and chat_conversations.user_id cascades',
  },
};

/** Rule 2. */
function userColumnViolations(migrations: Migration[], allowlist = ALLOWLIST): string[] {
  const { refs, userColumns } = scanAll(migrations);
  const direct = (table: string, column: string) =>
    refs.some((r) => r.table === table && r.columns.includes(column) && r.target === 'auth.users' && r.action === 'cascade');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { file, table, column } of userColumns) {
    const key = `${table}.${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (direct(table, column)) continue;
    const entry = allowlist[key];
    if (!entry) {
      out.push(`${file}: ${key} has no cascading key to auth.users`);
      continue;
    }
    const composite = refs.some(
      (r) => r.table === table && r.columns.includes(column) && r.target === entry.via && r.action === 'cascade',
    );
    if (!entry.reason.trim() || !composite || !direct(entry.via, 'user_id')) {
      out.push(`${file}: ${key} is allowlisted, but its composite key to ${entry.via} is gone`);
    }
  }
  return out;
}

describe('every key to auth.users cascades (rule 1)', () => {
  it('reads every migration, 063 included', () => {
    expect(ALL.length).toBeGreaterThan(60);
    expect(ALL.some((m) => m.name === '063_account_deletion.sql')).toBe(true);
  });

  it('finds the keys it should (guards the parser)', () => {
    const { refs } = scanAll(ALL);
    const has = (file: string, table: string, column: string, target: string, action: Action) =>
      refs.some((r) => r.file === file && r.table === table && r.columns.includes(column) && r.target === target && r.action === action);
    // Inline, in a create table.
    expect(has('019_unified_items.sql', 'items', 'user_id', 'auth.users', 'cascade')).toBe(true);
    // Inline with no column list (007's user_settings).
    expect(has('007_future_proofing.sql', 'user_settings', 'user_id', 'auth.users', 'cascade')).toBe(true);
    // The two 063 replaces, as written, and as replaced.
    expect(has('006_bug_reports.sql', 'bug_reports', 'supabase_user_id', 'auth.users', 'set null')).toBe(true);
    expect(has('007_future_proofing.sql', 'tasks', 'parent_task_id', 'tasks', 'no action')).toBe(true);
    expect(has('063_account_deletion.sql', 'bug_reports', 'supabase_user_id', 'auth.users', 'cascade')).toBe(true);
    expect(has('063_account_deletion.sql', 'tasks', 'parent_task_id', 'tasks', 'set null')).toBe(true);
    // A composite key in a create table, and one added in a do block.
    expect(has('024_programs_routines.sql', 'routine_items', 'user_id', 'routines', 'cascade')).toBe(true);
    expect(has('057_chat_conversations.sql', 'chat_messages', 'user_id', 'chat_conversations', 'cascade')).toBe(true);
    // A column-list set null (027).
    expect(has('027_container_ids.sql', 'items', 'project_id', 'projects', 'set null')).toBe(true);
    expect(refs.length).toBeGreaterThan(40);
  });

  it('holds for every migration', () => {
    expect(keyViolations(ALL)).toEqual([]);
  });

  it('would fail without 063', () => {
    const without = ALL.filter((m) => m.name !== '063_account_deletion.sql');
    expect(keyViolations(without)).toEqual([
      '006_bug_reports.sql: bug_reports(supabase_user_id) → auth.users is on delete set null',
      '007_future_proofing.sql: tasks(parent_task_id) → tasks is on delete no action',
    ]);
  });

  it.each([
    ['a key to auth.users that sets null', 'create table public.x (user_id uuid references auth.users (id) on delete set null);'],
    ['a key to auth.users with no action', 'create table public.x (id uuid, user_id uuid not null references auth.users);'],
    ['a key between tables with no action', 'alter table public.x add column parent uuid references public.x (id);'],
    ['a restrict', 'alter table x add constraint k foreign key (y) references public.items (id) on delete restrict;'],
  ])('fails %s', (_, sql) => {
    expect(keyViolations([...ALL, { name: '999_probe.sql', src: code(sql) }])).toHaveLength(1);
  });
});

describe('every user column has a cascading path to auth.users (rule 2)', () => {
  it('finds every user table the plan lists (guards the parser)', () => {
    const tables = new Set(scanAll(ALL).userColumns.map((c) => c.table));
    for (const t of [
      'projects',
      'habit_groups',
      'tasks',
      'habits',
      'user_settings',
      'bug_reports',
      'push_subscriptions',
      'user_secrets',
      'connect_sessions',
      'items',
      'item_types',
      'item_events',
      'routines',
      'programs',
      'routine_items',
      'program_items',
      'program_routines',
      'user_extensions',
      'stake_events',
      'goals',
      'goal_items',
      'plugin_registrations',
      'extension_toggle_events',
      'model_connections',
      'chat_conversations',
      'chat_messages',
      'user_mods',
      'mod_runs',
      'devices',
    ]) {
      expect(tables, t).toContain(t);
    }
    expect(scanAll(ALL).userColumns).toContainEqual({
      file: '006_bug_reports.sql',
      table: 'bug_reports',
      column: 'supabase_user_id',
    });
  });

  it('holds for every migration', () => {
    expect(userColumnViolations(ALL)).toEqual([]);
  });

  it('would fail without 063: a set-null key is no path, so 006’s email row stayed', () => {
    const without = ALL.filter((m) => m.name !== '063_account_deletion.sql');
    expect(userColumnViolations(without)).toEqual([
      '006_bug_reports.sql: bug_reports.supabase_user_id has no cascading key to auth.users',
    ]);
  });

  it('every allowlisted column exists and has its reason', () => {
    const { userColumns } = scanAll(ALL);
    for (const [key, entry] of Object.entries(ALLOWLIST)) {
      expect(userColumns.some((c) => `${c.table}.${c.column}` === key), key).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('fails a table with a user column and no key at all', () => {
    const probe = code(`
      create table if not exists public.devices_probe (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null default auth.uid(),
        token text not null
      );`);
    expect(userColumnViolations([...ALL, { name: '999_devices.sql', src: probe }])).toEqual([
      '999_devices.sql: devices_probe.user_id has no cascading key to auth.users',
    ]);
  });

  it('fails a user column added later with no key, and passes one keyed later', () => {
    const added = code('alter table public.items add column if not exists owner_id uuid;');
    expect(userColumnViolations([...ALL, { name: '998_owner.sql', src: added }])).toEqual([
      '998_owner.sql: items.owner_id has no cascading key to auth.users',
    ]);
    const keyed = code(`
      alter table public.items add column if not exists owner_id uuid;
      do $$ begin
        alter table public.items add constraint items_owner_fkey
          foreign key (owner_id) references auth.users (id) on delete cascade;
      end $$;`);
    expect(userColumnViolations([...ALL, { name: '998_owner.sql', src: keyed }])).toEqual([]);
  });

  it('reads COLUMN as optional: `add owner_id uuid` adds a user column, and its key is its own', () => {
    for (const sql of [
      'alter table public.items add owner_id uuid;',
      'alter table public.items add if not exists owner_id uuid;',
    ]) {
      expect(userColumnViolations([...ALL, { name: '998_owner.sql', src: code(sql) }]), sql).toEqual([
        '998_owner.sql: items.owner_id has no cascading key to auth.users',
      ]);
    }
    const keyed = code('alter table public.items add owner_id uuid references auth.users (id) on delete cascade;');
    expect(userColumnViolations([...ALL, { name: '998_owner.sql', src: keyed }])).toEqual([]);
    const noAction = code('alter table public.items add owner_id uuid references auth.users (id);');
    expect(keyViolations([...ALL, { name: '998_owner.sql', src: noAction }])).toEqual([
      '998_owner.sql: items(owner_id) → auth.users is on delete no action',
    ]);
  });

  it('fails an allowlisted column whose composite key is gone', () => {
    const without057Key = ALL.map((m) =>
      m.name === '057_chat_conversations.sql'
        ? { ...m, src: m.src.replace(/references\s+public\.chat_conversations\s*\(id, user_id\)\s*on delete cascade/, 'references public.nowhere (id)') }
        : m,
    );
    expect(without057Key.find((m) => m.name === '057_chat_conversations.sql')!.src).toContain('public.nowhere');
    expect(userColumnViolations(without057Key)).toEqual([
      '057_chat_conversations.sql: chat_messages.user_id is allowlisted, but its composite key to chat_conversations is gone',
    ]);
  });

  it('lets no comment swallow code: a slash-star in a -- comment pairs with nothing later', () => {
    // The header's path ends in a slash-star, and the cron string further down
    // holds a star-slash. Read as a block comment, the two would erase the
    // keyless table between them.
    const probe = code(`
      -- 063_devices: registers what lib/devices/*.ts sends to.
      create table public.devices_probe (id uuid primary key, user_id uuid not null default auth.uid(), token text);
      select cron.schedule('prune-devices', '*/15 * * * *', $$select 1$$);`);
    expect(userColumnViolations([...ALL, { name: '063_devices.sql', src: probe }])).toEqual([
      '063_devices.sql: devices_probe.user_id has no cascading key to auth.users',
    ]);
  });

  it('reads no comment or string as a clause', () => {
    const probe = code(`
      -- create table public.ghost (user_id uuid);
      comment on table public.items is 'create table public.ghost2 (user_id uuid)';`);
    expect(userColumnViolations([...ALL, { name: '997_comments.sql', src: probe }])).toEqual([]);
  });
});
