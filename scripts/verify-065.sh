#!/usr/bin/env bash
#
# verify-065.sh — replay the real migrations onto a bare Postgres, then 065
# (the device registry) twice, and hold it to the reminders plan's #254 fixture.
#
# WHY THIS EXISTS. 065 is the first migration to make a cross-tenant write the
# design depends on: register_device() deletes another account's row when it
# holds the same push token (memory/plans/reminders-platforms.md §3.2), and the
# owner's read is a COLUMN grant that must never reach `token` or `keys`.
# tests/unit/migration-text.test.ts and devices-migration.test.ts hold the text;
# this is the database's own answer, as role, grant and row.
#
# Modelled on scripts/verify-063.sh: the same stub pg_cron and pg_net, the same
# bare cluster on a Unix socket, the same stand-ins for what Supabase provides.
#
# WHAT IT CHECKS
#   1. 000..064, then push_subscriptions rows to backfill: accounts A and B both
#      holding one endpoint (#254, B's newer), A's endpoint subscribed 400 days
#      ago, and a malformed endpoint 009 never checked.
#   2. 065 applied: one row per endpoint, the shared one B's; the old one
#      `last_seen_at` now (not born stale) with `registered_at` kept; the
#      malformed one left in the ballast; `prune-devices` scheduled at 03:41.
#      Applied again: rows, constraints, grants, policies and jobs identical.
#   3. As `authenticated` (A): `select *` is refused (42501), the granted
#      columns show A's rows only, `prefs` and `label` update, `token` and
#      inserts do not, and register_device is not A's to call.
#   4. As `service_role`: registering as A with B's endpoint retires B's row
#      (the token decides ownership); the same token again keeps
#      `registered_at`; a new token moves it; a label given on the first
#      registration survives a later one that sends none.
#   5. Deleting A's auth user deletes A's devices.
#
# NOT WIRED INTO CI, for the reason verify-058.sh gives: CI has no Postgres
# binary outside the Supabase stack. Run it by hand before 065 is applied:
#
#     sudo ./scripts/verify-065.sh       # or PGBIN=/path/to/pg/bin
#
# It needs no Supabase credentials and cannot reach a remote database: the
# server listens on a Unix socket in its own scratch directory and nowhere else.

set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PORT=${PORT:-55464}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
TARGET="$MIGRATIONS/065_devices.sql"

if [ ! -x "$PGBIN/initdb" ] || [ ! -x "$PGBIN/pg_config" ]; then
  echo "no Postgres at $PGBIN; set PGBIN=/path/to/postgres/bin" >&2
  exit 1
fi
[ -f "$TARGET" ] || { echo "no $TARGET" >&2; exit 1; }

EXTDIR="$("$PGBIN/pg_config" --sharedir)/extension"
STUB_MARK='dsul verify-065 stub'
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
  WORK="$(mktemp -d /var/lib/postgresql/verify-065.XXXXXX)"
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

# ── 1. the stub extensions (verify-058.sh's, as far as 000..065 use them) ─────
cat > "$EXTDIR/pg_cron.control" <<EOF
# $STUB_MARK — NOT pg_cron. Written and removed by scripts/verify-065.sh.
comment = '$STUB_MARK: pg_cron signatures, no scheduler'
default_version = '1.6'
relocatable = false
superuser = true
EOF
cat > "$EXTDIR/pg_cron--1.6.sql" <<EOF
-- $STUB_MARK — NOT pg_cron. Written and removed by scripts/verify-065.sh.
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
# $STUB_MARK — NOT pg_net. Written and removed by scripts/verify-065.sh.
comment = '$STUB_MARK: pg_net signatures, no worker'
default_version = '0.14'
relocatable = false
superuser = true
EOF
cat > "$EXTDIR/pg_net--0.14.sql" <<EOF
-- $STUB_MARK — NOT pg_net. Written and removed by scripts/verify-065.sh.
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

# A fresh database with every migration before 065 replayed into it.
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
E1='https://fcm.googleapis.com/fcm/send/shared-endpoint-0001'
E2='https://web.push.apple.com/old-endpoint-of-a-0002'
E3='https://updates.push.services.mozilla.com/wpush/v2/new-0003'

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
register() { # register <user> <device> <token> [label]
  local label="${4:-}"
  as_service "select public.register_device('$1', '$2', 'web', 'webpush', 'push', 'macos', 'desktop', '$3',
    jsonb_build_object('p256dh', 'BPk', 'auth', 'au'), null, null, $( [ -n "$label" ] && echo "'$label'" || echo null ),
    null, null, 'Europe/London');" >/dev/null
}
snapshot() {
  qa -c "select user_id, device_id, platform, transport, delivery, token, keys::text, label, registered_at
           from public.devices order by device_id"
  qa -c "select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.devices'::regclass order by 1"
  qa -c "select indexname, indexdef from pg_indexes where tablename = 'devices' order by 1"
  qa -c "select grantee, privilege_type, column_name from information_schema.column_privileges
          where table_name = 'devices' and grantee in ('anon', 'authenticated') order by 1, 2, 3"
  qa -c "select grantee, privilege_type from information_schema.role_table_grants
          where table_name = 'devices' order by 1, 2"
  qa -c "select policyname, cmd, qual, with_check from pg_policies where tablename = 'devices' order by 1"
  qa -c "select jobname, schedule, command from cron.job order by jobname"
  qa -c "select proname, prosecdef, proconfig::text, proacl::text from pg_proc where proname = 'register_device'"
}

