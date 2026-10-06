#!/usr/bin/env bash
#
# verify-058.sh — replay the real migrations onto a bare Postgres, then 058.
#
# WHY THIS EXISTS. CI's E2E job replays every migration onto an empty database,
# but that database is a Supabase stack with REAL pg_cron and pg_net, so an
# unguarded `cron.*` or `net.*` call passes there — 013/035/044 call cron.schedule
# at top level and pass every day. The guards 058 puts round its cron calls
# (`to_regclass('cron.job')`) are therefore exercised by nothing in CI, and
# neither is the claim that dsul_tick works under an EMPTY search_path, nor that
# a second run changes nothing. This is the instrument for all three.
#
# It is modelled on scripts/verify-039.sh, with one difference: 039's script
# RECONSTRUCTS the schema it needs, this one replays the real 000..057. Those
# cannot run on a Postgres without pg_cron and pg_net (013/035/037/038 create the
# extensions unguarded), so the script installs two STUB extensions first — a
# cron.job table with pg_cron's function signatures, and a pg_net whose
# http_get only enqueues. Nothing is scheduled and nothing is sent: the queue is
# what the tick tests read. That is also what makes the bare pass possible at
# the end: drop both extensions and 058 must still apply.
#
# WHAT IT CHECKS (memory/plans/reminders-platforms.md §5.8)
#   1. 000..057 replay; the state is the one runbook A1 expects (five jobs, both
#      dsul-* paused, the one-argument dsul_tick present).
#   2. 058 applies; the jobs, the function and its grants are what 058 says.
#   3. 058 applies a second time with a byte-identical snapshot and without the
#      "re-created" path; a hand-unscheduled dsul-reminders IS re-created.
#   4. The tick's behaviour, read from the stub queue: nobody enabled → no
#      request; one enabled account → exactly one, to the right URL with the
#      right bearer; force → one; a missing column or table → one (fails open).
#   5. The bare pass: with both extensions dropped, 058 still applies.
#
# NOT WIRED INTO CI, for the reason verify-039.sh gives: CI has no Postgres
# binary outside the Supabase stack. Run it by hand before 058 (or anything that
# touches dsul_tick or the cron jobs) is applied:
#
#     sudo ./scripts/verify-058.sh       # or PGBIN=/path/to/pg/bin
#
# ROOT, OR WRITE ACCESS TO THE EXTENSION DIRECTORY. The stubs go into
# `$(pg_config --sharedir)/extension/` — Postgres 16 reads control files from
# nowhere else — and are removed on exit, including on failure. A REAL pg_cron or
# pg_net there is refused rather than overwritten. initdb refuses to run as root,
# so as root the cluster is created as the `postgres` OS user under
# /var/lib/postgresql/, a directory that user can traverse (a root-only temp dir
# fails at initdb with a permissions error that names nothing useful).
#
# It needs no Supabase credentials and cannot reach a remote database: the
# server listens on a Unix socket in its own scratch directory and nowhere else.

set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PORT=${PORT:-55458}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
TARGET="$MIGRATIONS/058_resume_cron_tick.sql"

if [ ! -x "$PGBIN/initdb" ] || [ ! -x "$PGBIN/pg_config" ]; then
  echo "no Postgres at $PGBIN — set PGBIN=/path/to/postgres/bin" >&2
  exit 1
fi
[ -f "$TARGET" ] || { echo "no $TARGET" >&2; exit 1; }

EXTDIR="$("$PGBIN/pg_config" --sharedir)/extension"
STUB_MARK='dsul verify-058 stub'
STUB_FILES=(pg_cron.control pg_cron--1.6.sql pg_net.control pg_net--0.14.sql)

if [ ! -w "$EXTDIR" ]; then
  echo "cannot write $EXTDIR — run as root, or as the owner of that directory" >&2
  exit 1
fi
# A file carrying the mark is a stub left by a run that was killed before its
# trap; anything else is a real extension, and installing over it would break
# the machine's Postgres for every other use.
for f in "${STUB_FILES[@]}"; do
  if [ -e "$EXTDIR/$f" ] && ! grep -q "$STUB_MARK" "$EXTDIR/$f"; then
    echo "$EXTDIR/$f is a real extension file, not this script's stub — refusing to overwrite it." >&2
    echo "Run against a Postgres without pg_cron/pg_net (PGBIN=…)." >&2
    exit 1
  fi
