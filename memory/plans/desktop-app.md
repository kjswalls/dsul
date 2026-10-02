# Desktop app: an Electron shell over do.dsul.app

> Status (2026-10-01): v1 is built. The web fix (`safeNext`, `auth-redirect`) merged as #352; the shell, the sign-in handoff, quick capture, the tray, the release workflow and the update notice landed together after it. Nothing has run on a real Mac or Windows machine yet, and no release has been cut: see "Kirby's checklist". The plan was revised after two reviews before the build (see "Review notes"), and the build itself after a third. Read it before touching `electron/`, `app/auth/desktop/`, the login page's desktop branch, or anything that reads `window.dsulDesktop`. Every item marked **[unverified]** appears again under "Open assumptions". Library line numbers refer to the package versions named next to them, unpacked with `npm pack`.

## Decision

dsul gets an Electron app for macOS and Windows. Its one window loads the **live** https://do.dsul.app, the same model as Claude's and Linear's desktop apps. It is not a static export, and it is not Tauri.

- **Why not a bundled build.** The client needs the site's route handlers: the code exchange (app/auth/callback/route.ts:4-19), the auth gate and canonical-host redirects (proxy.ts:13-16, :57-62), and every `app/api/*` route. Loading the live origin also means:
  - web fixes reach the desktop app through Vercel, with no desktop release;
  - "Copy link" stays shareable, because it is built from `window.location.origin` (components/planner/item-context-menu.tsx:336, container-context-menu.tsx:141).

  Never load the app from `file://` or from a custom scheme.
- **Why not Tauri.** This was settled before the research. Tauri draws in the OS webview (WKWebView on macOS) instead of the Chromium the app is measured against, and it would add a Rust toolchain to a JS repo. **[unverified: these are the recorded reasons, not re-checked]**
- **Browser users see no change.** Every web addition checks for `window.dsulDesktop`, which only the shell's preload sets. Never sniff the user agent: the app reads none, and it picks mobile by width (hooks/use-mobile.ts:3-14). Two web changes are not gated, and both only fix where a sign-in lands:
  - the `next` open-redirect fix;
  - sending every login through `/auth/callback` (see "Web files").

## Where the code lives

The shell lives in `electron/` at the repo root, as a standalone **npm** project. It is not called `desktop/`, because that word already names the web app's wide layout (components/shell/desktop-shell.tsx).

```
electron/
  package.json, package-lock.json   # private; electron ^44 (44.5.1), electron-builder 26.15.x; committed lock
  electron-builder.config.cjs       # JS, not yml: signing identity depends on env (see Packaging)
  main.cjs                          # lifecycle, window, guards, menu, tray, shortcut, deep links
  preload.cjs                       # contextBridge -> window.dsulDesktop (sandboxed preload, so CJS)
  lib/policy.cjs                    # PURE, zero imports: isAppUrl, carriesAuthCode, externalAllowed,
                                    #   parseDeepLink, checkAuthorizeUrl
  lib/app-icon.cjs                  # PURE: the run-time icon's looks and file names
  offline.html, README.md ("npm only. Never run pnpm in here."), .gitignore (node_modules/, release/)
  build/                            # icon.png, app-icon-{aurora,lime}.png, tray icons,
                                    #   entitlements.mac.plist, installer.nsh
```

- **It is not a workspace project.** pnpm-workspace.yaml:1-3 lists only `packages/*` and `openclaw-plugin`. So the root `pnpm install` (Vercel; test.yml:44) never pulls in electron-builder's ~200MB app-builder-bin.
  - Never add electron to the root dependencies.
  - Never run `pnpm install` inside `electron/`. In a subfolder the workspace doesn't list, it silently installs the ROOT workspace instead.
  - `--ignore-workspace` avoids that, but it writes a lockfile that the `**/pnpm-lock.yaml` cache key would then hash (test.yml:39).
- **Lint.** Add `'electron/**'` to `globalIgnores` (eslint.config.mjs:6-15), after `openclaw-plugin/**` at :11.
- **Typecheck.** `.cjs` files stay outside tsconfig's include list (tsconfig.json:31-37).
- **Vitest.** It collects only `tests/unit/**` (vitest.config.ts:10). The policy test is the one deliberate reach into `electron/`.
- **CI.** Do NOT add `electron/**` to test.yml's paths-ignore (:3-13). The required **Unit tests (Vitest)** check has to report on shell-only PRs, or `--auto` merges stall (CLAUDE.md "Git workflow").
  - Never add a root `dist/` or `release/` ignore rule. It would hide `packages/types/dist` from the drift check.
- **Vercel.** Every merge to main redeploys production, shell-only merges included, because vercel.json is `{}`. Each build ships a new service worker, which `skipWaiting`/`clientsClaim` push onto every open tab and desktop window (next.config.mjs:43-47, app/sw.ts:16-17).
  - Docs-only merges already do this today.
  - No `ignoreCommand` in v1. If one is added later, test it against a web-only commit first, because a wrong one skips real deploys.
- **CLAUDE.md** gets one Layout line: "`electron/` is the Electron shell (npm); `components/shell/desktop-shell.tsx` is the web layout."

## Window, navigation and hardening (main.cjs)

- **Origin.** `APP_ORIGIN = 'https://do.dsul.app'`.
  - `isAppUrl(u)` checks `u.protocol === 'https:' && u.host === 'do.dsul.app'`. Never compare `.origin`: `blob:https://do.dsul.app/x` has that same origin.
  - A `DSUL_URL` override is honoured only when `!app.isPackaged`.
  - Pointing the shell at localhost means `pnpm dev` talks to PROD until `local-setup.sh dev` has run (CLAUDE.md).
- **Dev isolation.** When `!app.isPackaged`, call `app.setPath('userData', <appData>/dsul-dev)` before taking the single-instance lock. Then a dev `electron .` doesn't share the installed app's cookies and doesn't lose the lock to it.
- **webPreferences.** Use `{ preload, contextIsolation: true, sandbox: true, nodeIntegration: false }` on the persistent `session.defaultSession`. A non-persistent partition would throw away the login, the PKCE verifier and the service worker on every launch.
- **Size and paint.**
  - Set `minWidth: 900`. Below 768px the mobile shell renders (hooks/use-mobile.ts:3), and below 1180px the item panel overlays the page instead of docking (components/shell/desktop-shell.tsx:216).
  - Take `backgroundColor` from `nativeTheme.shouldUseDarkColors`: `#0e1014` dark or `#fbfaf9` light (app/layout.tsx:68-71). Show the window on `ready-to-show`.
