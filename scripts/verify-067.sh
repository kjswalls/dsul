#!/usr/bin/env bash
#
# verify-067.sh — replay the real migrations onto a bare Postgres, then 067
# (cue_log, the reminders ledger) twice, and hold it to its posture.
#
# WHY THIS EXISTS. cue_log is a LEDGER: its owner may read it and nothing
# else, and the service role writes it (memory/plans/reminders-platforms.md
# §4.3, the plan's "060_cue_log.sql", renumbered). A grant left behind by
# Supabase's default privileges would let a user edit what went out to them.
# tests/unit/migration-text.test.ts holds the text; this is the database's
# own answer, as role, grant and row.
#
# Modelled on scripts/verify-065.sh: the same stub pg_cron and pg_net, the
# same bare cluster on a Unix socket, the same stand-ins for what Supabase
# provides.
#
# WHAT IT CHECKS
#   1. 000..066, then 067: the table, its checks, prune-cue-log at 03:53, the
#      ledger row. Applied again: rows, constraints, grants, policies and jobs
#      identical.
#   2. As `authenticated` (A): A's rows only; no insert, update or delete, so
#      not even acked_at is the owner's to write.
#   3. As `service_role`: a row in, a second with the same (user, key)
#      refused, a kind and a day the checks refuse, the ack the route makes.
#   4. Deleting A's auth user deletes A's ledger, and only A's.
#
# NOT WIRED INTO CI, for the reason verify-058.sh gives: CI has no Postgres
# binary outside the Supabase stack. Run it by hand before 067 is applied:
#
#     sudo ./scripts/verify-067.sh       # or PGBIN=/path/to/pg/bin
#
# It needs no Supabase credentials and cannot reach a remote database: the
# server listens on a Unix socket in its own scratch directory and nowhere else.

set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PORT=${PORT:-55467}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
TARGET="$MIGRATIONS/067_cue_log.sql"

if [ ! -x "$PGBIN/initdb" ] || [ ! -x "$PGBIN/pg_config" ]; then
  echo "no Postgres at $PGBIN; set PGBIN=/path/to/postgres/bin" >&2
  exit 1
fi
[ -f "$TARGET" ] || { echo "no $TARGET" >&2; exit 1; }

EXTDIR="$("$PGBIN/pg_config" --sharedir)/extension"
STUB_MARK='dsul verify-067 stub'
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
  WORK="$(mktemp -d /var/lib/postgresql/verify-067.XXXXXX)"
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

# ── 1. the stub extensions (verify-058.sh's, as far as 000..067 use them) ─────
cat > "$EXTDIR/pg_cron.control" <<EOF
# $STUB_MARK — NOT pg_cron. Written and removed by scripts/verify-067.sh.
comment = '$STUB_MARK: pg_cron signatures, no scheduler'
default_version = '1.6'
relocatable = false
superuser = true
EOF
cat > "$EXTDIR/pg_cron--1.6.sql" <<EOF
-- $STUB_MARK — NOT pg_cron. Written and removed by scripts/verify-067.sh.
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
# $STUB_MARK — NOT pg_net. Written and removed by scripts/verify-067.sh.
comment = '$STUB_MARK: pg_net signatures, no worker'
default_version = '0.14'
relocatable = false
superuser = true
EOF
cat > "$EXTDIR/pg_net--0.14.sql" <<EOF
-- $STUB_MARK — NOT pg_net. Written and removed by scripts/verify-067.sh.
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

# A fresh database with every migration before 067 replayed into it.
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

FAILS=0
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then
    echo "  ok    $1"
  else
    echo "  FAIL  $1: got '$2', want '$3'" >&2
    FAILS=$((FAILS + 1))
  fi
}


A=aaaaaaaa-0000-4000-8000-000000000001
B=bbbbbbbb-0000-4000-8000-000000000002
I=cccccccc-0000-4000-8000-000000000003

# As `authenticated`, signed in as $1; the rest of the arguments are SQL.
as_user() {
  local who="$1"; shift
  qa <<SQL
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$who';
set local request.jwt.claim.role = 'authenticated';
$*
commit;
SQL
}
# The same, expecting a refusal: prints the SQLSTATE-ish word it was refused with.
refused() {
  local who="$1"; shift
  if as_user "$who" "$*" >/dev/null 2> "$WORK/err"; then echo allowed; else
    grep -o 'permission denied' "$WORK/err" | head -1 || cat "$WORK/err" >&2
  fi
}
as_service() { # every statement in it ends with a semicolon, or `commit` becomes a column alias
  qa <<SQL
begin;
set local role service_role;
$*
commit;
SQL
}
snapshot() {
  qa -c "select user_id, key, kind, acked_device from public.cue_log order by user_id, key"
  qa -c "select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.cue_log'::regclass order by 1"
  qa -c "select indexname, indexdef from pg_indexes where tablename = 'cue_log' order by 1"
  qa -c "select grantee, privilege_type from information_schema.role_table_grants
          where table_name = 'cue_log' order by 1, 2"
  qa -c "select policyname, cmd, qual, with_check from pg_policies where tablename = 'cue_log' order by 1"
  qa -c "select jobname, schedule, command from cron.job order by jobname"
}
row() { # row <user> <key> [kind] [date]
  as_service "insert into public.cue_log (user_id, key, kind, item_id, date_str, collapse_id, window_end, claimed_at)
    values ('$1', '$2', '${3:-cue}', '$I', '${4:-2026-10-10}', 'dsul-item-$I', now() + interval '30 minutes', now());"
}

