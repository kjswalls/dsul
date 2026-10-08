# scripts

## `local-setup.sh`

Points `pnpm dev` and/or the Playwright e2e suite at a **local** Supabase instead
of production.

**Why:** `vercel env pull .env.local` writes PRODUCTION credentials, so a plain
`pnpm dev` talks to the production project — and hot reload makes that loud:
every HMR remount re-runs the planner's container fan-out and its `getUser()`
calls, against prod.

The e2e suite had the same problem, and worse (thousands of throwaway auth
sessions on prod — a real Disk-IO cost, see
`supabase/migrations/037_disk_io_hygiene.sql`). CI ran it against prod until
2026-09-24, when overlapping runs took the project down. The 5,917 requests from
`http://localhost:3000/` measured on 2026-09-18 were likely those CI runs too:
`localhost:3000` is the Playwright browser's origin wherever it runs. This script replaces the old
`e2e-local-setup.sh` and covers both from one stack.

### Prerequisites

- Docker running
- Supabase CLI (`supabase`) — <https://supabase.com/docs/guides/cli>. CI pins
  2.117.0 (`.github/workflows/test.yml`); an older CLI calls the mail service
  `inbucket` and rejects `-x mailpit`.
- Memory: budget ~1–1.5 GB RAM for the `e2e` target (trimmed), closer to ~2.5 GB
  for `dev`/`both`, which keep Studio and realtime.
- No `supabase/config.toml` needed up front — the script runs `supabase init` if
  it is missing (it is per-machine local stack config, not schema, which is why
  it is not in the repo).

### Use

```bash
./scripts/local-setup.sh dev          # writes .env.local, for `pnpm dev`
./scripts/local-setup.sh e2e          # writes .env.test,  for `pnpm e2e`
./scripts/local-setup.sh e2e --smoke  # …and run the smoke spec
./scripts/local-setup.sh both         # one stack, both files
```

It starts the local stack → applies all migrations to a clean local DB → creates
the relevant pre-confirmed user(s) → writes the env file(s).

Then:

```bash
pnpm dev            # log in as dev@dsul.test / dev-local-password
pnpm e2e            # full suite against local
supabase stop       # shut the stack down (frees the RAM)
```

### Notes

- **`.env.local` is merged, never overwritten.** It also carries
  `MODEL_KEYS_ENCRYPTION_KEY`, the VAPID pair, `CRON_SECRET` and `KIRBY_USER_ID` —
  only the three Supabase keys are swapped, every other line is carried through,
  and the original is backed up to `.env.local.bak`. The one line the script may
  add is `MODEL_KEYS_ENCRYPTION_KEY`, and only when the file has no usable one: a
  valid key is never replaced, because a rotated key leaves every sealed model key
  unreadable. A blank or malformed one (the app refuses it, so it has sealed
  nothing) is swapped for a fresh key. `.env.test` is fully regenerated (it has nothing else in it, and
  gets a fresh key and a fresh random `CRON_SECRET` each run, the second so
  `tests/e2e/reminders-tick.spec.ts` can call the tick with a bearer the dev
  server enforces), backed up to `.env.test.bak`.
- **Back to production:** `vercel env pull .env.local`.
- Two separate accounts on purpose: `dev@dsul.test` for development and
  `e2e@dsul.test` for the suite, so the e2e litter-sweep never deletes rows you
  were looking at. The e2e address must keep containing `e2e`/`test`/
  `playwright` — that is what unlocks the guard in `tests/e2e/global-setup.ts`.
- Only ever touches the local stack: `supabase db reset` without `--linked`
  cannot reach the hosted project.
- Changing target between `e2e` and `dev`/`both` needs a `supabase stop` first —
  they use different service exclusion lists, and `supabase start` will not
  reconfigure a stack that is already up.
- The URL and keys are read live from `supabase status`, never hardcoded (the
  key names it prints have changed across CLI versions — see the pin above).
- CI runs this script too (`e2e` target, on the runner), in place of the hosted
  values it used to get from repo secrets — those were production's, and its
  runs took prod down on 2026-09-24. The suite refuses any non-loopback Supabase
  URL (`assertLocalTarget` in `tests/e2e/helpers/env.ts`), with no override.
- The replay onto an empty database works because of
  `supabase/migrations/000_baseline.sql`: `001` onward assumed `tasks`, `habits`,
  `projects`, `habit_groups` and `update_updated_at()` from the old `schema.sql`
  bootstrap, which no migration created. Before it, this script stopped at
  `supabase db reset` and had never worked.
- If Docker can't pull from `public.ecr.aws` (some sandboxes block its CDN),
  `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io` pulls the same images from
  Docker Hub.

## `verify-039.sh`

