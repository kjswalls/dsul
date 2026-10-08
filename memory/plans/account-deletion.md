# Account deletion

Delete account, on the iPhone and the web: App Store guideline 5.1.1(v) asks for it in the app,
and the HIG asks for the same on the website. This doc holds what shipped, the one rule that
makes it work, and what it can't reach. Kirby's setup is under "Setup"; the device checks are
ios/README.md, "Checking account deletion".

## What ships

- **iPhone.** The avatar menu on Today (the email and Sign out) has **Delete account…** under
  Sign out, only when signed in. Its sheet names the account by its email, says what goes, that
  it cannot be undone and is not the Trash, lists what dsul can't delete for the person, and asks
  them to type DELETE (any case). For an account that signs in with Apple, and a phone whose
  Apple Account can authorize that Apple ID, Apple's sheet then asks to continue (Face ID), and
  the server revokes dsul's Sign in with Apple tokens. The account is deleted at once; the phone
  lands on the sign-in screen with "Your dsul account is deleted.", which VoiceOver reads.
- **Web, and the desktop app**, which loads it. Settings → dsul has **Delete account** under Sign
  out, with the same words, the same typed DELETE and the same immediate deletion. The web never
  revokes Sign in with Apple (it has no fresh code from Apple); it tells an Apple account how to
  remove dsul there. /login then shows the done line too.
- **Four routes, one core.** `GET /api/app/account` and `POST /api/app/account/delete` (the
  phone, bearer token, lib/app-auth.ts), `GET /api/account` and `POST /api/account/delete` (the
  web, cookie session, same origin). The GETs answer the facts the confirmation shows; the POSTs
  delete. Both POSTs call `deleteAccount` in lib/account-server/delete.ts. There is no agent, MCP,
  OpenClaw, cron or service-role path: a delegated key must never be able to delete the person.

## The rule: one call, and the foreign keys do the rest

The server calls GoTrue's admin delete once (`auth.admin.deleteUser`, never soft: a soft delete
keeps the row, which App Review calls deactivation). Every table that holds a user's data
references `auth.users` ON DELETE CASCADE, directly or through a composite key to a table that
does, so Postgres deletes every row inside GoTrue's one transaction: the account and all of it,
or nothing. No code lists tables, because a list drifts from the schema.

`tests/unit/account-deletion-migration.test.ts` holds that for every future table, reading the
migrations as text:

1. Every key to `auth.users` cascades, and every key between public tables cascades or sets null.
2. Every user column (`user_id`, `*_user_id`, `owner*`) has a cascading path to `auth.users`: its
   own key, or a composite key to a table that has one, listed with its reason (today only
   `chat_messages.user_id`, through its conversation). A column with no key at all would keep its
   rows after a deletion, and a service-role write already in flight (the reminder scan, the
   agent API) could add new ones, since only a foreign key refuses a row whose user is gone. The
   planned `devices` table (reminders-platforms.md) must cascade.

**Migration 063** fixed the two keys that broke the rule: `bug_reports.supabase_user_id` was SET
NULL (a deleted account left its email behind; 063 also deletes the rows earlier deletions left),
and `tasks.parent_task_id` had no action (a forged task of one account pointing at another's
would have failed that other account's deletion: a foreign key check skips RLS). Both are found
by column, so a database whose constraints were named differently is fixed too.
`scripts/verify-063.sh` replays the migrations onto a bare Postgres, seeds three users in all 28
user tables, and deletes them before and after 063. Deletion works before 063 is applied; a
deleted account then leaves its `bug_reports` email row until 063 deletes it.

The stake ledger and the saved conversations go with the account. "A ledger the subject can edit
is not a ledger" is about editing it while the account lives; the confirmation says to note what
is owed first when there is a ledger.

## Always the account on screen, and "gone"

- **The account deleted is always the verified caller's.** No route takes a target; the bodies
  are strict (`{"account","confirm"}`, plus `appleCode` on the phone) and refuse any other key.
  `confirm` is the constant `DELETE`: it stops a stray call, it doesn't prove a person typed it.
- **And only while it is the account the confirmation opened for.** `account` is the `userId`
  the facts route answered when the sheet or dialog opened. A guard, never a target: the server
  answers 409 `changed` and deletes nothing when the caller is someone else by now. On the web a
  browser can switch accounts under an open tab (an email link for another account opened in a
  second tab), and the dialog's state survives it: the settings page mounts the dialog outside
  its hydration gate, so the skeleton the switch brings never unmounts it and it never reopens by
  itself for the new account.
- **Gone.** A deleted user's access token stays well formed until it expires, and GoTrue answers
  it with `user_not_found` only after the signature checks out. `authenticateAppCaller`
  (lib/app-auth.ts) and `accountSession` (app/api/account/_shared/session.ts) hand that back as
  `{ gone: true, userId }`, the token's own `sub`, and only the account routes use it: a delete
  retried after its answer was lost is 200 `{"deleted":true,"apple":"unknown"}` (nothing left to
  delete), and a facts read is 410 `gone`, so the client says the account is deleted rather than
  that it was signed out. Every other `/api/app` route still answers gone with 401.
- **A delete that didn't answer success is asked about, not trusted.** A gateway's 500 or a lost
  answer can follow a transaction GoTrue committed, so the server reads the user once more: gone
  is deleted (200), still there is 500 `failed` ("Nothing was deleted"), a read that fails too is
  503 (a retry settles it).

## Sign in with Apple: exchange, delete, then revoke

On the phone, Apple's sheet (no scopes, `user` set to the account's Apple ID, no nonce) gives a
single-use authorization code, good for five minutes. The server, after checking the caller, the
body and the guard:

1. reads the user's Apple ids;
2. exchanges the code at `https://appleid.apple.com/auth/token` (`client_id` `app.dsul.ios`, the
   bundle ID a native code is issued to; no `redirect_uri`), and keeps the tokens only if the ID
   token's `sub` is one of the account's Apple ids (its claims are read without a signature
   check: it came straight from Apple over TLS, OIDC Core §3.1.3.7);
3. deletes the account;
4. only then revokes the refresh token (or the access token) at `/auth/revoke`.

Delete first, because revoking and then failing to delete would leave an account Apple has
already cut off, with the person told nothing was deleted. Nothing Apple does can stop or undo a
deletion (TN3194 sanctions deleting without revoking): every Apple failure is one log line and
`apple: "not_revoked"`, and the person is told how to remove dsul from Sign in with Apple
themselves. Each Apple call has a 5 s timeout.

**The server mints its own client secret** per request, five minutes long, from the Sign in with
Apple key: the same header and claims as `scripts/apple-client-secret.mjs` but `exp`. Nothing to
paste, and nothing that lapses in six months and silently stops revocation. It needs four
variables (sign-in-with-apple.md, setup step 8): `APPLE_TEAM_ID`, `APPLE_KEY_ID`,
`APPLE_PRIVATE_KEY` (the .p8's text, Sensitive) and `APPLE_IOS_CLIENT_ID` (`app.dsul.ios`).
Without them, or with a key that isn't an EC P-256 key, `appleRevocable` is false: the phone runs
no Apple sheet, an Apple account sees the manual line, a code that arrives anyway is ignored, and
the server logs `apple_not_configured` or `apple_key_unreadable` once per instance. Deletion
itself works either way.

## The phone, and the web

**The phone.** The sheet asks `GET /api/app/account` when it opens. If the account has Apple ids
and the server can revoke, AuthStore asks Apple's local credential state for each and keeps the
first `.authorized` one; the sheet then says Apple will ask to continue, and asks again just
before Apple's request (a retry may follow a deletion that already revoked it). A cancel on
Apple's sheet sends nothing; any other Apple failure deletes without a code. On a 200 AuthStore
ends the session the way a sign-out does, with no logout call (the user and its sessions are
already gone), and the sign-in screen shows the done line. A 410 from the facts route (a sheet
reopened after a lost answer) ends the session the same way. Other iPhones get 401, their refresh
is refused, and they sign out with the usual line.

**The web.** The dialog (Settings → dsul) asks `GET /api/account` on open and sends
`POST /api/account/delete`. On a 200 it first records the outcome in sessionStorage for /login,
then shows the done line and Done; Done (or closing) signs out locally, and the provider's
SIGNED_OUT handler replaces the page with /login, which shows the line once. The sessionStorage
entry is what keeps the outcome when another tab's refused refresh replaces the page first.

## What stays outside the database

| Where | What stays | What dsul does |
|---|---|---|
| Supabase Auth audit log (`auth.audit_log_entries`) | every sign-in, refresh and sign-out entry, and the deletion's own, with the email and IP addresses | Leaves it (Supabase's own table; deleting from it would need a security definer function) |
| Supabase and GoTrue logs | each audit entry's stdout copy, with IP and user agent; the admin call's user id | Nothing: the platform's retention |
| Supabase backups | the deleted rows, until backups age out | Nothing: the provider's schedule |
| Vercel logs | earlier route logs; the reminder scan's per-user failure notes, which carry the user id | The account routes log codes only: never an id, email, Apple code, token or secret |
| pg_net's response table (`net._http_response`) | the reminder tick's responses, whose notes carry the user id | Nothing: pg_net drops them after six hours |
| GitHub issues from Send feedback | the title and text, with no account named | The `bug_reports` row linking it to the account goes (063) |
| Beeminder | datapoints already posted; goals that expect dsul's ticks can derail and charge; the auth token the person pasted, still valid there | A line when Beeminder is on; Beeminder named in the keys line |
| Pledge | nothing outside dsul: the ledger was the only record of what each miss cost | A line when there is a ledger |
| Twilio, Home Assistant | messages and calls already made; the tokens, still valid there | dsul's copies go; named in the keys line |
| Slack, Discord, an accountability partner | messages already sent | Nothing: webhook URLs are config, not credentials |
| OpenClaw | its own memory; the gateway and hooks tokens, still valid at the gateway | Its agent key goes (401 from then on); a line when connected; named in the keys line |
| The model provider | the key the person pasted, still valid there | The sealed copy goes; a line naming the provider, as Disconnect does |
| Google | dsul in the Google Account's connected apps | Nothing: dsul keeps no Google token |
| Apple | dsul under Sign in with Apple | Revoked from the iPhone; a line otherwise |
| Vercel Analytics | page views, with no account id | Nothing |

