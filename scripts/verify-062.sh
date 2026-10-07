#!/usr/bin/env bash
#
# verify-062.sh — replay the real migrations onto a bare Postgres, seed three
# users with a row in every user table, and delete them, before and after 062.
#
# WHY THIS EXISTS. Deleting an account is one call, GoTrue's admin delete, and
# the foreign keys do the rest: every table that holds a user's data cascades
# from auth.users, inside GoTrue's one transaction
# (memory/plans/account-deletion.md). tests/unit/account-deletion-migration.test.ts
# holds that rule as TEXT in CI; this is the database's own answer. It is the
# only place a deletion actually runs: CI's E2E job replays the migrations but
# never deletes a user.
#
# Modelled on scripts/verify-058.sh: the same stub pg_cron and pg_net (the
# migrations create both unguarded), the same bare cluster on a Unix socket, the
# same stand-ins for what Supabase provides, plus auth.identities, which a
# deletion takes with it as GoTrue's own tables do.
#
# WHAT IT CHECKS
#   1. 000..061, three users A, B, C seeded in all 28 user tables, and a forged
#      task and item of B's whose parent is one of C's (only a forged row can be
#      one: a foreign key check skips RLS). The state 062 fixes: deleting A
#      leaves one bug_reports row with A's email, deleting C fails on
#      tasks_parent_task_id_fkey, and the user-column query lists exactly
#      `bug_reports | supabase_user_id`.
#   2. A fresh build, 062 applied twice: the second run changes nothing, and an
#      orphan email row an earlier deletion left is gone. Then deleting A leaves
#      no row of A's anywhere and no email row; deleting C succeeds (B's forged
#      links go null); B keeps a row in every one of the 28 tables; deleting A
#      again deletes nothing; no public foreign key is `no action` or
#      `restrict`, none to auth.users fails to cascade, and the user-column
#      query lists nothing (and does list a probe table with a keyless user_id).
#   3. A third build with both old constraints renamed first, as an older
#      database might have them: 062 still replaces them.
#
# THE USER-COLUMN QUERY is the one Kirby runs read-only on prod before 062: every
# public table's user column (user_id, *_user_id, owner*) with no cascading key
# to auth.users, directly or through a cascading key to a table that has one.
#
# NOT WIRED INTO CI, for the reason verify-058.sh gives: CI has no Postgres
# binary outside the Supabase stack. Run it by hand before 062 is applied, or
# after any migration that adds a table holding user data:
#
#     sudo ./scripts/verify-062.sh       # or PGBIN=/path/to/pg/bin
#
# ROOT, OR WRITE ACCESS TO THE EXTENSION DIRECTORY, for the stub extensions, as
# verify-058.sh explains; they are removed on exit, and a real pg_cron or pg_net
# there is refused rather than overwritten. As root the cluster runs as the
# `postgres` OS user under /var/lib/postgresql/.
#
# It needs no Supabase credentials and cannot reach a remote database: the
# server listens on a Unix socket in its own scratch directory and nowhere else.

set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PORT=${PORT:-55462}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
TARGET="$MIGRATIONS/062_account_deletion.sql"

if [ ! -x "$PGBIN/initdb" ] || [ ! -x "$PGBIN/pg_config" ]; then
  echo "no Postgres at $PGBIN; set PGBIN=/path/to/postgres/bin" >&2
  exit 1
fi
[ -f "$TARGET" ] || { echo "no $TARGET" >&2; exit 1; }

EXTDIR="$("$PGBIN/pg_config" --sharedir)/extension"
STUB_MARK='dsul verify-062 stub'
# Either script's leftover stub is a stub; anything else is a real extension.
ANY_STUB='dsul verify-0[0-9][0-9] stub'
STUB_FILES=(pg_cron.control pg_cron--1.6.sql pg_net.control pg_net--0.14.sql)

if [ ! -w "$EXTDIR" ]; then
  echo "cannot write $EXTDIR: run as root, or as the owner of that directory" >&2
  exit 1
fi
for f in "${STUB_FILES[@]}"; do
  if [ -e "$EXTDIR/$f" ] && ! grep -q "$ANY_STUB" "$EXTDIR/$f"; then
    echo "$EXTDIR/$f is a real extension file, not a verify script's stub; refusing to overwrite it." >&2
    echo "Run against a Postgres without pg_cron/pg_net (PGBIN=…)." >&2
    exit 1
  fi
done

