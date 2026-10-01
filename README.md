# dsul

**Do Stuff Unlimited** — a personal planning PWA. A day/week schedule grid, a
braindump sidebar, recurring habits, an end-of-day review, reminders that reach
out on their own, and an optional AI assistant (bring your own model).

Next.js App Router + Supabase, deployed on Vercel.

## Getting started

```bash
pnpm install
vercel env pull .env.local   # .env.local is gitignored and Vercel-generated
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

E2E tests need a separate `.env.test` — see `.env.test.example`.

## Commands

```bash
pnpm dev            # next dev --webpack
pnpm build          # next build --webpack
pnpm lint           # eslint .
pnpm test           # vitest run  (unit)
pnpm e2e            # playwright test
pnpm db:list        # supabase migration list
pnpm db:push        # supabase db push
pnpm db:new <name>  # supabase migration new
```

## Layout

pnpm workspace, Node 24.

| Path                | What it is                                                        |
| ------------------- | ----------------------------------------------------------------- |
| `app/`              | Routes — one main page plus `api/` routes                          |
| `components/`       | The UI (`views/`, `shell/`, `planner/`, `sidebar/`, `mobile/`, …)  |
| `lib/`              | Stores, registries, and domain logic                               |
| `packages/types`    | `@dsul/types` — shared Zod schemas; its `dist/` is committed       |
| `openclaw-plugin/`  | `@dsul/openclaw-context` — brings your plan into an AI conversation |
| `supabase/`         | Migrations — the single source of truth for the schema             |
| `memory/plans/`     | Longer-running design docs                                         |

Architecture notes, conventions, and the gotchas worth knowing before editing
live in [CLAUDE.md](CLAUDE.md).