done

# initdb refuses to run as root, which is the common case in a container.
RUNAS=""
if [ "$(id -u)" = 0 ]; then
  RUNAS=postgres
  [ -d /var/lib/postgresql ] || install -d -o postgres -g postgres /var/lib/postgresql
  WORK="$(mktemp -d /var/lib/postgresql/verify-058.XXXXXX)"
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

# ── 1. the stub extensions ────────────────────────────────────────────────────
# pg_cron as far as the migrations use it: cron.job with the real column names,
# schedule() as upsert-by-name (pg_cron's own behaviour, which 044 and 058 rely
# on), unschedule() RAISING when the job is absent (which 035/037/038/044 and
# 058 swallow — a stub that returned false would hide an unswallowed call), and
# alter_job() with pg_cron's parameter names, since 045 and 058 pass `active`
# by name. Nothing ever runs a job.
cat > "$EXTDIR/pg_cron.control" <<EOF
# $STUB_MARK — NOT pg_cron. Written and removed by scripts/verify-058.sh.
comment = '$STUB_MARK: pg_cron signatures, no scheduler'
default_version = '1.6'
relocatable = false
superuser = true
EOF
cat > "$EXTDIR/pg_cron--1.6.sql" <<EOF
-- $STUB_MARK — NOT pg_cron. Written and removed by scripts/verify-058.sh.
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

# pg_net as far as dsul_tick uses it: http_get/http_post with pg_net's parameter
# names (dsul_tick passes them by name) whose bodies are schema-qualified, like
# pg_net's own — which is the property that lets dsul_tick call it under an empty
# search_path. They enqueue and return the id; nothing is sent.
cat > "$EXTDIR/pg_net.control" <<EOF
# $STUB_MARK — NOT pg_net. Written and removed by scripts/verify-058.sh.
comment = '$STUB_MARK: pg_net signatures, no worker'
default_version = '0.14'
relocatable = false
superuser = true
EOF
cat > "$EXTDIR/pg_net--0.14.sql" <<EOF
-- $STUB_MARK — NOT pg_net. Written and removed by scripts/verify-058.sh.
create schema net;

create table net.http_request_queue (
  id                   bigserial primary key,
  method               text not null,
  url                  text not null,
  headers              jsonb,
  body                 bytea,
  timeout_milliseconds integer not null
);