RUNAS=""
if [ "$(id -u)" = 0 ]; then
  RUNAS=postgres
  [ -d /var/lib/postgresql ] || install -d -o postgres -g postgres /var/lib/postgresql
  WORK="$(mktemp -d /var/lib/postgresql/verify-062.XXXXXX)"
  chown postgres:postgres "$WORK"
else
  WORK="$(mktemp -d)"
fi
run() { if [ -n "$RUNAS" ]; then su "$RUNAS" -c "$*"; else eval "$*"; fi }

cleanup() {
  set +e
  run "$PGBIN/pg_ctl -D $WORK/data stop -m immediate" >/dev/null 2>&1
  rm -rf "$WORK"
  for f in "${STUB_FILES[@]}"; do
    if [ -e "$EXTDIR/$f" ] && grep -q "$STUB_MARK" "$EXTDIR/$f"; then rm -f "$EXTDIR/$f"; fi
  done
}
trap cleanup EXIT

# ── 1. the stub extensions (verify-058.sh's, as far as 000..062 use them) ─────
cat > "$EXTDIR/pg_cron.control" <<EOF
# $STUB_MARK — NOT pg_cron. Written and removed by scripts/verify-062.sh.
comment = '$STUB_MARK: pg_cron signatures, no scheduler'
default_version = '1.6'
relocatable = false
superuser = true
EOF
cat > "$EXTDIR/pg_cron--1.6.sql" <<EOF
-- $STUB_MARK — NOT pg_cron. Written and removed by scripts/verify-062.sh.
create schema cron;

create table cron.job (
  jobid    bigserial primary key,
  schedule text not null,
  command  text not null,
  nodename text not null default 'localhost',
  nodeport integer not null default 5432,
  database text not null default current_database(),
  username text not null default current_user,
  active   boolean not null default true,
  jobname  text,
  constraint jobname_username_uniq unique (jobname, username)
);

create table cron.job_run_details (
  jobid          bigint,
  runid          bigserial primary key,
  job_pid        integer,
  database       text,
  username       text,
  command        text,
  status         text,
  return_message text,
  start_time     timestamptz,
  end_time       timestamptz
);

create function cron.schedule(job_name text, schedule text, command text)
returns bigint language sql as \$\$
  insert into cron.job (jobname, schedule, command) values (\$1, \$2, \$3)
  on conflict on constraint jobname_username_uniq do update
    set schedule = excluded.schedule, command = excluded.command,
        database = excluded.database, active = excluded.active
  returning jobid
\$\$;

create function cron.unschedule(job_name text)
returns boolean language plpgsql as \$\$
begin
  delete from cron.job where jobname = job_name and username = current_user;
  if not found then
    raise exception 'could not find valid entry for job ''%''', job_name;
  end if;
  return true;
end\$\$;

create function cron.unschedule(job_id bigint)
returns boolean language plpgsql as \$\$
begin
  delete from cron.job where jobid = job_id;
  if not found then
    raise exception 'could not find valid entry for job %', job_id;
  end if;
  return true;
end\$\$;

create function cron.alter_job(
  job_id   bigint,
  schedule text    default null,
  command  text    default null,
  database text    default null,
  username text    default null,
  active   boolean default null
) returns void language plpgsql as \$\$
#variable_conflict use_variable
begin
  update cron.job j
     set schedule = coalesce(schedule, j.schedule),
         command  = coalesce(command,  j.command),
         database = coalesce(database, j.database),
         username = coalesce(username, j.username),
         active   = coalesce(active,   j.active)
   where j.jobid = job_id;
  if not found then
    raise exception 'Job % does not exist', job_id;
  end if;
end\$\$;
EOF

cat > "$EXTDIR/pg_net.control" <<EOF
# $STUB_MARK — NOT pg_net. Written and removed by scripts/verify-062.sh.
comment = '$STUB_MARK: pg_net signatures, no worker'
default_version = '0.14'
relocatable = false
superuser = true
EOF
cat > "$EXTDIR/pg_net--0.14.sql" <<EOF
-- $STUB_MARK — NOT pg_net. Written and removed by scripts/verify-062.sh.
create schema net;

create table net.http_request_queue (
  id                   bigserial primary key,
  method               text not null,
  url                  text not null,
  headers              jsonb,
  body                 bytea,
  timeout_milliseconds integer not null
);