Runs migration `039_one_classify_kind.sql` against a **throwaway local Postgres**
and asserts on the resulting rows: the fold-merge collision rule, ids preserved
across the table move, soft-deleted groups carried with their members, live rows
beating binned ones, text-only references kept, the frozen ballast untouched,
three runs producing an identical snapshot, and the pre-flight refusing an
account it cannot repair.

Not in CI — it needs a Postgres 15+ binary (039 uses `ON DELETE SET NULL
(column)`) and CI has none. Run it by hand when touching 039 or the container
collapse:

```bash
./scripts/verify-039.sh          # or PGBIN=/path/to/pg/bin ./scripts/verify-039.sh
```

It needs no Supabase credentials and cannot reach a remote database. The schema
it stands up is a RECONSTRUCTION of `projects` and `habit_groups` (now also created
by `000_baseline.sql`), so keep the fixture honest first if the real shape ever
disagrees. `tests/unit/collapse-classify-kind.test.ts` covers the same
migration in CI, but only as text: it cannot catch a syntax error or a wrong
join, which is exactly what this finds.

## `verify-058.sh`

Replays the real migrations `000..057` onto a **throwaway bare Postgres**, then
applies `058_resume_cron_tick.sql` and checks what it is for: the jobs (one
`*/5` tick, `dsul-eod-notify` gone, the daily jobs untouched), `dsul_tick`'s
grants and empty `search_path`, a byte-identical snapshot after a second run, a
hand-unscheduled `dsul-reminders` re-created, the short-circuit read from a stub
request queue (nobody enabled → no request; one account → one GET with the
Vault bearer; `force` → one; a missing column or table → one, failing open), and
finally a **bare pass** with both extensions dropped, where 058 must still apply.

CI's E2E job replays every migration too, but on a Supabase stack with real
pg_cron, where an unguarded `cron.*` call passes; this is the only place the
guards are exercised. The repository's migrations cannot replay on a Postgres
without pg_cron and pg_net, so the script installs **stub extensions** into
`$(pg_config --sharedir)/extension/` (refusing to overwrite a real one) and
removes them on exit. That needs root, or write access to that directory:

```bash
sudo ./scripts/verify-058.sh     # or PGBIN=/path/to/pg/bin
```

As root it runs the cluster as the `postgres` OS user under `/var/lib/postgresql/`.
It needs no Supabase credentials and cannot reach a remote database. Run it by
hand before applying 058, or after any edit to `dsul_tick` or the cron jobs.
`tests/unit/migration-text.test.ts` is its cheap twin in CI: it reads every
migration from 058 on as text (empty `search_path`, no `time + interval`, revoke
before grant, no token or keys for `authenticated`, guarded `cron.*`).

## `verify-063.sh`

Deletes accounts on a **throwaway bare Postgres**, before and after
`063_account_deletion.sql`. Deleting an account is one call, GoTrue's admin
delete, and the foreign keys delete everything else
(`memory/plans/account-deletion.md`), so this is where that is proven on a real
database: it replays `000..062`, seeds three users with a row in each of the 28
user tables (and a forged task and item of one user's whose parent is another's),
and checks the state 063 fixes: a deleted account's email left in `bug_reports`,
and one account's forged row blocking another's deletion. Then, on a fresh build
with 063 applied twice: the second run changes nothing, a deleted user leaves no
row anywhere, the forged links go null instead of blocking, the other user keeps
every row, no public foreign key is `no action` or `restrict`, and the
user-column query (every user column with no cascading path to `auth.users`)
lists nothing, though it does list a probe table with a keyless `user_id`. A
third build renames both old constraints first, and 063 still replaces them.

The same stub extensions and bare cluster as `verify-058.sh`, so the same rules:
root, or write access to `$(pg_config --sharedir)/extension/`, stubs removed on
exit, a real pg_cron or pg_net refused:

```bash
sudo ./scripts/verify-063.sh     # or PGBIN=/path/to/pg/bin
```

It needs no Supabase credentials and cannot reach a remote database. Run it by
hand before applying 063, and after any migration that adds a table holding user
data. `tests/unit/account-deletion-migration.test.ts` is its twin in CI, reading
every migration as text: every key to `auth.users` cascades, and every user
column has a cascading path to it.

## `apple-client-secret.mjs`

Mints the client secret Supabase's Apple provider needs: a JWT signed with the Sign
in with Apple key (.p8), valid 180 days (Apple's ceiling is six months). Run it at
setup and again before each expiry, then paste the output into Supabase →
Authentication → Providers → Apple. It prints the expiry date on stderr.

```bash
node scripts/apple-client-secret.mjs --team <Team ID> --key-id <Key ID> \
  --client-id app.dsul.web --p8 ~/Downloads/AuthKey_<Key ID>.p8
```

Nothing is sent anywhere, and the .p8 never belongs in the repo. The full setup and
rotation are in `memory/plans/sign-in-with-apple.md`;
`tests/unit/apple-client-secret.test.ts` checks the claims and the signature.
