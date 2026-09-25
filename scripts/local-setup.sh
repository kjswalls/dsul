#!/usr/bin/env bash
#
# local-setup.sh — point `pnpm dev` and/or the e2e suite at a LOCAL Supabase.
#
# WHY THIS EXISTS. `vercel env pull .env.local` writes PRODUCTION credentials,
# so a plain `pnpm dev` talks to the production project. Measured on 2026-09-18:
# of ~5,900 API requests in a ten-minute window, 5,917 came from
# `http://localhost:3000/` and TWO came from the deployed app. Every hot-reload
# remount re-runs the planner's full container fan-out and its getUser() calls,
# against prod.
#
# That is the same problem scripts/README.md already documents for the e2e suite
# — which this script grew out of (it was e2e-local-setup.sh) — just from a
# different source. Both now share one stack and one code path.
#
# WHAT IT DOES
#   1. Starts a local Supabase stack (running `supabase init` first if needed).
#   2. Applies every migration in supabase/migrations to a clean LOCAL database.
#   3. Creates the relevant user(s), email pre-confirmed so no mail is needed.
#   4. Writes .env.local and/or .env.test (both gitignored).
#
# USAGE
#   ./scripts/local-setup.sh dev            # .env.local, for `pnpm dev`
#   ./scripts/local-setup.sh e2e            # .env.test,  for `pnpm e2e`
#   ./scripts/local-setup.sh e2e --smoke    # …and run the smoke spec
#   ./scripts/local-setup.sh both           # one stack, both files
#
# .env.local IS MERGED, NOT OVERWRITTEN. It also carries OPENAI_API_KEY, the
# VAPID pair, CRON_SECRET and KIRBY_USER_ID — clobbering it would break the app
# in ways that look nothing like "wrong database". Only the three Supabase keys
# are swapped; every other line is carried through untouched, and the original
# is backed up first.
#
# TO GO BACK TO PRODUCTION:  vercel env pull .env.local
#
# ONLY EVER TOUCHES THE LOCAL STACK. `supabase db reset` without `--linked`
# targets the local database; nothing here can reach the hosted project.
#
# Re-runnable: every run resets the local DB and reseeds the users, so it always
# lands in a known-good state.
#
# PREREQS: Docker running, and the Supabase CLI (`supabase`) installed.
# Stop the stack (and free the RAM) when you're done:  supabase stop
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

TARGET="${1:-}"
case "$TARGET" in
  dev|e2e|both) ;;
  *)
    echo "usage: $0 <dev|e2e|both> [--smoke]" >&2
    exit 2
    ;;
esac
SMOKE="${2:-}"

# The dedicated e2e user. The email MUST contain e2e/test/playwright — that is
# what unlocks the litter-sweep guard in tests/e2e/global-setup.ts.
TEST_USER_EMAIL="${TEST_USER_EMAIL:-e2e@dsul.test}"
TEST_USER_PASSWORD="${TEST_USER_PASSWORD:-e2e-local-password}"

# A separate account to actually log in as during `pnpm dev`, so development
# never shares the e2e user's state (the sweep deletes that account's rows).
DEV_USER_EMAIL="${DEV_USER_EMAIL:-dev@dsul.test}"
DEV_USER_PASSWORD="${DEV_USER_PASSWORD:-dev-local-password}"

# Services to skip. e2e needs only Postgres + kong + gotrue + postgrest +
# storage, and excluding the rest roughly halves the stack's RAM. Dev keeps
# Studio, which is most of the reason to have a local stack at all.
# NOTE: changing this set needs a `supabase stop` first — `supabase start` will
# not reconfigure a stack that is already up.
if [ "$TARGET" = "e2e" ]; then
  EXCLUDE="studio,imgproxy,edge-runtime,logflare,vector,mailpit,supavisor,realtime"
else
  EXCLUDE="imgproxy,edge-runtime,logflare,vector,supavisor"
fi

command -v supabase >/dev/null || {
  echo "❌ Supabase CLI not found — install it: https://supabase.com/docs/guides/cli"; exit 1;
}
docker info >/dev/null 2>&1 || {
  echo "❌ Docker isn't running. Start Docker Desktop and re-run."; exit 1;
}

# supabase/config.toml is not in the repo (only migrations/ and schema.sql are),
# so a fresh clone has nothing for `supabase start` to read. Generating it is
# safe and idempotent — it is per-machine local stack config, not schema.
if [ ! -f supabase/config.toml ]; then
  echo "▶ No supabase/config.toml — running supabase init …"
  supabase init
fi