create function net.http_get(
  url                  text,
  params               jsonb   default '{}'::jsonb,
  headers              jsonb   default '{}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint language sql security definer set search_path = '' as \$\$
  insert into net.http_request_queue (method, url, headers, timeout_milliseconds)
  values ('GET', \$1, \$3, \$4)
  returning id
\$\$;

create function net.http_post(
  url                  text,
  body                 jsonb   default '{}'::jsonb,
  params               jsonb   default '{}'::jsonb,
  headers              jsonb   default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint language sql security definer set search_path = '' as \$\$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', \$1, \$4, convert_to(\$2::text, 'UTF8'), \$5)
  returning id
\$\$;
EOF

# ── 2. the cluster ────────────────────────────────────────────────────────────
run "$PGBIN/initdb -D $WORK/data -U postgres --auth=trust" >/dev/null
run "$PGBIN/pg_ctl -D $WORK/data -o '-k $WORK -p $PORT -c listen_addresses=' -l $WORK/log start -w" >/dev/null

PSQL="$PGBIN/psql"
DB=postgres
q()  { "$PSQL" -h "$WORK" -p "$PORT" -U postgres -d "$DB" -X -v ON_ERROR_STOP=1 -q "$@"; }
qa() { q -At "$@"; }

# The three API roles are cluster-wide: made once.
q <<'SQL'
create role anon          nologin noinherit;
create role authenticated nologin noinherit;
create role service_role  nologin noinherit bypassrls;
SQL

# ── 3. what Supabase provides before the first migration ──────────────────────
# verify-058.sh's stand-ins, plus auth.identities: a deletion takes a user's
# identities and sessions with it, as GoTrue's own foreign keys do.
prelude() {
  q <<'SQL'
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create table auth.identities (
  id          uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider    text not null,
  created_at  timestamptz not null default now()
);
create table auth.sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         current_setting('request.jwt.claims', true)::jsonb ->> 'sub'), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.role', true),
                         current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '')
$$;

create schema vault;
create table vault.secrets (
  id          uuid primary key default gen_random_uuid(),
  name        text unique,
  description text not null default '',
  secret      text not null,
  key_id      uuid,
  nonce       bytea,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, nonce,
         created_at, updated_at
    from vault.secrets;
create function vault.create_secret(
  new_secret text, new_name text default null, new_description text default '',
  new_key_id uuid default null
) returns uuid language sql as $$
  insert into vault.secrets (secret, name, description, key_id)
  values (new_secret, new_name, coalesce(new_description, ''), new_key_id)
  returning id
$$;
create function vault.update_secret(
  secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null
) returns void language sql as $$
  update vault.secrets
     set secret      = coalesce(new_secret, secret),
         name        = coalesce(new_name, name),
         description = coalesce(new_description, description),
         key_id      = coalesce(new_key_id, key_id),
         updated_at  = now()
   where id = secret_id
$$;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (
  version    text primary key,
  statements text[],
  name       text
);
SQL
}

apply() {
  local file="$1" base version name
  base="$(basename "$file" .sql)"
  version="${base%%_*}"
  name="${base#*_}"
  q -1 -f "$file" >/dev/null
  q -c "insert into supabase_migrations.schema_migrations (version, name)
        values ('$version', '$name') on conflict (version) do nothing"
}

# A fresh database with every migration before 062 replayed into it.
build() {
  DB=postgres
  q -c "create database $1"
  DB="$1"
  q -c "alter database $1 set search_path = \"\$user\", public, extensions"
  prelude
  local n=0
  export PGOPTIONS='-c client_min_messages=warning'
  for f in "$MIGRATIONS"/[0-9][0-9][0-9]_*.sql; do
    [[ "$(basename "$f")" < "$(basename "$TARGET")" ]] || continue
    apply "$f"
    n=$((n + 1))
  done
  unset PGOPTIONS
  echo "  $1: $n files replayed, last $(qa -c "select max(version) from supabase_migrations.schema_migrations")"
}

# One user's rows in every one of the 28 public tables that hold user data, and
# a count of what each table still holds for a user. Plain functions in their
# own schema, outside `public`, so no catalog check below sees them.
helpers() {
  q <<'SQL'
create schema verify;

create function verify.seed(u uuid, mail text) returns void language plpgsql as $$
declare
  proj uuid := gen_random_uuid(); grp uuid := gen_random_uuid();
  parent uuid := gen_random_uuid(); child uuid := gen_random_uuid(); habit uuid := gen_random_uuid();
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  r uuid := gen_random_uuid(); s uuid := gen_random_uuid(); g uuid := gen_random_uuid();
  conv uuid := gen_random_uuid(); m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  md uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, email_confirmed_at) values (u, mail, now());
  insert into auth.identities (user_id, provider, provider_id) values (u, 'apple', '001234.' || left(u::text, 8));
  insert into auth.sessions (user_id) values (u);
  insert into public.user_settings (user_id, timezone, stakes_enabled) values (u, 'Europe/London', true);
  insert into public.user_secrets (user_id, openclaw_api_key, openclaw_gateway_token) values (u, 'dsul_' || u, 'gw');
  insert into public.model_connections (user_id, provider, key_ciphertext) values (u, 'openai', 'v1:aaaa:bbbb:cccc');
  insert into public.projects (id, user_id, name) values (proj, u, 'Work');
  insert into public.habit_groups (id, user_id, name) values (grp, u, 'Health');
  insert into public.tasks (id, user_id, title) values (t1, u, 'old parent');
  insert into public.tasks (id, user_id, title, parent_task_id) values (t2, u, 'old child', t1);
  insert into public.habits (user_id, title, "group") values (u, 'old habit', 'Health');
  insert into public.item_types (user_id, name, label, label_plural) values (u, 'errand', 'Errand', 'Errands');
  insert into public.items (id, user_id, type, title, project, project_id) values (parent, u, 'task', 'Parent', 'Work', proj);
  insert into public.items (id, user_id, type, title, parent_item_id) values (child, u, 'task', 'Child', parent);
  insert into public.items (id, user_id, type, title, "group", group_id, repeat_frequency)
    values (habit, u, 'habit', 'Walk', 'Health', grp, 'daily');
  insert into public.item_events (user_id, item_id, item_type, action) values (u, parent, 'task', 'create');
  insert into public.routines (id, user_id, name) values (r, u, 'Morning');
  insert into public.seasons (id, user_id, name) values (s, u, 'Autumn');
  insert into public.routine_items (routine_id, item_id, user_id) values (r, habit, u);
  insert into public.season_items (season_id, item_id, user_id) values (s, parent, u);
  insert into public.season_routines (season_id, routine_id, user_id) values (s, r, u);
  insert into public.goals (id, user_id, name) values (g, u, 'Run a 10k');
  insert into public.goal_items (goal_id, item_id, user_id, role) values (g, habit, u, 'checkin');
  -- Its trigger writes extension_toggle_events.
  insert into public.user_extensions (user_id, slug, enabled) values (u, 'beeminder', true);
  insert into public.stake_events (user_id, date, subject, subject_title, kind, channel, committed_at)
    values (u, '2026-10-06', habit::text, 'Walk', 'hit', 'beeminder', now());
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (u, 'https://push.example/' || u, 'p', 'a');
  insert into public.plugin_registrations (user_id, plugin_id, webhook_url) values (u, 'anchor-context', 'https://claw.example/hook');
  insert into public.connect_sessions (user_code, status, user_id, api_key, expires_at)
    values (left(u::text, 9), 'authorized', u, 'k', now() + interval '15 minutes');
  insert into public.chat_conversations (id, user_id, item_id, title) values (conv, u, parent, 'About Parent');
  insert into public.chat_messages (id, conversation_id, user_id, pos, role, content) values (m1, conv, u, 1, 'user', 'hello');
  insert into public.chat_messages (id, conversation_id, user_id, pos, role, content, reply_to, answerer)
    values (m2, conv, u, 2, 'assistant', 'hi', m1, 'model');
  insert into public.user_mods (id, user_id, kind, slug, name) values (md, u, 'recipe', 'tidy', 'Tidy');
  insert into public.mod_runs (user_id, mod_id, claim_key) values (u, md, 'k1');
  insert into public.bug_reports (github_issue_number, supabase_user_id, user_email)
    values (abs(hashtext(u::text)), u, mail);
end $$;

create function verify.counts(u uuid) returns table (tbl text, n bigint) language plpgsql as $$
declare t record;
begin
  for t in
    select c.relname,
           case when c.relname = 'bug_reports' then 'supabase_user_id' else 'user_id' end as col
      from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     order by 1
  loop
    execute format('select count(*) from public.%I where %I = $1', t.relname, t.col) into n using u;
    tbl := t.relname;
    return next;
  end loop;
  tbl := 'auth.identities'; select count(*) into n from auth.identities where user_id = u; return next;
  tbl := 'auth.sessions';   select count(*) into n from auth.sessions   where user_id = u; return next;
end $$;
SQL
}