The keys line names a service only from what `user_secrets` holds, mapped to names on the server;
no value ever leaves `readAccountFacts`. Every read in the facts route but the user's is
advisory: one that fails drops its line, so a lost line never keeps anyone from deleting.

## Setup (Kirby)

1. Optional, read-only, before 063, in the Supabase SQL editor on prod:

   ```sql
   select conrelid::regclass as tbl, conname, confdeltype
     from pg_constraint
    where contype = 'f' and connamespace = 'public'::regnamespace
      and (confrelid = 'auth.users'::regclass and confdeltype <> 'c'
           or confdeltype in ('a', 'r'));
   select count(*) from public.bug_reports where supabase_user_id is null and user_email is not null;
   ```

   Expected: `bug_reports_supabase_user_id_fkey` (`n`) and `tasks_parent_task_id_fkey` (`a`), and
   the number of email rows 063 will delete. Anything else listed is a key the tree doesn't know;
   say so in the thread before applying 063.

   Then the user-column query (the one `scripts/verify-063.sh` runs as `USER_COLUMNS`). It lists a
   table with a user column and no key at all, which the first query can't show, since it lists
   keys:

   ```sql
   select c.relname as tbl, a.attname as col
     from pg_class c
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and (a.attname = 'user_id' or a.attname like '%\_user\_id' or a.attname like 'owner%')
      and not exists (
        select 1 from pg_constraint k
         where k.conrelid = c.oid and k.contype = 'f' and k.confdeltype = 'c'
           and a.attnum = any (k.conkey)
           and (k.confrelid = 'auth.users'::regclass
                or exists (select 1 from pg_constraint k2
                            where k2.conrelid = k.confrelid and k2.contype = 'f'
                              and k2.confdeltype = 'c' and k2.confrelid = 'auth.users'::regclass)));
   ```

   Expected: one row, `bug_reports | supabase_user_id` (063 fixes it). Anything else is a table
   made outside the migrations; say so in the thread before applying 063.
2. Vercel, Production only (Preview shares the production database, so a preview's delete
   deletes a real account): the four `APPLE_*` variables (sign-in-with-apple.md, step 8).
   Redeploy.
3. 063, with a typed go: `pnpm db:list` shows the remote at 062, then `pnpm db:push`. If the
   remote is behind 062, stop and say so: `db push` would apply those too.
4. The device checks, ios/README.md "Checking account deletion", with throwaway accounts only.
5. **App Review, only after revocation is proven on prod.** Submit the iPhone build only once
   step 2 is deployed and an Apple deletion has answered `revoked`: README check 6 showed dsul
   gone from Sign in with Apple, or Vercel's logs show `[account] deleted revoked`. Reviewers sign
   up with Apple, and the guideline's FAQ says such apps "should use the Sign in with Apple REST
   API to revoke user tokens"; a build reviewed before step 2 shows the manual line instead.
   The review notes to paste into App Store Connect are in ios-app.md, "App Review waits for
   revocation on prod".

## Not yet

- A grace period or scheduled deletion: deletion is immediate, as the HIG allows. A grace period
  is a "pending deletion" state every path would have to respect, a job and a cancel path.
- Data export.
- Apple's server-to-server notifications (`consent-revoked`, `account-deleted`). The phone already
  signs out on a revoked Apple ID.
- Revoking Sign in with Apple from the web: it needs Apple's JS sheet for `app.dsul.web`.
- Deleting the account's rows in Supabase's auth audit log.
- An e2e test, until the E2E rework (#414) lands; the routes and the dialog have unit tests.
- **Apple's refresh token stored at sign-in** (TN3194's way, open question 9). Today the phone
  asks Apple for a fresh code at deletion, which works for every existing account but can be
  throttled ("Verifying a user" warns against asking more than once a day, and App Review deletes
  minutes after signing up). A throttled request deletes without revoking and shows the manual
  line. The server never sees why: the phone sends no code, so Vercel's logs show
  `[account] deleted not_revoked` with no `[account] apple` line, the same as any other failure of
  Apple's sheet on the phone. If README check 6 or the logs show that, the fix is to exchange the
  code at every Apple sign-in and keep the refresh token server-side (a `user_secrets` column), so
  deletion revokes with no second Apple request, from the web too.
- **The avatar menu's "Drag spike" section** sits right under Delete account… and is a debug
  control in front of App Review (open question 10). Before the first App Store build, a
  `#if DEBUG` around it, which also hides it from TestFlight builds.
