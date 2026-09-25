#!/usr/bin/env bash
#
# verify-039.sh — run migration 039 against a real Postgres and check the result.
#
# WHY THIS EXISTS. `tests/unit/collapse-classify-kind.test.ts` asserts on the
# migration's TEXT, and its own docblock says what that is worth: it cannot
# catch a syntax error, a wrong column name, or a join that matches the wrong
# rows. Those are exactly the failures a data migration has, and the only
# instrument that finds them is a database.
#
# So this stands one up from scratch, reconstructs the pre-039 schema from the
# migrations directory, loads a fixture built from the edge cases 027's header
# and 039's own header name, applies the migration, and asserts on the rows.
# Then it applies it twice more and checks the snapshot is byte-identical, which
# is the re-runnability claim the text test can only approximate.
#
# NOT WIRED INTO CI, deliberately. It needs a Postgres 15+ binary (039 section 1
# requires `ON DELETE SET NULL (column)`), and CI has none. Run it by hand when
# touching 039 or anything about the container collapse:
#
#     ./scripts/verify-039.sh
#
# It writes only inside a scratch directory it creates and removes, and never
# touches a real project. It does NOT need Supabase credentials and cannot reach
# a remote database.
#
# THE SCHEMA BELOW IS A RECONSTRUCTION, and the one thing to keep honest.
# `projects` and `habit_groups` predate the ledger (prod got them from the old
# schema.sql bootstrap; on an empty database 000_baseline.sql creates them), so
# their shape here is taken from lib/db.ts's ProjectRow
# and HabitGroupRow, 013's `deleted_at`, and the `(user_id, name)` unique indexes
# that 027 and lib/seed-containers.ts both name. `items` is the subset of 019 +
# 027 that 039 touches. If the real shape ever contradicts this, the migration is
# the thing that was verified against a lie — fix the fixture first.

set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PORT=${PORT:-55432}
MIGRATION="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations/039_one_classify_kind.sql"
WORK=$(mktemp -d)
trap 'set +e; su postgres -c "$PGBIN/pg_ctl -D $WORK/data stop -m immediate" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

if [ ! -x "$PGBIN/initdb" ]; then
  echo "no Postgres at $PGBIN — set PGBIN=/path/to/postgres/bin" >&2
  exit 1
fi

# initdb refuses to run as root, which is the common case in a container.
RUNAS=""
[ "$(id -u)" = 0 ] && RUNAS="su postgres -c" && chown -R postgres:postgres "$WORK"
run() { if [ -n "$RUNAS" ]; then su postgres -c "$*"; else eval "$*"; fi }