A=aaaaaaaa-0000-4000-8000-000000000001
B=bbbbbbbb-0000-4000-8000-000000000002
C=cccccccc-0000-4000-8000-000000000003

seed() {
  helpers
  q >/dev/null <<SQL
select verify.seed('$A', 'a@verify.test');
select verify.seed('$B', 'b@verify.test');
select verify.seed('$C', 'c@verify.test');
-- B's forged rows: a frozen task and an item whose parent is one of C's.
insert into public.tasks (user_id, title, parent_task_id)
  select '$B', 'cross', id from public.tasks where user_id = '$C' limit 1;
insert into public.items (user_id, type, title, parent_item_id)
  select '$B', 'task', 'cross item', id from public.items where user_id = '$C' and type = 'task' limit 1;
SQL
}

# The user-column query (memory/plans/account-deletion.md; Kirby's read-only check on prod).
USER_COLUMNS="
select c.relname || ' | ' || a.attname
  from pg_class c
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
 where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
   and (a.attname = 'user_id' or a.attname like '%\_user\_id' or a.attname like 'owner%')
   and not exists (
     select 1 from pg_constraint k
      where k.conrelid = c.oid and k.contype = 'f' and k.confdeltype = 'c'
        and a.attnum = any (k.conkey)
        and (k.confrelid = 'auth.users'::regclass
             or exists (select 1 from pg_constraint k2
                         where k2.conrelid = k.confrelid and k2.contype = 'f'
                           and k2.confdeltype = 'c' and k2.confrelid = 'auth.users'::regclass)))
 order by 1"