- **Frame (revised 2026-10-01, after Kirby's first run on a Mac).** v1 shipped with the standard OS frame; v0.1.1 drops the macOS title bar, the way Claude's app does.
  - macOS: `titleBarStyle: 'hidden'`, traffic lights at `{x: 37, y: 20}` and `titleBarOverlay: {height: 43}` (electron/lib/window-chrome.cjs). The overlay is what defines `env(titlebar-area-*)` for the page, and nothing else does (no browser, no installed PWA, no framed window, not macOS full screen), so every rule the page keys off it falls back to today's layout everywhere else.
  - The page's top 43px (the shell's 12px gutter plus the sidebar's 31px wordmark row) is a window-drag band: `.titlebar-drag`, the first child of `<body>` (app/globals.css). Anything interactive or hover-driven above y 43 takes `titlebar-hole`. The wordmark moves to 14px past the green light; the full-page routes pad their top to the band.
  - Windows and Linux keep the native frame: the caption buttons would sit over the canvas card's rounded top-right corner, and their colours cannot follow dsul's theme without a bridge method. Electron ignores drag regions in a framed window, so the page's CSS does nothing there.
  - Release order: the web half deploys first (it is inert until a shell sets `titleBarOverlay`), then the shell is released. A new shell on an old deployment would have no drag band.
- **Guards.** Attach them in `app.on('web-contents-created')`, so every webContents has them before its first load.
  - **`will-navigate`, `will-frame-navigate` and `will-redirect`.** `will-frame-navigate` covers subframes; the app has none today.
    - An app URL stays in the window, unless `carriesAuthCode` is true: the path is `/auth/callback`, or the URL has a `code` query parameter.
    - Anything else gets `preventDefault()`. It then goes to `shell.openExternal` only if `externalAllowed` passes, which allows `https:`, `http:` and `mailto:`.
  - **Why the code rule exists.** Three things will exchange a code that reaches them:
    - `/auth/callback` exchanges whatever code arrives (app/auth/callback/route.ts:9-14);
    - the root forwards `/?code=` there (lib/canonical-host.ts:38-41);
    - the browser client exchanges `?code=` on ANY page load while a verifier exists (@supabase/ssr 0.9.0 createBrowserClient.js:38-40; auth-js 2.99.3 GoTrueClient.ts:2302-2308).

    So only main's own `loadURL` may carry a code; it emits no `will-navigate`. `/connect?code=` is not affected in practice: the pairing link arrives from outside the app (app/api/agent/connect/init/route.ts:80), and the shell has no address bar.
  - **What the guard catches.** Beacon chat links (ReactMarkdown with no `a` override, components/ai/chat-conversation.tsx:312-314) and the app's one `target=_blank` link (app/docs/openclaw/page.tsx:133-136). Whether it catches files and links dropped onto the window is **[unverified]**.
  - **`setWindowOpenHandler` always returns `deny`.**
    - A non-app URL goes to `openExternal`.
    - A same-origin URL (⌘/Ctrl-click or middle-click) does nothing in v1. "Open as page" then leaves the console open where it is, which is the safe failure: its close runs only on a real navigation (components/planner/organize/detail-parts.tsx:410-427).
  - **`will-attach-webview`** gets `preventDefault()`.
- **Fuses**, from the first release (app-builder-lib 26.15.3 out/configuration.d.ts:235, :477-517):
  `runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false`.
  - Without cookie encryption, cookies are stored in plaintext on disk (:481), including Supabase's session and the verifier.
  - Cookie encryption is one-way. Never turn it off once it has shipped.
- **Command-line switches.** In a packaged build, quit at startup if `app.commandLine.hasSwitch` reports any of `remote-debugging-port`, `remote-debugging-pipe`, `inspect`, `inspect-brk`, `host-resolver-rules`, `ignore-certificate-errors`, `ignore-certificate-errors-spki-list`, `proxy-server`, `proxy-pac-url`, `disable-web-security`, `log-net-log`, `net-log-capture-mode` or `ssl-key-log-file`, or if the `SSLKEYLOGFILE` environment variable is set. The list and the check are `BLOCKED_SWITCHES` / `blockedLaunch` in lib/policy.cjs, so the policy test locks them. **[unverified: whether Chromium acts on any of these before main runs]**
  - A review ran the later five against Electron 44.5.1: a net log in `Everything` mode writes the sb-* cookie values in plaintext, a key log (switch or env) decrypts any packet capture, an SPKI allow-list turns certificate checks off for that key, and a PAC URL routes the window through any proxy. The DevTools port opens only after main's synchronous code, so the exit at module load does beat it.
  - No switch list is complete. This is defense in depth for the macOS keychain-bound cookie key, not a boundary: a same-user process has other routes (an unhardened ad-hoc build, the unverified HTTP and service-worker caches in userData).
- **Menu.** Install a custom, minimal menu.
  - macOS must have the Edit roles, or ⌘C/V/X/A stop working in text fields.
  - Keep the View zoom roles. The app hands Ctrl+=/−/0 back to the browser outside the week views (lib/commands/registry.ts:766-771).
  - Show DevTools only when `!app.isPackaged`.
  - On Windows, set `autoHideMenuBar: true`.
  - Never use `before-input-event` for app shortcuts.
- **Right-click menu.** `context-menu` shows:
  - spelling suggestions plus Cut/Copy/Paste/Select All when `params.isEditable`;
  - Copy when there is a selection;
  - nothing otherwise.

  The app's own Radix menus cancel the DOM event, so they never reach this handler.
- **Permissions.** The request and check handlers allow `clipboard-sanitized-write` and `notifications` for app URLs only, and deny everything else.
- **Offline.**
  - On a main-frame `did-fail-load` (ignore `-3`, ABORTED), call `loadFile('offline.html')`. Its only script is `location.replace('https://do.dsul.app/')` when the `online` event fires.
  - Main retries too, because `online` never fires if `navigator.onLine` was already true when the load failed (a wake from sleep while DNS or Wi-Fi settles, or the site briefly down). While the window shows the offline page it reloads the start URL after 5s, 15s, 30s, then every 60s, and stops once an app URL commits. A reveal (the shortcut, a relaunch, the tray, the Dock) retries at once, and `powerMonitor` `resume` restarts the backoff. offline.html and its pinned CSP hash are unchanged.
  - Without this, an offline launch shows a blank window: Serwist has no navigation fallback (app/sw.ts:13-18).
  - The preload runs on the offline page too, but the bridge does nothing there. Every `ipcMain` handler requires `event.senderFrame === event.sender.mainFrame` and `isAppUrl(senderFrame.url)`.
  - On `render-process-gone`, reload.
- **Closing.**
  - Closing the window hides it to the tray, unless `isQuitting` is set. `before-quit` sets it and also calls `cookies.flushStore()`.
  - On macOS a fullscreen window leaves fullscreen first and hides on `leave-full-screen`. Hiding it in place leaves its Space behind, black and empty (electron/electron#20263).
  - On macOS, `app.on('activate')` shows the window again.
  - Quit comes from the tray menu or ⌘Q.

## Sign-in handoff

Both login paths use PKCE, and the verifier is a cookie on do.dsul.app (lib/supabase.ts:1-8, createBrowserClient). So the browser that finishes a sign-in must be the same one that started it. Two facts force the design:
- A magic link always opens in the system browser.
- Google refuses embedded webviews (`disallowed_useragent`). Don't spoof the user agent.

So the code travels back to Electron, and Electron's own cookie jar does the exchange. Only a code crosses into the app, never a token.

**What PKCE does and doesn't protect.**
- It stops code interception.
- It stops blind injection of an attacker's code, which fails with `bad_code_verifier`.
- It does NOT stop injection by anyone who can read the authorize URL. The `code_challenge` travels in that URL in plain text (auth-js GoTrueClient.ts:3293-3303), so browser history, sync, or an extension can mint a matching code for their own account.

Three things below narrow that gap: the short pending windows, the code-navigation guard, and the "Signed in as" notice.

**Step 0 (Kirby, free; do it after the login change below ships)**
1. In Supabase → Auth → URL Configuration, set the Site URL to `https://do.dsul.app`, and make the Redirect URLs include `https://do.dsul.app/**`.
   - Why: today a refused `redirectTo` falls back to the Site URL (commit 5d8fb96; lib/canonical-host.ts:1-8), even though next.config.mjs:14-16 says the allow-list names do.dsul.app.
2. Check it in a **private window**, because proxy.ts:64-69 sends signed-in users away from /login.
   - Open `https://do.dsul.app/login?redirect=%2Fconnect` and sign in with Google.
   - Confirm you end on /connect, with no hop through `v0-anchor-plum.vercel.app`.
   - If that works, the glob covers `/auth/desktop` too.
3. No `dsul://` entry is needed, because Supabase never sees that scheme.

**The flow**
1. The desktop login runs only when `window.dsulDesktop` exists. It sets `redirectTo` to `${origin}/auth/desktop`.
   - **Google:** call `signInWithOAuth({ provider:'google', options:{ redirectTo, skipBrowserRedirect:true } })`. The verifier is stored before the call resolves. Then call `dsulDesktop.openAuthUrl(data.url)`.
   - **Email:** call `signInWithOtp`, and call `dsulDesktop.armEmailSignIn()` only after it resolves. The verifier is written inside `signInWithOtp`, so arming (and flushing) before it would flush nothing.
2. The system browser lands on `/auth/desktop?code=…`. Errors arrive both as `?error…` and as `#error…`.
3. `/auth/desktop` bounces to `dsul://auth/callback?code=…`, or to `dsul://auth/callback?error_code=…` on failure.
4. Main checks the link and calls `loadURL` on `https://do.dsul.app/auth/callback?code=<encoded>`. The existing route exchanges the code against Electron's cookie jar and redirects to `/` (app/auth/callback/route.ts:9-14).

**Web files**
- **`lib/safe-next.ts` (new, not gated, ships first).**
  - `safeNext(raw, origin)` accepts a value only if it starts with `/`, does not start with `//` or `/\`, and satisfies `new URL(raw, origin).origin === origin`. Anything else becomes `'/'`.
  - Use it at app/auth/callback/route.ts:7.
  - Why: today `next=@evil.com` lands on evil.com after a sign-in, because :13 builds `${origin}${next}`.
- **`lib/auth-redirect.ts` (new, not gated, same PR).** It builds the login's redirect target.
  - **Browser, with a `redirect`:** `/auth/callback?next=` + `encodeURIComponent(safeNext(redirect))`. This is the shape /connect already uses (app/connect/page.tsx:37-41).
  - **Browser, no `redirect`:** plain `/auth/callback`, as today (app/login/page.tsx:78-80).
  - **A `redirect` that already starts with `/auth/callback?`** passes through unchanged. That is what /connect sends (app/connect/page.tsx:40-41). Wrapping it again would make the second hop arrive with no code and land on `/login?error=auth` (app/auth/callback/route.ts:17-18).
  - **Desktop:** `/auth/desktop`.
  - **Why it isn't gated.** Four pages send bare paths: app/goal/[id]/page.tsx:132, app/item/[id]/page.tsx:84, app/settings/[[...pane]]/page.tsx:191 and components/planner/container-page.tsx:164. The login page uses those as `redirectTo` unchanged (app/login/page.tsx:106, :130). Once Supabase honours them:
    - the signed-out landing page is sent to /login with its query kept (proxy.ts:58-61);
    - the provider's browser client exchanges the code there (components/providers/supabase-provider.tsx:131, :458-462);
    - nothing navigates away, so the user is signed in but still looking at the sign-in form.

    That may already happen today, if the allow-list honours those paths **[unverified]**. Step 0 must wait until this change ships.
- **`app/auth/desktop/route.ts` (new).** It is a GET Route Handler, not a page. A page would mount:
  - SupabaseProvider, which tries a client-side exchange (supabase-provider.tsx:131);
  - Analytics, which would log the code (app/layout.tsx:140).

  The route sits under `/auth`, so the auth gate (proxy.ts:58) and the signed-out redirect (lib/signed-out-redirect.ts:17-19) leave it alone.
  - **Response.** It returns a **constant** HTML string, with these headers:
    - `Cache-Control: no-store`
    - `Referrer-Policy: no-referrer`
    - `X-Robots-Tag: noindex`
    - `X-Frame-Options: DENY`
    - `Content-Security-Policy: default-src 'none'; script-src 'sha256-<hash of the inline script>'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

    No CSP or framing header exists anywhere in the repo today (grep).
  - **Script.**
    - It reads `location.search` and `location.hash`.
    - It forwards only a `code` matching `/^[A-Za-z0-9._~-]{8,256}$/`, or an `error_code` matching `/^[a-z_]{1,64}$/`. It never forwards `error_description`, `access_token` or `refresh_token`.
    - It removes the code from the address bar with `history.replaceState`, then calls `location.replace` with the dsul URL.
  - **Open dsul button.** It retries the handoff. The script attaches its click listener, because the CSP blocks inline handlers.
  - **Page copy:** "Opened this on your phone or another computer? Go back to the computer where you asked to sign in."
- **`app/login/page.tsx` (desktop branch only).**
  - Build the redirect target with `lib/auth-redirect.ts`.
  - After `openAuthUrl`, call `setLoading(false)` and show "Finish signing in in your browser" with an **Open again** button. Today `loading` resets only on error (:134-137).
  - Change the sent-email copy to "open the link on this computer". Today it says "Open it on this device" (:232-234).
  - Read `?error=expired|cancelled|auth` and show dsul's own copy. Today nothing reads `error` (:75-80).
  - In v1, drop the `redirect` param: a desktop sign-in always lands on `/`.
- **`app/auth/callback/route.ts`** sends a code whose PKCE flow state expired (`error.code === 'flow_state_expired'`) to `/login?error=expired`, and every other failure to `?error=auth` as before. It isn't gated, but a browser's login page shows nothing for either value, so only its address bar differs.
- **`lib/desktop.ts`** exports `getDesktopBridge()`. **`types/dsul-desktop.d.ts`** types `window.dsulDesktop?`.

**Main-process gate: `handleDeepLink`, using `parseDeepLink`**
- **Which links are accepted.** Only `dsul:` links with host `auth` and path `/callback`, and only while a sign-in is **pending**.
  - Outside a pending sign-in, every link is dropped silently, error links included.
  - Why: a failed exchange deletes the verifier (auth-js GoTrueClient.ts:1315, :1332), so a stray link must never reach one.
- **A code link.**
  - The code must match the loose token shape above.
  - It must not have been seen before. Keep a de-dupe set, because `process.argv`, `second-instance` and `open-url` can each deliver the same link.
  - The first accepted code clears pending. Main sets a one-shot sign-in notice, loads the callback, then calls `restore()`, `show()` and `focus()`.
- **An error link.**
  - The `error_code` maps to `expired` (flow_state_expired, otp_expired), `cancelled` (access_denied) or `auth` (anything else).
  - It clears pending and loads `/login?error=<that>`.
  - There is no native dialog, and no text from the server is shown anywhere.
- **Pending windows.**
  - They are kept in memory and in `userData/auth-pending.json`, so a cold start still honours them. Each write is followed by `flushStore()`.
  - Google: 10 minutes, since its code dies at 300s.
  - Email: 60 minutes **[unverified: magic-link expiry]**.
- **`openAuthUrl(url)` is checked in main, by `checkAuthorizeUrl`.** The URL must have:
  - protocol `https:`;
  - host === `SUPABASE_HOST`, which is `ctcspcferkdlzdcqlozq.supabase.co` per tests/unit/e2e-local-target.test.ts:17. Comment it as mirroring `NEXT_PUBLIC_SUPABASE_URL`;
  - path `/auth/v1/authorize`;
  - `provider=google`;
  - `redirect_to === APP_ORIGIN + '/auth/desktop'`;
  - `code_challenge_method=s256`, with a challenge present.

  Anything else is rejected and does not arm pending. In dev only, the local Supabase stack's origin is also accepted.
- **Authorize URL inside the window.** A `will-navigate` to the authorize URL is blocked, and `/login` is reloaded. It is never opened externally: its `redirect_to` is `/auth/callback`, which fails in a browser that has no verifier (route.ts:17-18).
- **"Signed in as" notice.** The bridge's `takeSignInNotice()` returns the one-shot flag, and the web side shows a "Signed in as <email>" toast. That makes an injected login into someone else's account visible.

**Failure modes**
- **The allow-list fallback is in play.** The browser ends at the web `/login?error=auth`, and Electron never hears about it. Step 0 fixes this.
- **The link is opened on another device.** `dsul://` goes nowhere, and the bounce page's copy explains what to do. The cross-device fix is a 6-digit OTP (Later).
- **The code is older than 300s.** GoTrue answers `flow_state_expired`, and the login page shows the "expired" copy.
- **A second sign-in attempt** overwrites the single verifier slot, so the first attempt's code dies.
- **Email scanners** that prefetch links can use one up. This is an existing web problem.
- **Fallback if Step 0 or the Windows registry work stalls.** Use Google through a one-shot `http://127.0.0.1:<port>` listener, plus email through a 6-digit OTP. That removes `dsul://` and `/auth/desktop`. The costs: browser users see an edited email template, and hosted GoTrue's acceptance of loopback redirects is **[unverified]**.

## Notifications and push

- **Web Push does not work in Electron.**
  - The feature check passes (hooks/use-push-subscription.ts:24-28), and then `subscribe()` rejects.
  - The error is only logged (lib/settings/manifest.ts:1085-1090), and the switch snaps back off.
  - Service-worker notifications and their Done/Snooze actions (app/sw.ts) do nothing.

  **[unverified on a device]**
- **Say so in the push row.** In its `unavailable()` (lib/settings/manifest.ts:1076-1083), right after the `!ctx.push` line, return `'not available in the desktop app yet — turn push on from your phone or browser'` when `getDesktopBridge()` is set.
- **Reminders keep reaching other devices.** The server sends to every `push_subscriptions` row (lib/push-send.ts:94-112).
  - Kirby shouldn't turn phone push off thinking the desktop app covers it. The channel reports `ok` even when it reached zero devices (lib/reminders/channels/push.ts:61), so reminders would vanish without an error.
- **Native reminders are Later.** They need an outbox table plus Realtime, and a main-process `Notification` that posts to `/api/reminders/act`, which authenticates with the cookie session (app/api/reminders/act/route.ts:25-28). They also need a signed macOS build. Call `app.setAppUserModelId(appId)` in v1 anyway; it costs nothing.
- **Kirby's call, separately: reload on reconnect.** Serwist's default `reloadOnOnline` is not overridden (next.config.mjs:43-47). So a tray app fully reloads on every wake from sleep and loses any unsaved draft. Turning it off changes browser behaviour too.
- **Deploy skew is real.** `skipWaiting`/`clientsClaim` (app/sw.ts:16-17) plus a window that stays open for days means old JavaScript can request chunks a new deploy no longer serves. The stale-window reload fix is Later.

## Global quick capture and tray

- **The shortcut.** `globalShortcut.register('CommandOrControl+Shift+Space', capture)`.
  - If it returns false, the tray menu says "shortcut unavailable".
  - No in-app binding uses this key (lib/commands/registry.ts:220-1318).
  - On Windows it is Word's non-breaking space **[unverified on Kirby's machine]**. If it clashes, change the constant; an override file is Later.
  - Leave Ctrl+I / ⌘I alone. It focuses the docked capture bar and never opens the launcher (tests/unit/launcher-commands.test.ts:65).
- **A press is never lost across page loads.**
  - `capture()` sets `pendingCapture` in main, then calls `restore()`, `show()` and `focus()`.
  - The preload's `onQuickCapture` subscribes, then sends `dsul:capture-ready`. Main answers a ready message with any pending capture and clears it.
  - Readiness resets on every main-frame document load. So a press during a cold start, the signed-out bounce or a reload is held until the page is ready.
- **Tray menu:** New task (same as the shortcut), Open dsul, Update available (when one is known), Quit. macOS uses a template image.
- **The preload bridge.** It is everything the page can reach, and an XSS can reach it too, so it stays tiny:
  `{ version: 1, shellVersion, electronVersion, onQuickCapture(cb) → unsubscribe, openAuthUrl(url), armEmailSignIn(), takeSignInNotice() }`.
  - The preload registers `ipcRenderer.on('dsul:quick-capture', () => cb())`, so the IpcRendererEvent never reaches the page.
  - It exposes no generic send or invoke.
- **Where the web app hooks in: `components/providers/desktop-bridge.tsx` (new),** rendered next to `<ConsoleSlotGuard />` (app/layout.tsx:132). Without a bridge it returns early. On a press it:
  1. ignores the press on a signed-out path (`isSignedOutPath`, lib/signed-out-redirect.ts:17);
  2. otherwise marks a capture as wanted, and calls `router.push('/')` if not already on `/`;
  3. opens the launcher from an effect, once `pathname === '/'` and `selectPlannerSettled` (lib/planner-ready.ts:37) both hold.

  Never wait for the planner before navigating home:
  - lean routes never settle (lib/planner-ready.ts:27-30; lib/route-data.ts:34-47);
  - a slot armed away from `/` springs open on the next trip home (lib/console-door.ts:17-23).

  Leaving for a signed-out path clears the pending capture.
- **`openQuickCapture()`**, in lib/ui-store.ts next to `openAddDialog` (:188).
  - **Slot empty:** call `openDialog({ type: 'launcher', query:'+' })`. This follows the `/` seeding precedent (lib/commands/registry.ts:990).
  - **Launcher already open:** call `closeDialog()`, then re-open on `setTimeout(0)`. Done in one tick, the two updates batch, the Omnibar never remounts, and it reads its seed only once (components/shell/omni-launcher.tsx:25-29, :60; components/sidebar/omnibar.tsx:166).
  - **The docked item panel open** (`edit-item`, the resting state after a row click): treat it as an empty slot, as ⌘K does. The panel flushes a queued autosave as it unmounts.
  - **Any other dialog open:** leave it alone; there is only one slot (lib/ui-store.ts:157). The window is already focused.
  - **A confirm open** (`confirmRequest`, its own slot): leave it alone too, and check again before the re-open above. The launcher would otherwise stack over a destructive prompt the user may not have seen.
  - Never use a URL param instead: a hard load tears down the store and the undo stack (lib/commands/registry.ts:1430-1435).

## Single instance and `dsul://`

- Call `app.requestSingleInstanceLock()`. If it returns false, `app.quit()`.
- **macOS.**
  - electron-builder's `protocols` option writes `CFBundleURLTypes`. It does nothing on Windows: the option is documented as "macOS only" (app-builder-lib 26.15.3 out/options/PlatformSpecificBuildOptions.d.ts:220), and it is read at out/electron/electronMac.js:143, never by NSIS.
  - Links are delivered through `open-url`. Register it inside `will-finish-launching` so cold starts are caught.
- **Windows.**
  - Set `nsis.include: build/installer.nsh`.
  - `!macro customInstall` (hook at templates/nsis/installSection.nsh:81-82) writes HKCU `Software\Classes\dsul`:
    - default value `URL:dsul`, plus a `URL Protocol` value set to "";
    - `shell\open\command` set exactly to `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"`: quoted, `%1` last, never `%*`.
  - `!macro customUnInstall` (uninstaller.nsh:156-157) runs `DeleteRegKey HKCU "Software\Classes\dsul"`.
  - Packaged builds also call `setAsDefaultProtocolClient('dsul')`, to repair the key if it goes missing.
  - Dev builds register only when `DSUL_DEV_PROTOCOL=1`. Doing so overwrites the installed app's key, so relaunch the installed app afterwards.
  - Read exactly one argv entry that starts with `dsul:` (from `second-instance` or `process.argv`), and ignore every other argument. **[unverified: Electron's own guard against switches after a URL argument]**
- Queue a link until the window has loaded.
- Test deep links on packaged builds only.

## Packaging and signing

Use electron-builder 26.15.x: not the 27 alpha, and not Forge, which has no NSIS maker. Use electron ^44.

- **Identity (permanent once shipped).** `appId: app.dsul.desktop`, `productName: dsul`. These become the macOS bundle id, the Windows AUMID and the NSIS GUID.
- **Layout.** `directories: { output: release, buildResources: build }`. `files`: main.cjs, preload.cjs, lib/**, offline.html, build/tray*, build/app-icon-*.png (the run-time icons; without them `createFromPath` is an empty image in the packaged app).
- **macOS targets.** `dmg` plus `zip`, **arm64 only** in v1. Add x64 once an Intel Mac can test it.
  - **Signing identity.** The JS config sets `identity: process.env.CSC_LINK ? undefined : '-'` and `hardenedRuntime: !!process.env.CSC_LINK`.
    - Without a certificate there is NO automatic ad-hoc fallback (out/options/macOptions.d.ts:23; out/mac/MacTargetHelper.js:37-46).
    - Ad-hoc signing plus hardened runtime fails library validation (macOptions.d.ts:137-141).
    - An unsealed bundle shows "dsul is damaged" on Apple Silicon, with no Open Anyway button **[unverified on device]**.
  - **Entitlements.** Signed builds point `entitlements` and `entitlementsInherit` at `build/entitlements.mac.plist`, which holds only `com.apple.security.cs.allow-jit`.
    - The default template also adds `allow-unsigned-executable-memory` and `disable-library-validation` (templates/entitlements.mac.plist:6-12). Those undo much of what notarization buys.
    - Add `allow-unsigned-executable-memory` back only if a signed build crashes without it **[unverified: Electron 44's minimum]**.
- **Ad-hoc caveat.** Each release has a new code hash. With cookie encryption on, macOS will ask for the "dsul Safe Storage" keychain item after every update, and denying it signs the user out. A Developer ID build ends that.
- **Windows target.** `nsis` x64, with `oneClick: true`, `perMachine: false` and `artifactName: dsul-setup.${ext}`.
  - A file name without a version keeps `https://github.com/kjswalls/dsul/releases/latest/download/dsul-setup.exe` working as a permanent link.
  - Unsigned builds go through SmartScreen → More info → Run anyway.
- **Do not set `CSC_IDENTITY_AUTO_DISCOVERY=false`.** With it set, a supplied `CSC_LINK` is imported but never selected (out/util/flags.js:13-14, out/codeSign/macCodeSign.js:261-268), so nothing is signed or notarized.
- **Leave `notarize` unset.** 26.x notarizes whenever it has signed and these are set (out/mac/MacTargetHelper.js:236-241, :256-266):
  - `APPLE_API_KEY` (the path to the .p8 file);
  - `APPLE_API_KEY_ID`;
  - `APPLE_API_ISSUER`.

  Together with the identity switch, adding the secrets is then the only change needed.
- **Windows signing (Later, $0).** SignPath Foundation's open-source program **[unverified: eligibility]**. A paid certificate would plug in as `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`.

## Release workflow: `.github/workflows/desktop-release.yml`

- **Trigger.** `on: workflow_dispatch`. The file must reach `main` through a normal PR before it can be dispatched.
- **Pin every action to a commit SHA.** The existing workflows use tags (test.yml:25-31, claude-review.yml:31,35).
- **`prepare` job.** `if: github.ref == 'refs/heads/main'`, with `contents: write`. It:
  1. reads the version from `electron/package.json`;
  2. fails if `v$V` is already published, because electron-publish would then upload nothing and still report green (out/gitHubPublisher.js:74-82);
  3. creates the draft release if it's missing.

  The build jobs `needs:` this job. Without it, two build jobs finishing close together can each create a draft (:58-106).
- **`build` job.** A matrix of `macos-latest` and `windows-latest`, with `fail-fast: false`, `working-directory: electron`, `environment: desktop-release`, `permissions: contents: write`, and the same `if`.
  - setup-node 24 with `cache: npm` on `electron/package-lock.json`. The web CI stays on Node 20 (test.yml:29).
  - Then `npm ci --ignore-scripts`.
  - One `shell: bash` step runs `npx electron-builder --config electron-builder.config.cjs --mac --arm64` (or `--win --x64`) `--publish always`.
    - Only that step gets `GH_TOKEN` and the secrets, under `DESKTOP_`-prefixed names (listed in Kirby's checklist and the workflow's header).
    - It exports `CSC_LINK` and the related variables only when they are non-empty. An empty `CSC_LINK` counts as set and throws (out/platformPackager.js:80-84).
    - It writes the .p8 file to `$RUNNER_TEMP`.
  - Signed macOS runs then print `codesign -d --entitlements - dsul.app`.
- **Secrets** live in a GitHub Environment named `desktop-release`, limited to deployment branch `main`, with Kirby as required reviewer. A dispatch from any other ref, including a Claude session's branch, gets no signing material.
- **Never make it a required check.**
- **Cost and tags.** The repo is public, so the runners are free. It has no releases or tags yet, so `v*` tags are free to use.
- **PR builds are Later.** When they're added:
  - a separate job with `contents: read` and no secrets;
  - `--publish never` plus `upload-artifact`;
  - same-repo PRs only;
  - `CSC_FOR_PULL_REQUEST: 'true'`, so they get the ad-hoc signature, which needs no secrets. Otherwise PR builds are never signed (app-builder-lib out/codeSign/macCodeSign.js:21-44).

## Updates

- **v1: an update notice.** The site updates itself through Vercel, but the bundled Chromium updates only through a new installer, and it renders remote content: Beacon markdown with remote images and links (chat-conversation.tsx:312-314).
  - On launch and every 24h, fetch `api.github.com/repos/kjswalls/dsul/releases/latest`. If it's newer, a tray item opens the release page.
  - Rebuild whenever Electron ships a security release for 44, and move to a newer major before 44 leaves support **[unverified: Electron's support window]**.
- **Later: a web banner.** Shown only in the desktop app, when `shellVersion` is below a minimum the site sets.
- **Later: `electron-updater`, only once builds are signed.** For unsigned builds, latest.yml's sha512 comes from the same release an attacker would publish, and `verifyUpdateCodeSignature` has no publisher name to check (out/options/winOptions.d.ts:33-39, :115-119). Before any updater ships:
  - keep `verifyUpdateCodeSignature: true`;
  - pin `win.publisherName`;
  - protect `v*` with a tag ruleset;
  - turn on GitHub immutable releases;
  - consider a separate releases repo that only the release workflow can write to.

## App icon

The Aurora mark (Kirby's pick, 2026-10-02; it replaced Wave, which looked dull in the Dock). The plain `node scripts/app-icon/build.mjs` writes this app's icons straight into `electron/build/`; `--native <dir>` adds the other platforms' files, and a copy is in the project's shared folder at `app-logo/icons/`, with a README saying where each goes.
- **macOS:** `electron/build/icon.png` is the 1024px tile drawn on Apple's grid (824px rounded tile with a shadow), so the Dock shows a proper squircle. electron-builder derives the .icns from it.
- **Windows:** `electron/build/icon.ico` holds 16 to 256.
- **Tray:** `build/tray.png` and `tray@2x.png` are the 16 and 32px favicons on Windows; macOS gets `trayTemplate.png` / `trayTemplate@2x.png`, a hand-made dot grid in black on transparent, so the menu bar tints it.
- `public/icons/` is the web app's, written by the same script. The shell never loads it.

**The run-time icon (Settings → Look → App icon, Aurora or Lime).**
- The page sends its choice through `window.dsulDesktop.setAppIcon(look)` (preload.cjs) on `dsul:set-app-icon`; main answers only `fromApp`, accepts only a look `lib/app-icon.cjs` knows, and ignores a repeat. The page sends it once settings have hydrated for the signed-in user, never the untouched fallback, so a fresh shell doesn't stamp Aurora over a synced Lime. The bridge stays `version: 1`: `setAppIcon` is optional and the page checks it exists, so an older shell just skips it.
- Main keeps the look in `userData/app-icon.json` (`{"look":"lime"}`; not secret, so no `0o600`) and reads it in `ready()`, so the next launch starts on it.
- **macOS:** `app.dock.setIcon` with `build/app-icon-<look>.png`, called before the window is made. It lasts only while the app runs: launch bounces the bundle's Aurora first, and Finder, Launchpad and a Dock tile pinned while the app is closed always show Aurora.
- **Windows and Linux:** `win.setIcon` with the same PNG, and the window is created with it, so a Lime user's taskbar never shows Aurora. A taskbar button pinned while the app is closed keeps the bundle's Aurora `.ico`.
- Both PNGs are 512px tiles on Apple's grid, on every platform; there is no run-time `.ico`. The tray stays Aurora (no Lime tray art).
- Only the setting reaches the shell. The browser tab's day-done Lime (`components/providers/favicon-sync.tsx`) does not: Electron shows no favicon, and a daily swap would be a daily disk write.

## Testing

**Vitest (root `tests/unit/`, gated by the required check)**
- **`safe-next.test.ts`:** `/` and `/connect?code=x` pass. `@evil.com`, `.evil.com/x`, `//evil.com`, `/\evil.com` and `https://evil.com` all become `/`.
- **`auth-redirect.test.ts`.** It tests the pure helper, because the login page itself won't mount in the unit suite: it needs ResizeObserver and canvas (app/login/page.tsx:65; components/primitives/relay-field.tsx:200, :565), which tests/unit/setup.ts:44-57 doesn't polyfill. Cases:
  - no `redirect` → `/auth/callback`;
  - `/goal/x` → `/auth/callback?next=%2Fgoal%2Fx`;
  - `@evil.com` → `next=%2F`;
  - /connect's `/auth/callback?next=%2Fconnect%3Fcode%3Dx` → unchanged;
  - desktop → `/auth/desktop`.
- **`auth-desktop-route.test.ts`:**
  - returns 200 `text/html` with all five headers;
  - the CSP hash matches the served script;
  - the body is byte-identical whatever the query;
  - the script never forwards `error_description`, `access_token` or `refresh_token`.
- **`desktop-bridge.test.tsx`:**
  - with no bridge, nothing subscribes;
  - a press is ignored on `/login`;
  - from `/settings`, a press causes exactly one push home and one launcher open, once the planner has settled;
  - the rendered input reads `+` (assert the DOM, not just the store);
  - a second press with the launcher open re-seeds it;
  - an open Add dialog is left alone;
  - an open docked item panel (`edit-item`) gives way to the launcher;
  - an open confirm is left alone, including one raised between the close and the re-open.
- **Push row:** `unavailable()` returns the desktop copy only when a bridge is present.
- **`electron-policy.test.ts`**, which imports `electron/lib/policy.cjs` (it has zero imports):
  - `isAppUrl` rejects `blob:https://do.dsul.app/x`, `https://do.dsul.app.evil.com`, `https://do.dsul.app@evil.com`, `file:///C:/x.html` and `javascript:`, and accepts `HTTPS://DO.DSUL.APP:443/`;
  - `carriesAuthCode` and `externalAllowed`;
  - `parseDeepLink`: valid shapes, wrong host or path, error codes;
  - `checkAuthorizeUrl`: a foreign `*.supabase.co` host, a wrong `redirect_to`, provider or challenge method.

**Manual checks on packaged builds, on Kirby's Windows machine and an Apple Silicon Mac**
- **Install.** Download through a browser so the quarantine flag is set. On macOS, Open Anyway must appear. On Windows, SmartScreen.
- **Sign-in.**
  - Google round trip.
  - Magic link with the app open, and again after quitting it (cold start).
  - A magic link opened on the phone shows the bounce page's copy.
  - An unsolicited `dsul://auth/callback?error_code=x` does nothing.
  - The "Signed in as" toast shows.
- **Running app.**
  - A second launch focuses the existing window.
  - The shortcut works from another app and while dsul has focus.
  - Tray New task on a cold start loses nothing.
  - Close to tray, a Dock click restores the window, and Quit quits.
  - Keychain prompt behaviour after an ad-hoc update.
- **Inside the window.**
  - ⌘/Ctrl C/V/X/A work in the omnibar.
  - Right-click shows spellcheck suggestions.
  - Ctrl+= zooms outside the week views and scales the columns inside them.
  - A Beacon chat link opens in the browser.
  - Dropping an .html file or a link onto the window does not navigate it.
- **App icon.**
  - Switching to Lime in Settings → Look changes the Dock and ⌘-Tab icon (Mac) or the window and taskbar icon (Windows) at once.
  - Lime holds across a quit and cold launch, after the launch bounce shows Aurora.
  - Switching back restores Aurora.
  - The offline page can't change the icon.
  - Whether a pinned Windows taskbar button follows `win.setIcon` **[unverified]**; `setOverlayIcon` is the fallback.
- **Resilience.**
  - An offline launch shows the offline page and recovers.
  - Sleep and wake.
  - The push row shows the desktop copy.
  - Uninstalling removes `HKCU\Software\Classes\dsul`.

Real builds come only from the GitHub runners. This container can't build a dmg.

## Kirby's checklist

- **Supabase:** Step 0, in a private window, after the login PR ships.
- **GitHub:** create the `desktop-release` Environment (deployment branch `main`, you as required reviewer), and add a `v*` tag ruleset.
- **Apple, when you're ready to sign.**
  - A *Developer ID Application* certificate can only be created by the team's Account Holder.
  - From Windows: create a key and CSR with `openssl` → upload the CSR at developer.apple.com → download the .cer → `openssl pkcs12 -export` into a .p12 **[unverified: may need `-legacy` for macOS keychains]**.
  - Create an App Store Connect API key: you need the .p8 contents, the key id and the issuer id.
  - Add these five Environment secrets, spelled exactly so. The workflow reads no other names, and a misnamed certificate ships an unsigned Mac build:
    - `DESKTOP_CSC_LINK`: the .p12, base64-encoded;
    - `DESKTOP_CSC_KEY_PASSWORD`: its password;
    - `DESKTOP_APPLE_API_KEY_P8`: the .p8 file's contents, not a path;
    - `DESKTOP_APPLE_API_KEY_ID`;
    - `DESKTOP_APPLE_API_ISSUER`.
  - The Mac leg fails if the Apple secrets are set without `DESKTOP_CSC_LINK`, so a half-done setup can't publish quietly.
- **Mac checks:** name the person who will run them on an Apple Silicon Mac before v1 ships.
- **Each release:**
  1. bump the version in `electron/package.json` in a PR, and merge it;
  2. dispatch the workflow from main;
  3. approve the Environment;
  4. check the draft release;
  5. publish it.
- **Download warnings to click through:**
  - Edge/Chrome "isn't commonly downloaded" → Keep;
  - SmartScreen → More info → Run anyway;
  - macOS → System Settings → Privacy & Security → Open Anyway.

## Scope

**v1, in order**
1. The web PR: `safeNext` plus `auth-redirect`.
2. Step 0.
3. The `electron/` skeleton, the guards, the fuses and the policy tests.
4. The sign-in handoff, including `installer.nsh`.
5. Quick capture and the tray.
6. The release workflow.
7. The update notice.

Also in v1: the push-row copy, the app icons, the CLAUDE.md layout line and the eslint ignore.

**Later**
- macOS signing (only the secrets are needed).
- Windows signing.
- electron-updater (signed builds only).
- The desktop update banner.
- PR builds.
- macOS x64.
- Native reminders with Done/Snooze.
- A 6-digit OTP: add `{{ .Token }}` to the email template and use `verifyOtp`.
- Same-origin second windows.
- The stale-window reload.
- A shortcut override and a settings UI for it.
- A custom title bar on Windows (macOS has one since v0.1.1).
- Launch at login.
- Find-in-page.
- Remembering window size and position.
- Windows arm64.
- The `reloadOnOnline` decision.

## Open assumptions (not verified in this pass)

1. The dashboard's Site URL and redirect allow-list, which weren't read because the Supabase MCP failed to connect. Also that GoTrue always allows the Site URL's host.
2. GoTrue behaviour was read from `supabase/auth` master, not the hosted build: the code shape, the 300s expiry and loopback acceptance.
3. How long a magic link stays valid, which sets the 60-minute email window.
4. Electron behaviour was read, not run on a device:
   - the push rejection and service-worker notifications;
   - drop handling and deep-link delivery;
   - early switch handling and argv guards;
   - Keychain prompts under ad-hoc signing;
   - Electron 44's minimum entitlements.
5. That Kirby's everyday machine is Windows, and that Ctrl+Shift+Space is free there.
6. That `ctcspcferkdlzdcqlozq.supabase.co` is production's `NEXT_PUBLIC_SUPABASE_URL`. It appears in tests/unit/e2e-local-target.test.ts:17 and memory/plans/completion-history-growth.md:93; Vercel's env wasn't checked.
7. SignPath eligibility, whether Vercel Skew Protection is on, and whether the .p12 needs the `-legacy` flag.
8. Local shell development.
   - The config that `supabase init` writes sets no redirect list for `localhost:3000` (scripts/local-setup.sh:87-92; the file is gitignored at .gitignore:22). So local `/auth/desktop` needs `additional_redirect_urls` added.
   - Email goes through Mailpit, which the dev stack keeps (scripts/local-setup.sh:76-77).

## Review notes

**Accepted as raised.** Each was checked against the code or the unpacked packages.
- Windows `dsul://` is not written by NSIS (raised twice). The "macOS only" line is at PlatformSpecificBuildOptions.d.ts:220, not configuration.d.ts:220.
- Signing and release:
  - the fuses;
  - the release-workflow secrets;
  - no unsigned Windows auto-update;
  - the default entitlements;
  - the ad-hoc signing blocker;
  - `CSC_IDENTITY_AUTO_DISCOVERY` and empty secrets. The APPLE_API_* names are confirmed, so that [unverified] tag is gone;
  - the draft-release race.
- Sign-in:
  - attacker text in error links, and those links cancelling a sign-in;
  - the PKCE wording, widened: because the browser client exchanges `?code=` on any page load (`detectSessionInUrl`), the guard must cover any `?code=`, not only `/auth/callback`;
  - pinning `openAuthUrl`;
  - the three gate details;
  - Step 0's wrong probe, and users stranded on /login after signing in (app/login/page.tsx has no effect or router to move them).
- Shell:
  - the IPC event leak through the preload;
  - the navigation-guard gaps;
  - dev builds colliding with the installed app;
  - the missing `activate` handler and `isQuitting` flag.
- Quick capture:
  - waiting for the planner on lean routes;
  - same-tick close/open batching (one `set`, omni-launcher.tsx:60, omnibar.tsx:166);
  - captures lost during page loads.
- Also: the login-page test crashing in the unit suite, and the missing Kirby's checklist.

**Accepted in part**
- **No update path in v1.** The update notice moves into v1. The web banner stays Later, to keep v1 small.
- **Vercel.** Corrected: a shell-only merge does redeploy production and rolls out a new service worker. But no `ignoreCommand` in v1, since docs-only merges already pay the same cost.
- **v1 scope.** The stale-window reload, the shortcut override, PR builds and macOS x64 are deferred. Same-origin `window.open` is denied rather than sent into the main window, because a full load there tears down the store and the undo stack (lib/commands/registry.ts:1430-1435).
- **Runtime protocol registration.** The two reviews disagreed (dev-only vs packaged-only). The installer owns the key, packaged builds repair it if it goes missing, and dev builds register only with `DSUL_DEV_PROTOCOL=1`.
- **Error handling.** This goes further than suggested: there is no native dialog at all. Main maps `error_code`, and the login page shows dsul's own copy, so no attacker text reaches any surface.
- **Framing that inherits the browser's "always open" consent.** That behaviour is unverified, but the headers cost nothing, so they are in.
- **Always routing the login through the callback.** As written, it would wrap /connect's callback URL a second time (app/connect/page.tsx:40-41) and break device pairing. So `auth-redirect` passes an existing `/auth/callback?` target through unchanged.