# ── 4. 067, twice ─────────────────────────────────────────────────────────────
echo "── 067 applied twice ──"
build ledger
q >/dev/null <<SQL
insert into auth.users (id, email) values ('$A', 'a@verify.test'), ('$B', 'b@verify.test');
SQL
apply "$TARGET"
row "$A" "cue:$I:2026-10-10T07:30" >/dev/null
row "$B" "cue:$I:2026-10-10T07:30" >/dev/null
snapshot > "$WORK/s1"
check "the table is there" "$(qa -c "select to_regclass('public.cue_log') is not null")" t
check "RLS is on" "$(qa -c "select relrowsecurity from pg_class where oid = 'public.cue_log'::regclass")" t
check "prune-cue-log runs at 03:53" "$(qa -c "select schedule from cron.job where jobname = 'prune-cue-log'")" "53 3 * * *"
check "ledger row 067" "$(qa -c "select name from supabase_migrations.schema_migrations where version = '067'")" cue_log
apply "$TARGET"
snapshot > "$WORK/s2"
if diff -q "$WORK/s1" "$WORK/s2" >/dev/null; then
  echo "  ok    a second run changes nothing ($(wc -l < "$WORK/s1") lines of state)"
else
  echo "  FAIL  re-running 067 changed the state:" >&2
  diff "$WORK/s1" "$WORK/s2" >&2 || true
  FAILS=$((FAILS + 1))
fi

# ── 5. the owner's view ───────────────────────────────────────────────────────
echo "── as authenticated ──"
check "A reads A's rows only" \
      "$(as_user "$A" "select count(*) || ' ' || bool_and(user_id = '$A') from public.cue_log;")" "1 true"
check "no insert" \
      "$(refused "$A" "insert into public.cue_log (user_id, key, kind, date_str, collapse_id, window_end) values ('$A', 'eod:2026-10-10', 'eod', '2026-10-10', 'x', now());")" \
      "permission denied"
check "no update, not even acked_at" \
      "$(refused "$A" "update public.cue_log set acked_at = now();")" "permission denied"
check "no delete" "$(refused "$A" "delete from public.cue_log;")" "permission denied"
check "anon reads nothing" \
      "$(if qa <<<"begin; set local role anon; select count(*) from public.cue_log; commit;" >/dev/null 2>&1; then echo allowed; else echo refused; fi)" refused

# ── 6. the writer ─────────────────────────────────────────────────────────────
echo "── as service_role ──"
check "one row per (user, key)" \
      "$(if row "$A" "cue:$I:2026-10-10T07:30" >/dev/null 2>&1; then echo allowed; else echo refused; fi)" refused
check "a kind outside the list is refused" \
      "$(if row "$A" "nudge:2026-10-10" nudge >/dev/null 2>&1; then echo allowed; else echo refused; fi)" refused
check "a day that is not yyyy-MM-dd is refused" \
      "$(if row "$A" "eod:10/10/2026" eod 10/10/2026 >/dev/null 2>&1; then echo allowed; else echo refused; fi)" refused
check "the ack: first one lands" \
      "$(as_service "with u as (update public.cue_log set acked_at = now(), acked_device = 'web-0000aaaa'
         where user_id = '$A' and key = 'cue:$I:2026-10-10T07:30' and acked_at is null returning 1) select count(*) from u;")" 1
check "…and a second does not move it" \
      "$(as_service "with u as (update public.cue_log set acked_at = now(), acked_device = 'web-0000bbbb'
         where user_id = '$A' and key = 'cue:$I:2026-10-10T07:30' and acked_at is null returning 1) select count(*) from u;")" 0
check "B's row is untouched by A's ack" \
      "$(qa -c "select acked_at is null from public.cue_log where user_id = '$B'")" t

# ── 7. deletion ───────────────────────────────────────────────────────────────
echo "── deleting an account ──"
q -c "delete from auth.users where id = '$A'"
check "A's ledger goes with A" "$(qa -c "select count(*) from public.cue_log where user_id = '$A'")" 0
check "B's is untouched" "$(qa -c "select count(*) from public.cue_log where user_id = '$B'")" 1

echo
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed." >&2
  exit 1
fi
echo "067 verified against PostgreSQL $("$PGBIN/postgres" --version | awk '{print $3}')."