left_for() { # the tables still holding rows of a user, or 'none'
  qa -c "select coalesce(string_agg(tbl || '=' || n, ' ' order by tbl) filter (where n <> 0), 'none') from verify.counts('$1')"
}
empty_for() { # the tables holding no row of a user, or 'none'
  qa -c "select coalesce(string_agg(tbl, ' ' order by tbl) filter (where n = 0), 'none') from verify.counts('$1')"
}
tables_for() {
  qa -c "select count(*) from verify.counts('$1') where tbl not like 'auth.%'"
}
fk_on() { # every foreign key on table.column, as name:action
  qa -c "select coalesce(string_agg(con.conname || ':' || con.confdeltype::text, ',' order by con.conname), 'none')
           from pg_constraint con
           join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
          where con.conrelid = 'public.$1'::regclass and con.contype = 'f' and att.attname = '$2'"
}
constraints() {
  qa -c "select conrelid::regclass, conname, pg_get_constraintdef(oid)
           from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2"
}

FAILS=0
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then
    echo "  ok    $1"
  else
    echo "  FAIL  $1: got '$2', want '$3'" >&2
    FAILS=$((FAILS + 1))
  fi
}

# ── 4. before 062 ─────────────────────────────────────────────────────────────
echo "── before 062: the state it fixes ──"
build before
seed
check "28 user tables seeded"                  "$(tables_for "$A")" 28
check "A holds a row in every table"           "$(empty_for "$A")" none
check "the user-column query lists bug_reports" "$(qa -c "$USER_COLUMNS")" "bug_reports | supabase_user_id"
q -c "delete from auth.users where id = '$A'"
check "deleting A leaves no row keyed to A"    "$(left_for "$A")" none
check "…but one bug_reports row with A's email" \
      "$(qa -c "select count(*) || ' ' || bool_and(supabase_user_id is null) from public.bug_reports where user_email = 'a@verify.test'")" "1 true"
if q -c "delete from auth.users where id = '$C'" >/dev/null 2> "$WORK/c.err"; then
  check "deleting C fails on B's forged task" "deleted" "fails on tasks_parent_task_id_fkey"
else
  check "deleting C fails on B's forged task" \
        "$(grep -o 'tasks_parent_task_id_fkey' "$WORK/c.err" | head -1)" tasks_parent_task_id_fkey
fi
check "…so C is still there"                   "$(qa -c "select count(*) from auth.users where id = '$C'")" 1

# ── 5. 062, twice ─────────────────────────────────────────────────────────────
echo "── 062 applied twice ──"
build after
q -c "insert into public.bug_reports (github_issue_number, supabase_user_id, user_email) values
        (900001, null, 'gone@verify.test'), (900002, null, null)"
