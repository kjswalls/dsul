# AI vision — open decisions

Questions that are **Kirby's, not mine**: product taste, risk appetite, or scope. Each says
what I did in the meantime, so nothing is blocked. Resolved answers move into the locked
decisions in [ai-vision.md](ai-vision.md) and leave here.

**The original eight are resolved** (2026-08-25) and now live in that document's "Resolved
product decisions" section. What follows is what tonight's work opened up.

---

## 1. Scoped API keys, before a third-party runtime holds one

dsul's agent key is **one per user, plaintext, unscoped, no expiry, full read+write**.
That was fine while the only holder was your own gateway. The MCP server does not widen what
a key can do — it is a second protocol over the same surface — but it does change *who
plausibly holds one*: the whole point of MCP is that Claude, Cursor or ChatGPT can connect.

**Current state:** the OpenClaw key is unchanged. Third-party runtimes no longer need it:
since 2026-10-10 they sign in to `/api/mcp` with OAuth instead, getting hashed, expiring,
revocable tokens scoped to read or read-and-change ([mcp-oauth.md](mcp-oauth.md)).
**What it would take:** hashed keys with a prefix, multiple named keys per user, a scope
field (read-only vs read-write), and revocation. `plugins-themes-store.md` already warns
that migrating off the single plaintext key needs a **dual-read deprecation window with a
coordinated OpenClaw npm release**, or the drift-throwing plugin client bricks the one
production integration.
**My lean:** do it before you point any hosted runtime at this, and not before — a read-only
key you can hand out is most of the value.

## 2. Does the OpenClaw plugin's tool surface retire?

MCP now covers everything `openclaw-plugin/src/tools.ts` covers, and more (it reaches
projects, subtasks, notes, durations — the plugin never did). Keeping both means two tool
surfaces that can drift.

**Current state:** both exist; the plugin is untouched.
**My lean:** keep the plugin for what only in-process code can do — context injection, the
webhook receiver, the setup CLI — and let its *tools* be superseded by MCP once you have
confirmed a gateway can reach `/api/mcp`. That is a plugin release, so it wants your say-so.

## 3. Webhooks die on serverless — ~~fix now or when it bites?~~ DONE

`lib/openclaw-registry.ts` kept plugin registrations in an **in-process `Map`** under a
comment saying "in production this would live in Supabase". Production arrived: on Vercel
that Map dies with the instance and is absent on every other one, so a plugin registered
against instance A never heard about a mutation served by instance B. The plugin
re-registering on startup did not save it — the next cold start lost it again.

**Resolved 2026-08-26.** Migration 042 adds `plugin_registrations`, modelled on
`021_item_types` and **service-role only** like `user_secrets`, because the row carries the
HMAC signing secret: a browser-readable copy would let any script forge a change event.