# ── 4. 065 on a database with subscriptions to backfill ──────────────────────
echo "── 065 applied twice ──"
build devices
q >/dev/null <<SQL
insert into auth.users (id, email) values ('$A', 'a@verify.test'), ('$B', 'b@verify.test');
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, created_at) values
  ('$A', '$E1', 'pA', 'aA', now() - interval '3 days'),
  ('$B', '$E1', 'pB', 'aB', now() - interval '1 day'),
  ('$A', '$E2', 'p2', 'a2', now() - interval '400 days'),
  ('$A', 'short', 'p', 'a', now());
SQL
apply "$TARGET"
snapshot > "$WORK/s1"
check "one row per endpoint, the malformed one left out" \
      "$(qa -c "select count(*) from public.devices")" 2
check "the shared endpoint is B's, the newer subscriber's" \
      "$(qa -c "select user_id || ' ' || (keys ->> 'p256dh') from public.devices where token = '$E1'")" "$B pB"
check "its device id is web: + sha256 of the endpoint" \
      "$(qa -c "select device_id = 'web:' || encode(sha256(convert_to('$E1', 'UTF8')), 'hex') from public.devices where token = '$E1'")" t
check "a 400-day-old subscription is seen now, not born stale" \
      "$(qa -c "select last_seen_at > now() - interval '1 minute' from public.devices where token = '$E2'")" t
check "…and keeps its first registration" \
      "$(qa -c "select registered_at < now() - interval '399 days' from public.devices where token = '$E2'")" t
check "009 is kept as ballast" "$(qa -c "select count(*) from public.push_subscriptions")" 4
check "prune-devices runs at 03:41" "$(qa -c "select schedule from cron.job where jobname = 'prune-devices'")" "41 3 * * *"
check "ledger row 065" "$(qa -c "select name from supabase_migrations.schema_migrations where version = '065'")" devices
apply "$TARGET"
snapshot > "$WORK/s2"
if diff -q "$WORK/s1" "$WORK/s2" >/dev/null; then
  echo "  ok    a second run changes nothing ($(wc -l < "$WORK/s1") lines of state)"
else
  echo "  FAIL  re-running 065 changed the state:" >&2
  diff "$WORK/s1" "$WORK/s2" >&2 || true
  FAILS=$((FAILS + 1))
fi

# ── 5. the owner's view ───────────────────────────────────────────────────────
echo "── as authenticated ──"
check "select * is refused (no token or keys)" "$(refused "$A" "select * from public.devices;")" "permission denied"
check "select token is refused" "$(refused "$A" "select token from public.devices;")" "permission denied"
check "the granted columns show A's rows only" \
      "$(as_user "$A" "select count(*) || ' ' || bool_and(user_id = '$A') from public.devices;")" "1 true"
check "prefs and label update" \
      "$(as_user "$A" "with u as (update public.devices set prefs = '{\"muted\": true}', label = 'Old Mac' returning 1) select count(*) from u;")" 1
check "…and only A's: B's row is not reachable" \
      "$(as_user "$A" "with u as (update public.devices set label = 'mine' where user_id = '$B' returning 1) select count(*) from u;")" 0
check "token does not update" \
      "$(refused "$A" "update public.devices set token = 'https://evil.example/endpoint-0000';")" "permission denied"
check "no insert" \
      "$(refused "$A" "insert into public.devices (user_id, device_id, platform, transport) values ('$A', 'forged-000', 'web', 'none');")" "permission denied"
check "register_device is not the owner's to call" \
      "$(refused "$A" "select public.register_device('$A', 'dev-a-0001', 'web', 'webpush', 'push', null, null, '$E1', '{\"p256dh\":\"x\",\"auth\":\"y\"}'::jsonb, null, null, null, null, null, null);")" \
      "permission denied"
check "anon reads nothing" \
      "$(if qa <<<"begin; set local role anon; select count(*) from public.devices; commit;" >/dev/null 2>&1; then echo allowed; else echo refused; fi)" refused

# ── 6. the one writer ─────────────────────────────────────────────────────────
echo "── register_device as service_role ──"
register "$A" dev-a-0001 "$E1" "Kitchen laptop"
check "A registering B's endpoint retires B's row" \
      "$(qa -c "select string_agg(user_id || ':' || device_id, ' ') from public.devices where token = '$E1'")" "$A:dev-a-0001"
check "B has no device left" "$(qa -c "select count(*) from public.devices where user_id = '$B'")" 0
first="$(qa -c "select registered_at from public.devices where device_id = 'dev-a-0001'")"
qa -c "select pg_sleep(0.05)" >/dev/null
register "$A" dev-a-0001 "$E1"
check "the same token keeps registered_at" \
      "$(qa -c "select registered_at = '$first' from public.devices where device_id = 'dev-a-0001'")" t
check "a label given once survives a registration that sends none" \
      "$(qa -c "select label from public.devices where device_id = 'dev-a-0001'")" "Kitchen laptop"
qa -c "select pg_sleep(0.05)" >/dev/null
register "$A" dev-a-0001 "$E3"
check "a new token moves registered_at" \
      "$(qa -c "select registered_at > '$first' and token = '$E3' from public.devices where device_id = 'dev-a-0001'")" t
check "still one row for the device" "$(qa -c "select count(*) from public.devices where device_id = 'dev-a-0001'")" 1
register "$B" dev-b-0001 "$E3"
check "B taking it back retires A's" \
      "$(qa -c "select string_agg(user_id::text, ' ') from public.devices where token = '$E3'")" "$B"

# ── 7. deletion ───────────────────────────────────────────────────────────────
echo "── deleting an account ──"
q -c "delete from auth.users where id = '$B'"
check "B's devices go with B" "$(qa -c "select count(*) from public.devices where user_id = '$B'")" 0
check "A's are untouched" "$(qa -c "select count(*) from public.devices where user_id = '$A'")" 1

echo
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS check(s) failed." >&2
  exit 1
fi
echo "065 verified against PostgreSQL $("$PGBIN/postgres" --version | awk '{print $3}')."