create unlogged table net._http_response (
  id           bigint,
  status_code  integer,
  content_type text,
  headers      jsonb,
  content      text,
  timed_out    boolean,
  error_msg    text,
  created      timestamptz not null default now()
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
q()  { "$PSQL" -h "$WORK" -p "$PORT" -U postgres -d postgres -X -v ON_ERROR_STOP=1 -q "$@"; }
qa() { q -At "$@"; }

# ── 3. what Supabase provides before the first migration ──────────────────────
# Only what the tree reads: the three API roles, Supabase's default privileges
# (the reason 053/057 revoke before they grant), the `extensions` schema and the
# search path that finds it (002 calls uuid_generate_v4() unqualified), auth.users
# with the columns 051 reads, auth.sessions (038's job body), auth.uid() reading
# the JWT claim, Vault as a plaintext stand-in with Supabase's parameter names,
# and the migration ledger.
q <<'SQL'
create role anon         nologin noinherit;
create role authenticated nologin noinherit;
create role service_role  nologin noinherit bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
alter database postgres set search_path = "$user", public, extensions;

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

# Every migration file in its own transaction, as `supabase db push` applies
# one, and recorded in the ledger the way it would be.
apply() {
  local file="$1" base version name
  base="$(basename "$file" .sql)"
  version="${base%%_*}"
  name="${base#*_}"
  q -1 -f "$file" >/dev/null   # the top-level `select cron.schedule(…)` results
  q -c "insert into supabase_migrations.schema_migrations (version, name)
        values ('$version', '$name') on conflict (version) do nothing"
}

# The state the target changes, one line per fact. Constraints, indexes and
# privileges are all of `public`, not only 058's objects: a migration that is
# re-run must change NOTHING, not merely nothing it meant to touch.
snapshot() {
  qa <<'SQL'
select 'job', jobid, jobname, schedule, command, active from cron.job order by jobid;
select 'fn', p.oid::regprocedure, p.prosecdef, p.proconfig, md5(p.prosrc), p.proacl,
       md5(coalesce(obj_description(p.oid, 'pg_proc'), ''))
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
 order by p.oid::regprocedure::text;
select 'con', c.conrelid::regclass, c.conname, pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.connamespace = 'public'::regnamespace
 order by c.conrelid::regclass::text, c.conname;
select 'idx', i.indexrelid::regclass, pg_get_indexdef(i.indexrelid)
  from pg_index i join pg_class t on t.oid = i.indrelid
 where t.relnamespace = 'public'::regnamespace
 order by i.indexrelid::regclass::text;
select 'tblpriv', grantee, table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
 order by 2, 3, 4;
select 'colpriv', table_name, column_name, privilege_type
  from information_schema.column_privileges
 where table_schema = 'public' and grantee = 'authenticated'
 order by 2, 3, 4;
SQL
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

# One call to the tick in a fresh session, answering how many requests it queued.
tick() {
  q -c "truncate net.http_request_queue" >/dev/null
  q -c "$1" >/dev/null
  qa -c "select count(*) from net.http_request_queue"
}

# ── 4. replay 000..057 ────────────────────────────────────────────────────────
echo "── replaying the migrations before $(basename "$TARGET") ──"
REPLAYED=0
export PGOPTIONS='-c client_min_messages=warning'   # the replay's NOTICEs are not this script's news
for f in "$MIGRATIONS"/[0-9][0-9][0-9]_*.sql; do
  [[ "$(basename "$f")" < "$(basename "$TARGET")" ]] || continue
  apply "$f"
  REPLAYED=$((REPLAYED + 1))
done
unset PGOPTIONS
echo "  $REPLAYED files, last $(qa -c "select max(version) from supabase_migrations.schema_migrations")"

echo "── the pre-058 state is the one runbook A1 expects ──"
check "five jobs"                    "$(qa -c "select count(*) from cron.job")" 5
check "both dsul-* jobs present"     "$(qa -c "select count(*) from cron.job where jobname in ('dsul-reminders','dsul-eod-notify')")" 2
check "both dsul-* jobs paused"      "$(qa -c "select count(*) from cron.job where jobname like 'dsul-%' and active")" 0
check "the daily jobs active"        "$(qa -c "select string_agg(jobname, ',' order by jobname) from cron.job where jobname not like 'dsul-%' and active")" \
                                     "prune-cron-log,purge-deleted-items,reap-stale-sessions"
check "dsul_tick(text) present"      "$(qa -c "select to_regprocedure('public.dsul_tick(text)') is not null")" t
DAILY_BEFORE="$(qa -c "select jobid, jobname, schedule, command, active from cron.job where jobname not like 'dsul-%' order by jobid")"
REMINDERS_ID="$(qa -c "select jobid from cron.job where jobname = 'dsul-reminders'")"

# ── 5. apply 058 twice ────────────────────────────────────────────────────────
echo "── applying $(basename "$TARGET") ──"
apply "$TARGET" 2> "$WORK/run1.log" || { cat "$WORK/run1.log" >&2; exit 1; }
snapshot > "$WORK/s1"
check "four jobs"                     "$(qa -c "select count(*) from cron.job")" 4
check "dsul-eod-notify gone"          "$(qa -c "select count(*) from cron.job where jobname = 'dsul-eod-notify'")" 0
check "dsul-reminders active"         "$(qa -c "select active from cron.job where jobname = 'dsul-reminders'")" t
check "dsul-reminders resumed, not re-created (same jobid)" \
                                      "$(qa -c "select jobid from cron.job where jobname = 'dsul-reminders'")" "$REMINDERS_ID"
check "dsul-reminders' command kept"  "$(qa -c "select command from cron.job where jobname = 'dsul-reminders'")" \
                                      "select public.dsul_tick('/api/cron/reminders')"
check "the daily jobs untouched"      "$(qa -c "select jobid, jobname, schedule, command, active from cron.job where jobname not like 'dsul-%' order by jobid")" \
                                      "$DAILY_BEFORE"
check "no re-create on an empty-db replay" "$(grep -c 're-created' "$WORK/run1.log" || true)" 0
check "dsul_tick(text) dropped"       "$(qa -c "select to_regprocedure('public.dsul_tick(text)') is null")" t
check "dsul_tick(text, boolean) present" \
                                      "$(qa -c "select to_regprocedure('public.dsul_tick(text, boolean)') is not null")" t
check "security definer"              "$(qa -c "select prosecdef from pg_proc where oid = 'public.dsul_tick(text, boolean)'::regprocedure")" t
check "search_path is empty"          "$(qa -c "select array_to_string(proconfig, ' ') from pg_proc where oid = 'public.dsul_tick(text, boolean)'::regprocedure")" \
                                      'search_path=""'
check "anon cannot execute"           "$(qa -c "select has_function_privilege('anon', 'public.dsul_tick(text, boolean)', 'execute')")" f
check "authenticated cannot execute"  "$(qa -c "select has_function_privilege('authenticated', 'public.dsul_tick(text, boolean)', 'execute')")" f
check "ledger row 058"                "$(qa -c "select name from supabase_migrations.schema_migrations where version = '058'")" resume_cron_tick

echo "── idempotence: a second run must change nothing ──"
apply "$TARGET" 2> "$WORK/run2.log" || { cat "$WORK/run2.log" >&2; exit 1; }
snapshot > "$WORK/s2"
if diff -q "$WORK/s1" "$WORK/s2" >/dev/null; then
  echo "  ok    snapshots identical ($(wc -l < "$WORK/s1") lines)"
else
  echo "  FAIL  re-running 058 changed the state:" >&2
  diff "$WORK/s1" "$WORK/s2" >&2 || true
  FAILS=$((FAILS + 1))
fi
check "second run takes no re-create path" "$(grep -c 're-created' "$WORK/run2.log" || true)" 0

echo "── a dsul-reminders unscheduled by hand is re-created, then resumed ──"
q -c "select cron.unschedule('dsul-reminders')" >/dev/null
apply "$TARGET" 2> "$WORK/run3.log" || { cat "$WORK/run3.log" >&2; exit 1; }
check "the re-create path ran"        "$(grep -c 're-created' "$WORK/run3.log" || true)" 1
check "dsul-reminders back, active"   "$(qa -c "select schedule || ' ' || active from cron.job where jobname = 'dsul-reminders'")" "*/5 * * * * true"
check "…with the one-argument body"   "$(qa -c "select command from cron.job where jobname = 'dsul-reminders'")" \
                                      "select public.dsul_tick('/api/cron/reminders')"

# ── 6. the tick's behaviour ───────────────────────────────────────────────────
echo "── the short-circuit, read from the stub queue ──"
CALL="select public.dsul_tick('/api/cron/reminders')"
check "no settings rows, no Vault → 0"       "$(tick "$CALL")" 0

q >/dev/null <<'SQL'
select vault.create_secret('https://do.dsul.app/', 'dsul_app_url');
select vault.create_secret('s3cret-058', 'dsul_cron_secret');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000058a1', 'one@verify.test'),
  ('00000000-0000-0000-0000-0000000058a2', 'two@verify.test');
insert into public.user_settings (user_id) values
  ('00000000-0000-0000-0000-0000000058a1'),
  ('00000000-0000-0000-0000-0000000058a2');
SQL
check "Vault set, nobody enabled → 0"        "$(tick "$CALL")" 0

U1="user_id = '00000000-0000-0000-0000-0000000058a1'"
q -c "update public.user_settings set timezone = 'America/Los_Angeles', eod_review_enabled = true where $U1"
check "one account, zone + EOD → 1"          "$(tick "$CALL")" 1
check "…a GET"                               "$(qa -c "select method from net.http_request_queue")" GET
check "…to the route, trailing slash trimmed" "$(qa -c "select url from net.http_request_queue")" \
                                             "https://do.dsul.app/api/cron/reminders"
check "…with the bearer from Vault"          "$(qa -c "select headers ->> 'Authorization' from net.http_request_queue")" \
                                             "Bearer s3cret-058"
check "…inside the route's 60 s budget"      "$(qa -c "select timeout_milliseconds from net.http_request_queue")" 55000
check "the job's own body → 1 (one arg resolves)" \
      "$(tick "do \$\$ begin execute (select command from cron.job where jobname = 'dsul-reminders'); end \$\$")" 1

q -c "update public.user_settings set eod_review_enabled = false, habit_reminders_enabled = true where $U1"
check "habit reminders alone → 1"            "$(tick "$CALL")" 1
q -c "update public.user_settings set habit_reminders_enabled = false, stakes_enabled = true where $U1"
check "stakes alone → 1"                     "$(tick "$CALL")" 1
q -c "update public.user_settings set stakes_enabled = false, morning_check_enabled = true where $U1"
check "morning check alone → 0 (not a tick ritual)" "$(tick "$CALL")" 0

q -c "update public.user_settings set eod_review_enabled = true, timezone = null where $U1"
check "enabled but no time zone → 0"         "$(tick "$CALL")" 0
q -c "update public.user_settings set timezone = 'America/Los_Angeles' where $U1"

q -c "delete from vault.secrets where name = 'dsul_cron_secret'"
check "Vault cron secret unset → 0"          "$(tick "$CALL")" 0
q -c "select vault.create_secret('s3cret-anchor', 'anchor_cron_secret')" >/dev/null
check "anchor_cron_secret fallback → 1"      "$(tick "$CALL")" 1
check "…with the fallback bearer"            "$(qa -c "select headers ->> 'Authorization' from net.http_request_queue")" \
                                             "Bearer s3cret-anchor"

q -c "update public.user_settings set eod_review_enabled = false where $U1"
check "nobody enabled again → 0"             "$(tick "$CALL")" 0
check "force := true, nobody enabled → 1"    "$(tick "select public.dsul_tick('/api/cron/reminders', true)")" 1

echo "── fails open when the gate's own read cannot run ──"
q -c "alter table public.user_settings rename column stakes_enabled to stakes_enabled_moved"
check "a column renamed away → 1 (undefined_column)" "$(tick "$CALL")" 1
q -c "alter table public.user_settings rename column stakes_enabled_moved to stakes_enabled"
q -c "alter table public.user_settings rename to user_settings_moved"
check "the table renamed away → 1 (undefined_table)" "$(tick "$CALL")" 1
q -c "alter table public.user_settings_moved rename to user_settings"
check "restored, nobody enabled → 0"         "$(tick "$CALL")" 0

echo "── who may call it ──"
for role in anon authenticated; do
  if q -c "set role $role; $CALL" >/dev/null 2> "$WORK/role.err"; then
    check "$role is refused" "allowed" "permission denied"
  else
    check "$role is refused" "$(grep -o 'permission denied' "$WORK/role.err" | head -1)" "permission denied"
  fi
done

# ── 7. the bare pass ──────────────────────────────────────────────────────────
# What prod would look like if pg_cron or pg_net were ever removed, and what a
# plain local Postgres looks like: every cron block must be a no-op, the
# function must still be replaced. A CALL with someone enabled would then fail
# on net.http_get, which is 044's behaviour too; an idle call must not.
echo "── bare: pg_cron and pg_net dropped, 058 must still apply ──"
q -c "drop extension pg_cron cascade; drop extension pg_net cascade;" 2>/dev/null
check "cron.job gone"                         "$(qa -c "select to_regclass('cron.job') is null")" t
check "net schema gone"                       "$(qa -c "select to_regnamespace('net') is null")" t
if q -1 -f "$TARGET" > /dev/null 2> "$WORK/bare1.log" && q -1 -f "$TARGET" > /dev/null 2> "$WORK/bare2.log"; then
  check "applies twice on bare Postgres (rc 0)" ok ok
else
  check "applies twice on bare Postgres (rc 0)" "$(grep -h -m1 'ERROR' "$WORK"/bare*.log)" ok
fi
check "the function is still there"           "$(qa -c "select to_regprocedure('public.dsul_tick(text, boolean)') is not null")" t
if q -c "$CALL" >/dev/null 2> "$WORK/bare-call.err"; then
  check "an idle tick returns without touching net" ok ok
else
  check "an idle tick returns without touching net" "$(grep -m1 'ERROR' "$WORK/bare-call.err")" ok
fi

echo
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed." >&2
  exit 1
fi
echo "058 verified against PostgreSQL $("$PGBIN/postgres" --version | awk '{print $3}') ($REPLAYED migrations replayed first)."