Three things about the shape, all in the file's header: the table is the truth and the old
Map is now a 60-second CACHE (this is called on every mutation, and a query per write to find
usually-zero rows is a real cost for a rare payoff — and bounded staleness beats "invisible to
other instances forever"); it degrades to the Map when the table is absent, so a build
deployed ahead of `db:push` keeps working; and it gates on holding a SERVICE KEY rather than
on `typeof window`, because `lib/db.ts` reaches this from the browser too and Next inlines
only `NEXT_PUBLIC_*` — which also stopped the test suite silently skipping every server path
under jsdom.

## 4. Delegation kickoff — hooks token, or let the agent spawn it?

Phase 2b needs something that actually *starts* a background run. Two shapes: dsul calls
`POST /hooks/agent` on the gateway (needs a dedicated `hooks.token`, a second credential to
store and explain), or the in-chat agent calls `sessions_spawn` itself when you ask it to
take something on (no new credential, but the kickoff only happens inside a conversation).

**Current state:** neither; `user_secrets.openclaw_hooks_token` exists and is unused.
**My lean:** the hooks path, because "delegate" should work from the item without opening a
chat. But it is the first place delegation costs you setup, so it is your call.

---

## Applied to production (2026-08-27, via Supabase MCP)

Migrations **040 / 041 / 042** are live on `anchor` (`ctcspcferkdlzdcqlozq`), recorded in
`supabase_migrations.schema_migrations` under those exact versions so `db push` will not
replay them. Verified after applying: both gateway columns, `items.ai_status_at`, and —
the one that matters — `items_windowed.ai_status_at`, since a column present on the table
but absent from the view is invisible to `fetchItems` forever. `plugin_registrations`
exists with RLS on, zero grants to `authenticated`/`anon`, and the service role granted.

**They were renumbered from 037/038/039 first.** `main` had moved on while this branch was
open and had taken all three numbers (`disk_io_hygiene`, `session_reaper`,
`one_classify_kind`). None of them interact with these — indexes, auth sessions and
containers respectively — but applying under a colliding number would have left the ledger
permanently ambiguous about which 037 the database has.

### A live footgun on `main`, not from this branch

The ledger records `one_classify_kind` as version **`20260827043953`**, while the repo file
is **`039_one_classify_kind.sql`**. That is exactly the drift CLAUDE.md warns about: the next
`pnpm db:push` sees no ledger row for `039` and replays it.

**Re-read of 039 (2026-08-30): the replay is safe.** The file contains no DDL at all — no
`create table`, no `alter table`, and no `*_pre039_backup` tables (an earlier note here said
it wrote those; it does not). It is entirely `do $$` blocks over already-folded data, and
every write is guarded: the group→project insert is `where not exists … on conflict (id) do
nothing`, and the `items` updates match only rows still carrying a `group_id`. On a database
where 039 has already run there is nothing left for it to move, so a replay is a true no-op
rather than a probable one.

So this is untidiness, not a hazard: the ledger is ambiguous about which migration the
database has, which costs the next person time. The fix is one row — record it under `039`,
or drop the timestamped entry. Still Kirby's call, since it is main's migration, but it no
longer needs to happen before the next push.

## Not decisions — things to verify

Full detail in [ai-vision.md](ai-vision.md#unverified-assumptions-test-these-first-with-a-real-gateway).

1. ~~**Apply migration 040**~~ — done 2026-08-27, along with 041 and 042. See above.
2. **Enable `gateway.http.endpoints.chatCompletions.enabled: true`** on the gateway, then put
   its URL and token into Settings → Beacon (both rows are behind Advanced).
   → tracked as **issue #260**.
3. **Test session memory**, not duplication: say "my favourite colour is green", then ask
   what it is. Remembering means the gateway is session-stateful and the default is right;
   forgetting means it is stateless per request — flip `SEND_FULL_TRANSCRIPT_TO_GATEWAY` in
   `lib/openclaw-gateway.ts`. → part of **issue #260**.
4. **Reachability from Vercel.** dsul calls the gateway server-side, so browser CORS is
   irrelevant — but a tailnet-only gateway is not reachable from Vercel. Local dev works;
   production likely needs Funnel or equivalent. Still the most likely thing to be wrong.
5. **Point a real MCP client at `/api/mcp`** (**issue #261**; the scheduled pull loop that
   consumes it is **issue #262**). Nothing has spoken to it yet — the protocol is
   pinned by tests, not by a handshake. OpenClaw takes remote Streamable HTTP servers with
   custom headers, which is exactly the shape this server needs:

   ```bash
   openclaw mcp add dsul \
     --url https://<dsul-host>/api/mcp \
     --transport streamable-http
   # then add the header through the scoped config editor or config:
   #   mcp.servers.dsul.headers.Authorization = "Bearer dsul_<key>"
   #   (keep the key out of config literals — use the secret mechanism)
   openclaw mcp doctor dsul --probe
   ```

   `doctor --probe` is the real proof: the docs are explicit that saving a definition proves
   nothing about reachability. A successful probe listing **fifteen** `dsul_*` tools is the
   first time this code has spoken to a client (eleven predates the delegation tools). `--include` can narrow the tool set if you
   want the agent to see only reads at first.
