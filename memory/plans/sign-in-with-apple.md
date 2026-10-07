# Sign in with Apple

Apple joins Google and the email link as a way into dsul. This doc holds what shipped, the
one-time setup in Apple's and Supabase's dashboards, and the six-monthly secret rotation.

## What ships

- **Web.** "Continue with Apple" sits under "Continue with Google" on /login, its twin in style
  (Apple asks that it be no less prominent than any other sign-in). It shows only while Supabase
  reports the provider enabled: `lib/sign-in-providers.ts` reads GoTrue's public
  `GET /auth/v1/settings` (`external.apple`) on the server, keeps the answer five minutes per
  instance, and fails closed. So the button could merge ahead of the setup below, and it appears
  by itself within five minutes of the provider being switched on (and goes if it is switched
  off). The flow is Google's: Supabase's callback, then /auth/callback.
- **Desktop.** The shell's `checkAuthorizeUrl` accepts `provider=apple`
  (`policy.OAUTH_PROVIDERS`), and the preload advertises the list to the page as
  `authProviders`. A shell built before that has no list, would refuse the URL, and so gets no
  Apple button. Apple reaches desktop users with the next shell release. Its pending window is
  Google's (kind `oauth`, 10 minutes).
- **iPhone.** Not yet. It wants the native button (AuthenticationServices) and
  `signInWithIdToken`, and App Store guideline 4.8 will ask for it, because the app offers Google.
  The setup below already lists the app's bundle ID as a Client ID, so the native flow needs no
  Supabase change. App Store review also wants in-app account deletion, and for an Apple account
  that means revoking its token with Apple (memory/plans/ios-app.md).

## The identifiers

| What | Value |
|---|---|
| App ID (primary) | `app.dsul.ios` |
| Services ID (the web client_id) | `app.dsul.web` |
| Domain | `ctcspcferkdlzdcqlozq.supabase.co` |
| Return URL | `https://ctcspcferkdlzdcqlozq.supabase.co/auth/v1/callback` |
| Supabase Client IDs | `app.dsul.web,app.dsul.ios` |

## Setup (Kirby, once)

This needs a paid Apple Developer Program membership. Everything happens in Certificates,
Identifiers & Profiles at developer.apple.com/account, then in Supabase.

1. **Team ID.** Membership details shows it (ten characters). Note it.
2. **App ID.** Identifiers → `+` → App IDs → App. Bundle ID: Explicit, `app.dsul.ios`. Under
   Capabilities, tick **Sign In with Apple**. Register. If the App ID already exists, open it,
   tick the capability, and save.
3. **Services ID.** Identifiers → `+` → Services IDs. Description `dsul web sign-in`, identifier
   `app.dsul.web`. Register, then open it, tick **Sign In with Apple**, and Configure:
   - Primary App ID: `app.dsul.ios`
   - Domains and Subdomains: `ctcspcferkdlzdcqlozq.supabase.co`
   - Return URLs: `https://ctcspcferkdlzdcqlozq.supabase.co/auth/v1/callback`

   Next, Done, Continue, Save.
4. **Key.** Keys → `+`. Name it `dsul Sign in with Apple`, tick **Sign In with Apple**, Configure
   it with the primary App ID `app.dsul.ios`, Save, Continue, Register. **Download the .p8 now:
   Apple offers it once.** Note the Key ID. Keep the .p8 in a password manager, since the
   rotation below needs it again; never put it in the repo.
5. **Client secret.** From the repo:

   ```bash
   node scripts/apple-client-secret.mjs --team <Team ID> --key-id <Key ID> \
     --client-id app.dsul.web --p8 ~/Downloads/AuthKey_<Key ID>.p8
   ```

   It prints the secret, and the date it expires (180 days out). Put a reminder a week before
   that date.
6. **Supabase.** Dashboard → Authentication → Sign In / Providers → Apple. Enable it.
   - Client IDs: `app.dsul.web,app.dsul.ios`
   - Secret Key (for OAuth): the secret from step 5

   Save. URL Configuration needs nothing new: the Redirect URLs already include
   `https://do.dsul.app/**` (desktop-app.md, "Step 0").
7. **Check.** In a private window, open do.dsul.app/login. Within five minutes "Continue with
   Apple" appears. Sign in once with "Share My Email" (an email that already has a dsul account
   lands in that account) and once with "Hide My Email" (a new, separate account; see below).

## Rotation (every six months)

Apple's client secret lives at most six months, and when it lapses Apple sign-in fails while
Google and email carry on. Before the date step 5 printed, rerun step 5 with the same .p8 and
paste the new secret into Supabase (step 6). Nothing else changes, and nobody is signed out.

## How it behaves

- **Hide My Email makes a second account.** Apple hands over a relay address, and Supabase links
  identities only by a matching verified email. Someone who already uses dsul through Google or
  the email link and picks Hide My Email starts an empty account. Sharing the real email avoids
  it.
- **No name.** Apple gives the name only on the first consent, and the web flow doesn't pass it
  on, so an Apple account's display name is empty and the app shows the email instead
  (`lib/session-user-store.ts`).
- **Email to a relay address.** Apple forwards mail to a Hide My Email address only from domains
  registered under Services → Sign in with Apple for Email Communication. An email link sent to a
  relay address goes nowhere until the auth mail's sending domain is registered there. Optional,
  and only matters if those users ever ask for an email link.
- **Turning it off** in Supabase removes the button within five minutes. Existing Apple accounts
  keep their data and can come back by email if they shared their real address.