run "$PGBIN/initdb -D $WORK/data -U postgres --auth=trust" >/dev/null
run "$PGBIN/pg_ctl -D $WORK/data -o '-k $WORK -p $PORT -c listen_addresses=' -l $WORK/log start -w" >/dev/null
q() { psql -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

# ── the pre-039 shape ────────────────────────────────────────────────────────
q <<'SQL'
create table public.projects (
  id uuid primary key, user_id uuid not null, name text not null, emoji text not null,
  color text, repeat_frequency text, repeat_days int[], repeat_month_day int,
  time_bucket text, start_time text, duration int,
  created_at timestamptz not null default now(), deleted_at timestamptz,
  constraint projects_user_id_name_key unique (user_id, name));
create table public.habit_groups (
  id uuid primary key, user_id uuid not null, name text not null, emoji text not null,
  color text, created_at timestamptz not null default now(), deleted_at timestamptz,
  constraint habit_groups_user_id_name_key unique (user_id, name));
create table public.items (
  id uuid primary key, user_id uuid not null, type text not null, title text not null,
  status text, project text, "group" text, project_id uuid, group_id uuid,
  deleted_at timestamptz);
-- 027's composite FKs, ON DELETE SET NULL with a column list (needs PG 15+).
alter table public.projects add constraint projects_id_user_id_key unique (id, user_id);
alter table public.habit_groups add constraint habit_groups_id_user_id_key unique (id, user_id);
alter table public.items add constraint items_project_id_fkey
  foreign key (project_id, user_id) references public.projects (id, user_id)
  on delete set null (project_id);
alter table public.items add constraint items_group_id_fkey
  foreign key (group_id, user_id) references public.habit_groups (id, user_id)
  on delete set null (group_id);
SQL

# ── the fixture: one row per edge case 039's header claims to handle ─────────
q <<'SQL'
insert into public.projects (id, user_id, name, emoji, color, deleted_at) values
  ('00000000-0000-0000-0000-0000000000a1','aaaaaaaa-0000-0000-0000-000000000001','Work','icon:Briefcase','var(--accent-1)',null),
  ('00000000-0000-0000-0000-0000000000a2','aaaaaaaa-0000-0000-0000-000000000001','Health','icon:HeartPulse','var(--accent-2)',null),
  ('00000000-0000-0000-0000-0000000000a3','aaaaaaaa-0000-0000-0000-000000000001','Retired','icon:Box',null,'2026-08-01T00:00:00Z');
insert into public.habit_groups (id, user_id, name, emoji, color, deleted_at) values
  ('00000000-0000-0000-0000-0000000000b1','aaaaaaaa-0000-0000-0000-000000000001','health','⭐','var(--habit-x)',null),
  ('00000000-0000-0000-0000-0000000000b2','aaaaaaaa-0000-0000-0000-000000000001','Morning','🌅',null,null),
  ('00000000-0000-0000-0000-0000000000b3','aaaaaaaa-0000-0000-0000-000000000001','Wind-down','🌙',null,'2026-08-02T00:00:00Z'),
  -- fold-equal to each other, with the BINNED one holding the LOWER id, so a
  -- preference that merely sorts by id passes while a live-first one is needed.
  ('00000000-0000-0000-0000-0000000000b4','aaaaaaaa-0000-0000-0000-000000000001','movement','🏃',null,'2026-08-03T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000b5','aaaaaaaa-0000-0000-0000-000000000001','Movement','👟',null,null);
insert into public.items (id, user_id, type, title, status, project, "group", project_id, group_id) values
  ('00000000-0000-0000-0000-0000000000c1','aaaaaaaa-0000-0000-0000-000000000001','task','Plan','pending','Work',null,'00000000-0000-0000-0000-0000000000a1',null),
  ('00000000-0000-0000-0000-0000000000c2','aaaaaaaa-0000-0000-0000-000000000001','habit','Stretch','pending',null,'health',null,'00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000c3','aaaaaaaa-0000-0000-0000-000000000001','habit','Vitamins','pending',null,'Morning',null,'00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000c4','aaaaaaaa-0000-0000-0000-000000000001','habit','Read','pending',null,'Wind-down',null,'00000000-0000-0000-0000-0000000000b3'),
  ('00000000-0000-0000-0000-0000000000c5','aaaaaaaa-0000-0000-0000-000000000001','habit','Journal','pending',null,'Personal',null,null),
  ('00000000-0000-0000-0000-0000000000c6','aaaaaaaa-0000-0000-0000-000000000001','habit','Floss','pending',null,'',null,null),
  ('00000000-0000-0000-0000-0000000000c7','aaaaaaaa-0000-0000-0000-000000000001','habit','Walk','pending','Work','Morning','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000c8','aaaaaaaa-0000-0000-0000-000000000001','habit','Run','pending',null,'movement',null,'00000000-0000-0000-0000-0000000000b4');
-- A neighbour holding the same names, so per-user scoping is exercised.
insert into public.projects (id, user_id, name, emoji) values
  ('00000000-0000-0000-0000-0000000000d1','bbbbbbbb-0000-0000-0000-000000000002','Health','icon:HeartPulse');
insert into public.habit_groups (id, user_id, name, emoji) values
  ('00000000-0000-0000-0000-0000000000d2','bbbbbbbb-0000-0000-0000-000000000002','Morning','🌅');
insert into public.items (id, user_id, type, title, status, "group", group_id) values
  ('00000000-0000-0000-0000-0000000000d3','bbbbbbbb-0000-0000-0000-000000000002','habit','Meditate','pending','Morning','00000000-0000-0000-0000-0000000000d2');
SQL

echo "── applying 039 ──"
q -f "$MIGRATION" >/dev/null
echo "ok"

echo "── outcomes ──"
q <<'SQL'
do $$
declare fail int := 0;
begin
  -- MERGE, project wins: the habit lands on the PROJECT's id and canonical name.
  if (select project||'/'||project_id::text from items where title='Stretch')
     <> 'Health/00000000-0000-0000-0000-0000000000a2' then
    raise warning 'FAIL merge-project-wins'; fail := fail + 1; end if;
  -- ids preserved across the table move.
  if (select project_id from items where title='Vitamins')
     <> '00000000-0000-0000-0000-0000000000b2' then
    raise warning 'FAIL id-preserved'; fail := fail + 1; end if;
  -- a binned group is carried across, deleted_at intact, member not stranded.
  if (select project_id from items where title='Read')
     <> '00000000-0000-0000-0000-0000000000b3'
     or (select deleted_at from projects where id='00000000-0000-0000-0000-0000000000b3') is null then
    raise warning 'FAIL binned-group-carried'; fail := fail + 1; end if;
  -- text-only reference preserved as text, id honestly NULL.
  if (select project from items where title='Journal') <> 'Personal'
     or (select project_id from items where title='Journal') is not null then
    raise warning 'FAIL text-only-preserved'; fail := fail + 1; end if;
  -- '' is unset and stays unset.
  if (select project from items where title='Floss') is not null then
    raise warning 'FAIL empty-string-skipped'; fail := fail + 1; end if;
  -- an item re-filed AFTER a previous pass is not dragged back.
  if (select project from items where title='Walk') <> 'Work' then
    raise warning 'FAIL refile-not-reverted'; fail := fail + 1; end if;
  -- live beats binned, even when the binned row holds the lower id.
  if (select project_id from items where title='Run')
     <> '00000000-0000-0000-0000-0000000000b5' then
    raise warning 'FAIL live-beats-binned'; fail := fail + 1; end if;
  -- the neighbour is migrated within its own account, not across.
  if (select project_id from items where title='Meditate')
     <> '00000000-0000-0000-0000-0000000000d2' then
    raise warning 'FAIL per-user-scoping'; fail := fail + 1; end if;
  -- BALLAST: every frozen value byte-identical to what the old build wrote.
  if exists (select 1 from items where title='Stretch' and ("group" <> 'health'
       or group_id <> '00000000-0000-0000-0000-0000000000b1')) then
    raise warning 'FAIL ballast-intact'; fail := fail + 1; end if;
  if (select count(*) from habit_groups) <> 6
     or exists (select 1 from habit_groups where name like '%migrated%') then
    raise warning 'FAIL habit_groups-untouched'; fail := fail + 1; end if;

  if fail > 0 then raise exception '% assertion(s) failed', fail; end if;
  raise notice 'all outcome assertions passed';
end$$;
SQL

echo "── idempotence: two more passes must change nothing ──"
SNAP="select 'P',* from projects order by id; select 'I',* from items order by id; select 'G',* from habit_groups order by id;"
psql -h "$WORK" -p "$PORT" -U postgres -At -c "$SNAP" > "$WORK/s1"
q -f "$MIGRATION" >/dev/null
psql -h "$WORK" -p "$PORT" -U postgres -At -c "$SNAP" > "$WORK/s2"
q -f "$MIGRATION" >/dev/null
psql -h "$WORK" -p "$PORT" -U postgres -At -c "$SNAP" > "$WORK/s3"
if ! diff -q "$WORK/s1" "$WORK/s2" >/dev/null || ! diff -q "$WORK/s2" "$WORK/s3" >/dev/null; then
  echo "FAIL: re-running 039 changed the data" >&2
  diff "$WORK/s1" "$WORK/s3" >&2 || true
  exit 1
fi
echo "ok — three runs, identical snapshots"

echo "── the pre-flight must REFUSE two live case-variant projects ──"
q -c "insert into projects (id,user_id,name,emoji) values
  ('00000000-0000-0000-0000-0000000000e1','cccccccc-0000-0000-0000-000000000003','Work','icon:Briefcase'),
  ('00000000-0000-0000-0000-0000000000e2','cccccccc-0000-0000-0000-000000000003','work','icon:Rocket');" >/dev/null
if q -f "$MIGRATION" >/dev/null 2>&1; then
  echo "FAIL: 039 proceeded against an account it cannot repair" >&2
  exit 1
fi
echo "ok — refused"

echo "── …but a BINNED case-variant is harmless and must pass ──"
q -c "update projects set deleted_at = now() where id = '00000000-0000-0000-0000-0000000000e2';" >/dev/null
q -f "$MIGRATION" >/dev/null
echo "ok — applied"

echo
echo "039 verified against PostgreSQL $($PGBIN/postgres --version | awk '{print $3}')."
