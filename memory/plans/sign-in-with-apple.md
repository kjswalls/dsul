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
- **iPhone.** "Continue with Apple" (Apple's own `SignInWithAppleButton`) sits under Google,
  black or white with the appearance and as tall as Google's button. Apple's sheet asks for
  name and email with the SHA-256 of a fresh nonce, and the app hands the identity token and the
  raw nonce to GoTrue's id_token grant
  (`POST /auth/v1/token?grant_type=id_token`, `provider: apple`), which checks the token against
  Apple's keys, the audience against the Client IDs above (the app's bundle ID is one), and the
  nonce. So the phone needs no Supabase change and no client secret. The button is always shown:
  if the provider is off, a tap ends with "Sign in with Apple isn't available right now". On a
  first consent the phone writes Apple's name to the account (`full_name` and `name`) when it
  has none. The app asks Apple about the session's Apple ID at launch, on return and when Apple
  says it was revoked, and signs this phone out if it was revoked or the phone's Apple Account
  changed. App Store review also wants in-app account deletion, and for an Apple account that
  means revoking its token with Apple; that is the next iPhone PR (memory/plans/ios-app.md,
  "Sign in with Apple").

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
   lands in that account). Hide My Email makes a new, separate account only for an Apple Account
   that has never signed in to dsul, so try it with a second Apple Account if you have one (see
   below). On the iPhone, ios/README.md "Checking Sign in with Apple".

## Rotation (every six months)

Apple's client secret lives at most six months, and when it lapses Apple sign-in fails while
Google and email carry on. The iPhone's sign-in needs no client secret (GoTrue checks its token
against Apple's public keys), so it carries on. Before the date step 5 printed, rerun step 5 with
the same .p8 and paste the new secret into Supabase (step 6). Nothing else changes, and nobody is
signed out.

## How it behaves

- **Hide My Email makes a second account, the first time.** Supabase finds the account for an
  Apple sign-in by its Apple ID first, then by a matching verified email. So the first time an
  Apple Account signs in to dsul, on the web or the iPhone, Hide My Email hands over a relay
  address that matches nobody and starts an empty account, and Share My Email with the address
  an account already uses lands in that account. After that, the same Apple Account always
  opens the same account, whatever it shares. Someone who already uses dsul through Google or
  the email link should share their real email the first time.
- **The name.** Apple gives it only on the first consent, and only to the client that asked.
  GoTrue's web callback reads the name Apple posts and stores it (`external_oauth.go`, the
  Apple provider's `ParseUser`), so an account made on the web should get one; this was assumed
  not to happen and hasn't been checked on prod. The iPhone writes the name itself when the
  account has none. Either way the web shows the name, else the email
  (`lib/session-user-store.ts`). An account linked to Google keeps Google's name.
- **Email to a relay address.** Apple forwards mail to a Hide My Email address only from domains
  registered under Services → Sign in with Apple for Email Communication. An email link sent to a
  relay address goes nowhere until the auth mail's sending domain is registered there. Optional,
  and only matters if those users ever ask for an email link.
- **Turning it off** in Supabase removes the button within five minutes. Existing Apple accounts
  keep their data and can come back by email if they shared their real address. The iPhone keeps
  its button and says Sign in with Apple isn't available.