apply "$TARGET"
constraints > "$WORK/s1"
check "the orphan email row is deleted"        "$(qa -c "select count(*) from public.bug_reports where user_email = 'gone@verify.test'")" 0
check "a row with neither is kept"             "$(qa -c "select count(*) from public.bug_reports where github_issue_number = 900002")" 1
check "bug_reports.supabase_user_id cascades"  "$(fk_on bug_reports supabase_user_id)" "bug_reports_supabase_user_id_fkey:c"
check "tasks.parent_task_id sets null"         "$(fk_on tasks parent_task_id)" "tasks_parent_task_id_fkey:n"
check "ledger row 062"                         "$(qa -c "select name from supabase_migrations.schema_migrations where version = '062'")" account_deletion
apply "$TARGET"
constraints > "$WORK/s2"
if diff -q "$WORK/s1" "$WORK/s2" >/dev/null; then
  echo "  ok    a second run changes nothing ($(wc -l < "$WORK/s1") constraints)"
else
  echo "  FAIL  re-running 062 changed the constraints:" >&2
  diff "$WORK/s1" "$WORK/s2" >&2 || true
  FAILS=$((FAILS + 1))
fi
check "no public key is no action or restrict" \
      "$(qa -c "select coalesce(string_agg(conrelid::regclass || '.' || conname, ' '), 'none') from pg_constraint
                 where contype = 'f' and connamespace = 'public'::regnamespace and confdeltype in ('a', 'r')")" none
check "every key to auth.users cascades" \
      "$(qa -c "select coalesce(string_agg(conrelid::regclass || '.' || conname, ' '), 'none') from pg_constraint
                 where contype = 'f' and connamespace = 'public'::regnamespace
                   and confrelid = 'auth.users'::regclass and confdeltype <> 'c'")" none
check "the user-column query lists nothing"    "$(qa -c "$USER_COLUMNS")" ""

echo "── deleting seeded users after 062 ──"
seed
q -c "delete from auth.users where id = '$A'"
check "deleting A leaves no row of A's"        "$(left_for "$A")" none
check "…and no email row"                      "$(qa -c "select count(*) from public.bug_reports where user_email = 'a@verify.test'")" 0
q -c "delete from auth.users where id = '$C'"
check "deleting C succeeds"                    "$(qa -c "select count(*) from auth.users where id = '$C'")" 0
check "…leaving no row of C's"                 "$(left_for "$C")" none
check "B's forged task is kept, its parent null" \
      "$(qa -c "select count(*) || ' ' || bool_and(parent_task_id is null) from public.tasks where user_id = '$B' and title = 'cross'")" "1 true"
check "B's forged item is kept, its parent null" \
      "$(qa -c "select count(*) || ' ' || bool_and(parent_item_id is null) from public.items where user_id = '$B' and title = 'cross item'")" "1 true"
check "B still holds a row in all 28 tables"   "$(empty_for "$B")" none
check "B's email row is kept"                  "$(qa -c "select count(*) from public.bug_reports where user_email = 'b@verify.test'")" 1
check "deleting A again deletes nothing"       "$(qa -c "with d as (delete from auth.users where id = '$A' returning 1) select count(*) from d")" 0

echo "── the user-column query finds a keyless user table ──"
q -c "create table public.devices_probe (id uuid primary key, user_id uuid not null default auth.uid())"
check "a probe with a keyless user_id is listed" "$(qa -c "$USER_COLUMNS")" "devices_probe | user_id"
q -c "drop table public.devices_probe"

# ── 6. constraints named otherwise ────────────────────────────────────────────
echo "── 062 on a database whose constraints were named otherwise ──"
build renamed
q -c "alter table public.bug_reports rename constraint bug_reports_supabase_user_id_fkey to bug_reports_reporter_link"
q -c "alter table public.tasks rename constraint tasks_parent_task_id_fkey to tasks_parent_link"
check "renamed, still set null"                "$(fk_on bug_reports supabase_user_id)" "bug_reports_reporter_link:n"
check "renamed, still no action"               "$(fk_on tasks parent_task_id)" "tasks_parent_link:a"
apply "$TARGET"
check "replaced: one cascading key"            "$(fk_on bug_reports supabase_user_id)" "bug_reports_supabase_user_id_fkey:c"
check "replaced: one set-null key"             "$(fk_on tasks parent_task_id)" "tasks_parent_task_id_fkey:n"
apply "$TARGET"
check "a second run keeps exactly those"       "$(fk_on bug_reports supabase_user_id),$(fk_on tasks parent_task_id)" \
                                               "bug_reports_supabase_user_id_fkey:c,tasks_parent_task_id_fkey:n"

echo
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed." >&2
  exit 1
fi
echo "062 verified against PostgreSQL $("$PGBIN/postgres" --version | awk '{print $3}')."
