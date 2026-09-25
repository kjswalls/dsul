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
  `OPENAI_API_KEY`, the VAPID pair, `CRON_SECRET` and `KIRBY_USER_ID` — only the
  three Supabase keys are swapped, every other line is carried through, and the
  original is backed up to `.env.local.bak`. `.env.test` is fully regenerated
  (it has nothing else in it), backed up to `.env.test.bak`.
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