echo "▶ Starting local Supabase (-x $EXCLUDE) …"
supabase start -x "$EXCLUDE"

echo "▶ Applying all migrations to a clean LOCAL database (supabase db reset) …"
supabase db reset

# Read the local URL + keys straight from the running stack — never hardcoded,
# so config.toml overrides carry through. The key NAMES are CLI-version
# dependent; CI pins the CLI (.github/workflows/test.yml).
eval "$(supabase status -o env)"
: "${API_URL:?supabase status did not report API_URL — is the stack up?}"
: "${ANON_KEY:?supabase status did not report ANON_KEY}"
: "${SERVICE_ROLE_KEY:?supabase status did not report SERVICE_ROLE_KEY}"

# Create a pre-confirmed user via the admin API. 422 means it survived the reset
# (or was created by an earlier run in the same stack) — reuse it rather than
# failing the whole setup.
create_user() {
  local email="$1" password="$2" status
  status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_URL}/auth/v1/admin/users" \
    -H "apikey: ${SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${email}\",\"password\":\"${password}\",\"email_confirm\":true}")"
  case "$status" in
    2??) echo "  created $email" ;;
    422) echo "  $email already exists — reusing." ;;
    *)   echo "❌ user creation failed for $email (HTTP $status)"; exit 1 ;;
  esac
}

# Swap only the Supabase keys in an existing env file, preserving every other
# line. Anchored to line starts so a substring match (e.g. a commented-out copy)
# cannot silently drop an unrelated variable.
strip_supabase_keys() {
  grep -Ev '^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SECRET_KEY)=' "$1" || true
}

if [ "$TARGET" = "dev" ] || [ "$TARGET" = "both" ]; then
  echo "▶ Creating the dev user ($DEV_USER_EMAIL) …"
  create_user "$DEV_USER_EMAIL" "$DEV_USER_PASSWORD"

  echo "▶ Writing .env.local (gitignored) …"
  CARRIED=""
  if [ -f .env.local ]; then
    cp .env.local .env.local.bak
    echo "  backed up existing .env.local → .env.local.bak"
    CARRIED="$(strip_supabase_keys .env.local)"
  fi
  {
    echo "# Supabase keys below point at your LOCAL stack, written by"
    echo "# scripts/local-setup.sh. Everything else is carried over from the"
    echo "# previous .env.local. To go back to production: vercel env pull .env.local"
    echo "NEXT_PUBLIC_SUPABASE_URL=${API_URL}"
    echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}"
    echo "SUPABASE_SECRET_KEY=${SERVICE_ROLE_KEY}"
    if [ -n "$CARRIED" ]; then
      echo
      echo "# ── carried over from the previous .env.local ──"
      echo "$CARRIED"
    fi
  } > .env.local
fi

if [ "$TARGET" = "e2e" ] || [ "$TARGET" = "both" ]; then
  echo "▶ Creating the Playwright test user ($TEST_USER_EMAIL) …"
  create_user "$TEST_USER_EMAIL" "$TEST_USER_PASSWORD"

  echo "▶ Writing .env.test (gitignored) …"
  if [ -f .env.test ]; then
    cp .env.test .env.test.bak
    echo "  backed up existing .env.test → .env.test.bak"
  fi
  cat > .env.test <<EOF
# Generated by scripts/local-setup.sh — points the e2e suite at your LOCAL
# Supabase stack. Gitignored. Re-run the script to regenerate.
NEXT_PUBLIC_SUPABASE_URL=${API_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_SECRET_KEY=${SERVICE_ROLE_KEY}
TEST_USER_EMAIL=${TEST_USER_EMAIL}
TEST_USER_PASSWORD=${TEST_USER_PASSWORD}
EOF
fi

echo "✅ Local environment ready ($TARGET)."
# if/fi rather than `[ … ] && echo …`: under `set -e` a false test makes the
# whole line return non-zero, which would exit the script before the rest of
# these instructions printed.
if [ "$TARGET" != "e2e" ]; then
  echo "   Dev:    pnpm dev   → log in as $DEV_USER_EMAIL / $DEV_USER_PASSWORD"
fi
if [ "$TARGET" != "dev" ]; then
  echo "   E2E:    pnpm e2e"
fi
echo "   Studio: see \`supabase status\` (excluded entirely on the e2e target)"
echo "   Stop:   supabase stop"
echo "   Back to prod: vercel env pull .env.local"

if [ "$SMOKE" = "--smoke" ]; then
  echo "▶ Running the smoke spec …"
  pnpm exec playwright test tests/e2e/smoke.spec.ts
fi
