# @dsul/types

Shared Zod schemas and TypeScript types for [dsul](https://github.com/kjswalls/dsul).

Used by the dsul Next.js app (`lib/planner-types.ts` imports from here). The
retired `@dsul/openclaw-context` plugin validated API responses with it too,
which is why the legacy projections are still external contracts.

## Building (dist/ is committed)

The app resolves this package through its **committed `dist/`** — the
`exports` map never points at `src/`. After any `src/` edit:

```bash
pnpm --filter @dsul/types build
git add packages/types/dist
```

CI (`.github/workflows/test.yml`, unit-tests job) rebuilds and fails the
build if `dist/` drifts from `src/`. A TypeScript upgrade in the lockfile can
change emitted output — regenerate and commit when that happens.

## Publishing

Not published. It is a workspace package the app takes through
`workspace:*`. (OpenClaw connects without a plugin since 2026-10-14, so npm
publishing was dropped.)

## Usage

```ts
import { TaskSchema, type Task, DsulContextResponseSchema } from '@dsul/types'

// Runtime validation — Zod parses and validates the shape
const result = DsulContextResponseSchema.safeParse(apiResponse)
if (!result.success) {
  console.error('dsul API response changed:', result.error)
} else {
  const { tasks, habits } = result.data  // fully typed ✅
}

// Types only — compile-time, no runtime cost
function doSomething(task: Task) { ... }
```

## Why Zod?

TypeScript types disappear at runtime. If dsul's API schema changes and a consumer isn't updated, you'd get silent data corruption. Zod validates the actual JSON shape at runtime and tells you exactly what changed — so schema drift is caught immediately instead of causing subtle bugs downstream.
