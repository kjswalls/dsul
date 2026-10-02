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
  find-preload.cjs                  # wires find-bar.html from its isolated world; exposes nothing
  lib/policy.cjs                    # PURE, zero imports: isAppUrl, carriesAuthCode, externalAllowed,
                                    #   parseDeepLink, checkAuthorizeUrl
  lib/window-state.cjs              # PURE, zero imports: where the window reopens (parse, fit to
                                    #   the displays, what to save)
  lib/window-chrome.cjs             # PURE, zero imports: the macOS title bar, and where the traffic
                                    #   lights sit at each page zoom (macLights)
  lib/login-item.cjs                # PURE, zero imports: what the tray's Open at login box shows,
                                    #   and the exact requests main sends
  lib/find-bar.cjs                  # PURE, zero imports: the find bar's place, count label, reply
                                    #   filter and Edit-menu Find items
  offline.html, find-bar.html, README.md ("npm only. Never run pnpm in here."),
  .gitignore (node_modules/, release/)
  build/                            # icon.png, tray icons, entitlements.mac.plist, installer.nsh
```

- **It is not a workspace project.** pnpm-workspace.yaml:1-3 lists only `packages/*` and `openclaw-plugin`. So the root `pnpm install` (Vercel; test.yml:44) never pulls in electron-builder's ~200MB app-builder-bin.
  - Never add electron to the root dependencies.
  - Never run `pnpm install` inside `electron/`. In a subfolder the workspace doesn't list, it silently installs the ROOT workspace instead.
  - `--ignore-workspace` avoids that, but it writes a lockfile that the `**/pnpm-lock.yaml` cache key would then hash (test.yml:39).
- **Lint.** Add `'electron/**'` to `globalIgnores` (eslint.config.mjs:6-15), after `openclaw-plugin/**` at :11.
- **Typecheck.** `.cjs` files stay outside tsconfig's include list (tsconfig.json:31-37).
- **Vitest.** It collects only `tests/unit/**` (vitest.config.ts:10). The `tests/unit/electron-*.test.ts` files are the deliberate reaches into `electron/`. Each imports a dependency-free module from it (listed under Testing).
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
  - The minimum is `MIN_SIZE` in electron/lib/window-state.cjs, 900x600, passed as `minWidth`/`minHeight`. Below 768px the mobile shell renders (hooks/use-mobile.ts:3), and below 1180px the item panel overlays the page instead of docking (components/shell/desktop-shell.tsx:26).
  - Take `backgroundColor` from `nativeTheme.shouldUseDarkColors`: `#0e1014` dark or `#fbfaf9` light (app/layout.tsx:68-71). Show the window on `ready-to-show` (`firstShow()`), which also maximizes a window saved maximized just before it appears.
- **Frame (revised 2026-10-01, after Kirby's first run on a Mac).** v1 shipped with the standard OS frame; v0.1.1 drops the macOS title bar, the way Claude's app does.
  - macOS: `titleBarStyle: 'hidden'`, traffic lights at `{x: 37, y: 20}` and `titleBarOverlay: {height: 43}` (electron/lib/window-chrome.cjs). The overlay is what defines `env(titlebar-area-*)` for the page, and nothing else does (no browser, no installed PWA, no framed window, not macOS full screen), so every rule the page keys off it falls back to today's layout everywhere else.
  - The page's top 43px (the shell's 12px gutter plus the sidebar's 31px wordmark row) is a window-drag band: `.titlebar-drag`, the first child of `<body>` (app/globals.css). Anything interactive or hover-driven above y 43 takes `titlebar-hole`. The wordmark moves to 14px past the green light; the full-page routes pad their top to the band.
  - Windows and Linux keep the native frame: the caption buttons would sit over the canvas card's rounded top-right corner, and their colours cannot follow dsul's theme without a bridge method. Electron ignores drag regions in a framed window, so the page's CSS does nothing there.
  - Release order: the web half deploys first (it is inert until a shell sets `titleBarOverlay`), then the shell is released. A new shell on an old deployment would have no drag band.
  - **Page zoom (v0.1.2).** The page's band zooms and the native buttons don't, so main moves them (`macLights` in lib/window-chrome.cjs, `placeLights` in main.cjs). The page reads `env(titlebar-area-*)` as the overlay's points divided by the zoom (Blink local_frame.cc:3519-3535).
    - x is 37 × zoom, so the word's `- 35px` and the status line's `- 23px` stay about 14 CSS px past the green button. A fixed 37 put the word under the buttons from about 160%.
    - y centres the buttons on the zoomed row's midline (27.5 × zoom − 7.5) and stops at 27, so a 16pt button stays inside the 43pt overlay. macOS has no `setTitleBarOverlay` (Windows and Linux only), so past about 125% they sit above the midline.
    - Below 67% y holds at 11: the row is too short for the buttons there, and a y near macOS's default margin would make Electron centre them. x keeps following the zoom.
    - Main re-places them on `did-navigate` (zoom is per host and saved across launches; the offline page has its own, normally 100%), after each View zoom item, and on `leave-full-screen`. Every call but the last skips a full-screen window, whose buttons live in the menu-bar strip; the leave call doesn't trust `isFullScreen()` to read false yet. Electron keeps the position through focus, resize and theme redraws. `placeLights()` stays last in `did-navigate`, after the capture and offline bookkeeping.
    - Zoom always targets the page. The View items call `zoomPage(focusedWindow, action)`, which zooms `win.webContents` only when the focused window is dsul's, and never asks `getFocusedWebContents()`. A view inside the window can hold the focus (the find bar), and the roles would have zoomed it and saved that zoom under its own URL. In a dev build, ⌘= with DevTools focused zooms the page, not DevTools.
    - Ctrl+wheel and pinch never zoom the page: Ctrl+wheel only emits `zoom-changed`, which dsul doesn't handle, and visual zoom is off. Any future zoom source must go through `zoomPage` or call `placeLights`, or the buttons stay put until the next navigation.
    - A launch whose first commit takes longer than the 4s show fallback shows the buttons at 100%'s place, and they move when the page commits. No API gives a host's saved zoom before its document commits (Later).
- **Size and place (v0.1.2).** The window reopens at the size and place it was left. The rules are in electron/lib/window-state.cjs, which is pure and tested; main.cjs only reads the displays and the window, and writes `userData/window-state.json` (`dsul-dev/` for a dev build).
  - **What is stored.** `{"v":1,"x","y","width","height","maximized"}`: the window's normal (un-maximized) outer frame in DIP, and whether it was maximized. No display id, scale or work area: the fit is worked out afresh against the displays connected at launch. Full screen is never stored, so a window quit in full screen reopens as it was before, and a Mac never launches into a full-screen Space of its own. A file of any other shape or version is ignored, and the next save replaces it.
  - **When it saves.** 500ms after the last `resize`, `move`, `maximize` or `unmaximize`. It uses `resize`/`move`, because `resized`/`moved` are macOS and Windows only and miss keyboard snaps. It saves at once in three places:
    - the close handler, while the window is still on screen, before it hides to the tray or Dock (`park()`);
    - `before-quit`, which covers tray Quit, ⌘Q and a macOS log-out;
    - Windows `session-end`, which sets `isQuitting` first and then writes, because Electron ends the process as soon as that handler returns (native_window_views_win.cc:417-437).

    Nothing is saved before the first show, so the restore's own maximize never counts as the user's. Nothing is saved while the shell has the window hidden (`parked`), so a hidden window keeps the state written as it closed. An unchanged state writes nothing. The write is a plain synchronous `fs.writeFileSync`, as for auth-pending.json; a file cut short by a crash is refused, which costs one launch its place.
  - **Never listen to `hide`.** On macOS Electron emits `hide` from occlusion changes (the window covered, another Space, a screen lock, a minimize), never from `win.hide()` itself (electron_ns_window_delegate.mm:45-78; native_window_mac.mm:511-535). That is why the save sits in the close handler.
  - **macOS and maximize.** `getNormalBounds()` reads a frame that AppKit's own zoom (the green button, Window > Zoom) never updates (native_window_mac.mm:764-775; electron_ns_window_delegate.mm:293-306). So a maximized save on a Mac reuses the last bounds saved while the window was normal, and a move in the half second before a zoom is missed. Windows reads the restore rect from the window placement.
  - **How it restores.** The placement is computed in `createWindow`, after `ready`, and goes into the constructor as `x`/`y`/`width`/`height`. That creates the window on its monitor at that monitor's DPI (native_window_views.cc:276-284). A saved maximized window is created at its normal bounds and maximized in `firstShow()` just before `show()`, so no frame at the smaller size appears. On Windows a hidden window's `maximize()` is one `SW_SHOWMAXIMIZED`; on macOS it zooms before ordering the window in. The page has already laid out at the normal width by then, so a reflow may show. `firstShow()` runs from `ready-to-show`, the 4s fallback, or `bringForward` when a deep link, a second launch or the shortcut comes first.
  - **No creep.** At 125% and 150% on Windows a DIP rect does not survive Chromium's trips to pixels and back, and Electron's constructor makes several, so a window can come out a pixel or two larger than it asked for. main.cjs keeps what it asked for and what `getBounds()` reported straight after (`openedAs`), and `windowStateToSave` saves the second as the first. So an untouched window's file never changes, and only a real move or resize does. The constructor also caps a Windows window at its work area, so a snapped window, whose invisible borders hang about 7px past the work area, reopens up to 7px shorter at the same title-bar position.
  - **The fit rule** (`fitBounds`, `placeWindow`):
    - A window that keeps its size, and whose top 43px band has 200px of width on one work area, opens exactly where it was. That holds partly off an edge and at negative coordinates. A window across two displays is kept only if it fits the one it is mostly on.
    - Otherwise it moves wholly onto the display it overlaps most, or is centred on the primary if it overlaps none.
    - Sizes are clamped to the work area but never below 900x600, with 16px of slack so a snapped window is not moved or shrunk again.
    - A window that had to shrink until it is exactly the work area opens maximized from the default size instead. On a Mac a frame that size already counts as zoomed, so `maximize()` would do nothing and the green button would have no smaller frame to return to.
    - Chromium's placeholder displays (`detected: false`, id -1 or -2, a zero size) are left out, and the primary is taken from the same set. With none left, Electron centres the window at the default size.
  - **Reveal refit.** `bringForward` re-runs the rule on a normal window the shell had parked whose band is out of reach now: one hidden in the tray on a display that has since gone. A window the user can see is never moved. A maximized one is left to the OS (Later).
  - **Not Electron's `windowStatePersistence`.** 44.5.1 has an experimental built-in. It restores after the window exists (native_window.cc:271), the order Electron's own comment says "deflates" a window on a secondary monitor with another DPI (native_window_views.cc:276-284) **[unverified]**; constructor `x`/`y` avoid it. Off the Mac it keeps only 100x100px on screen. It restores full screen together with maximized. It writes through a batched PrefService write that a Windows log-off never flushes. Never turn it on, or set `name` with it, beside this one: two restorers would fight over the window.
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
  - **The find bar's webContents** gets all of these too, and `guardNavigation` and the window-open handler refuse everything from it (v0.1.2, "Find in page").
  - **`content-bounds-updated`** gets `preventDefault()` (v0.1.2). By default Electron applies a page's `window.moveTo`, `resizeTo`, `moveBy` and `resizeBy` to the BrowserWindow (electron_api_web_contents.cc:1628-1633, electron_api_browser_window.cc:124-128). The app never calls them, and with the window's place saved, a move from an XSS would come back at every launch.
- **Fuses**, from the first release (app-builder-lib 26.15.3 out/configuration.d.ts:235, :477-517):
  `runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false`.
  - Without cookie encryption, cookies are stored in plaintext on disk (:481), including Supabase's session and the verifier.
  - Cookie encryption is one-way. Never turn it off once it has shipped.
- **Command-line switches.** In a packaged build, quit at startup if `app.commandLine.hasSwitch` reports any of `remote-debugging-port`, `remote-debugging-pipe`, `inspect`, `inspect-brk`, `host-resolver-rules`, `ignore-certificate-errors`, `ignore-certificate-errors-spki-list`, `proxy-server`, `proxy-pac-url`, `disable-web-security`, `log-net-log`, `net-log-capture-mode` or `ssl-key-log-file`, or if the `SSLKEYLOGFILE` environment variable is set. The list and the check are `BLOCKED_SWITCHES` / `blockedLaunch` in lib/policy.cjs, so the policy test locks them. **[unverified: whether Chromium acts on any of these before main runs]**
  - A review ran the later five against Electron 44.5.1: a net log in `Everything` mode writes the sb-* cookie values in plaintext, a key log (switch or env) decrypts any packet capture, an SPKI allow-list turns certificate checks off for that key, and a PAC URL routes the window through any proxy. The DevTools port opens only after main's synchronous code, so the exit at module load does beat it.
  - No switch list is complete. This is defense in depth for the macOS keychain-bound cookie key, not a boundary: a same-user process has other routes (an unhardened ad-hoc build, the unverified HTTP and service-worker caches in userData).
- **Menu.** Install a custom, minimal menu.
  - macOS must have the Edit roles, or ⌘C/V/X/A stop working in text fields.
  - Keep View's zoom items, because the app hands Ctrl+=/−/0 back to the browser outside the week views (lib/commands/registry.ts:769-819). They are click items with the roles' labels, accelerators and half-level step, never the zoom roles: a role zooms whatever has focus without main hearing of it, and the Mac buttons follow the page's zoom ("Page zoom" under Frame).
  - Edit gets Find (⌘F / Ctrl+F), Find Next and Find Previous (⌘G / Ctrl+G, with Shift for Previous) right after Select All (v0.1.2). On a Mac they sit in a Find submenu with a hidden Control+F; on Windows hidden F3 and Shift+F3 come too. See "Find in page".
  - Show DevTools only when `!app.isPackaged`.
  - On Windows, set `autoHideMenuBar: true`.
  - Never use `before-input-event` for app shortcuts. A menu accelerator fires only for a key the page left unhandled, on macOS and Windows alike, so the page's own bindings always win; `before-input-event` comes before the page.
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
  - The close closes the find bar and saves the window's place first, while the window is still on screen, then parks it (`park()`). See "Size and place" and "Find in page".
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
- **Tray menu:** New task (same as the shortcut), Open dsul, Update available (when one is known), Open at login (packaged builds; see "Open at login"), Quit. macOS uses a template image.
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

## Open at login (v0.1.2)

A checkbox in the tray menu, on macOS and Windows. It starts unticked. Ticking it registers dsul with the OS, and a login launch then opens dsul like any other launch, window included. The rules are in electron/lib/login-item.cjs, which is pure and tested; main.cjs only reads, writes and keeps the box current. Electron source lines below are from the v44.5.1 tag.

- **Tray only.** The tray is the shell's one native menu on both platforms. The macOS app menu stays `{ role: 'appMenu' }` (Later). There is no bridge method and no web change: a switch the page could reach would let an XSS make dsul start at every login.
- **The box shows what dsul registered, read back, never what dsul last asked for.** Electron hears nothing when macOS holds or refuses a registration (browser_mac.mm:397-406 drops the result; platform_util_mac.mm:213-224 only logs the error), and the user can switch it off elsewhere without dsul hearing.
  - macOS: SMAppService.mainAppService's `status`, ticked only for `enabled` (platform_util_mac.mm:197-211). Electron 44 needs macOS 13, so it is always SMAppService.
  - Windows: `executableWillLaunchAtLogin`, the only field that sees Task Manager's StartupApproved "Disabled" (browser_win.cc:187-264). `openAtLogin` compares only the HKCU value's exact text.
  - It is not quite "what the OS will do at login". Windows reads only the HKCU and HKLM Run keys, so a dsul shortcut in shell:startup shows unticked. macOS reads only the main app's SMAppService status, so dsul added by hand with + in Login Items may show unticked **[unverified]**.
- **Electron's space-in-path quirk.** Read with no options, `executableWillLaunchAtLogin` parses the bare `process.execPath` as a command line, which ends at the first space (browser_win.cc:194-199; Chromium 152 base/command_line.cc). Under a profile such as `C:\Users\First Last\` it would never match the quoted Run value Electron itself writes: the box would never tick, and every click would turn it on again. So main reads with `loginItemQuery`, which passes the path quoted on Windows only. A quoted path parses whole (:200-203), and Electron strips the quotes again where it compares the HKCU text (:164-169).
- **Keeping the tick current.** Both OSes read a menu item's tick as the menu opens (macOS in `menuNeedsUpdate:`, Windows as it builds the views menu), and `menu-will-show` comes after that on both. So main changes the existing item, found by `LOGIN_ITEM_ID`, at cheap moments: after every toggle, on the window's `focus`, and on the tray's `mouse-enter` (macOS and Windows; on Windows the enter is queued ahead of the click that follows it, notify_icon_host.cc:59-150). A re-read within 500ms of the last is skipped, since each macOS read is a call into the system's login item service. The menu is never rebuilt for this, because on macOS that could pull an open menu out from under the user, and `setContextMenu` stays on every platform.
  - A stale tick is harmless. Electron flips a checkbox before its click runs, so a click asks for the opposite of what the box showed, which is what the user meant, and the read-back then shows the truth.
  - A keyboard open of the Windows tray (Win+B, then Shift+F10) has no event before it, so it can show a tick that went stale while dsul sat in the background.
  - A read that throws shows no box when the menu is built, and keeps the last good tick when the box is only refreshed.
- **macOS: a tick that didn't take opens Login Items.** If the read-back after ticking is not `enabled`, main opens System Settings > General > Login Items (`x-apple.systempreferences:com.apple.LoginItems-Settings.extension`). That covers a login item macOS holds for approval (`requires-approval`, if mainAppService can reach it at all) and a registration refused outright, which Electron's docs warn an app that isn't signed and notarized can get (docs/api/app.md:1491-1494). There the user can allow dsul, or add it with +. A held login item can't be withdrawn from dsul, because a click on the unticked box asks again; it is withdrawn in System Settings.
- **Hidden in dev builds**, which would register the bare Electron binary.
- **Greyed out on macOS outside Applications.** `app.isInApplicationsFolder()` is false on the mounted disk image and for a translocated copy: one opened where it was downloaded, or a quarantined copy put into /Applications without Finder (electron_bundle_mover.mm:102-127). Each would register a path that is gone by the next login. The box still shows the true status, disabled, with the line "Open dsul from Applications to use this" under it.
- **What Windows writes.** HKCU `Software\Microsoft\Windows\CurrentVersion\Run`, value `app.dsul.desktop`, holding the quoted, expanded path of the installed dsul.exe (by default `C:\Users\<you>\AppData\Local\Programs\dsul-desktop\dsul.exe`) with no arguments (browser_win.cc:664-699). The value is named after `APP_ID`, which is also the config's `appId` (electron-builder.config.cjs:15) and NSIS's `${APP_ID}`; a test holds the three together. Ticking also clears a Task Manager "Disabled", since `enabled` defaults to true, and unticking deletes both values.
- **Uninstall and update.** `customUnInstall` deletes the Run value and its StartupApproved twin, but not during an update: the old uninstaller runs with `--updated`, and nothing would write them back. Nothing else in electron-builder's NSIS templates touches `CurrentVersion\Run`.
  - Downgrading: installing 0.1.1 over 0.1.2 runs 0.1.2's uninstaller with `--updated`, so the Run value stays, and 0.1.1 has neither the box nor the cleanup. Untick before downgrading, or switch dsul off in Task Manager > Startup apps.
  - macOS has no uninstaller. Trashing dsul.app may leave a Login Items entry until macOS prunes it.
- **A login launch is an ordinary launch.** The window shows, because for a planner "Open at login" means "show me my day". macOS can't reliably tell a login launch apart (`wasOpenedAtLogin` is **[unverified]** for SMAppService), and Electron 44 removed the hidden-launch fields. If the network isn't up yet, the 4s show fallback and the offline page's retries cover it, and the update check tries again once the app is back ("Updates"). Start in the tray is Later.
- **Ad-hoc Mac builds may not register at all** (Electron's warning above), and a registration may not survive an update, since each ad-hoc build has a new code hash **[unverified]**. The read-back shows either as a box that won't stay ticked, and the Login Items pane opens.
- **Packaging.** `files` already packs `lib/**` (electron-builder.config.cjs:22-30). No entitlement or Info.plist change.

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
  - `!macro customUnInstall` (uninstaller.nsh:156-157) runs `DeleteRegKey HKCU "Software\Classes\dsul"`, and deletes Open at login's Run value and its StartupApproved twin (v0.1.2), all skipped during an update.
  - Packaged builds also call `setAsDefaultProtocolClient('dsul')`, to repair the key if it goes missing.
  - Dev builds register only when `DSUL_DEV_PROTOCOL=1`. Doing so overwrites the installed app's key, so relaunch the installed app afterwards.
  - Read exactly one argv entry that starts with `dsul:` (from `second-instance` or `process.argv`), and ignore every other argument. **[unverified: Electron's own guard against switches after a URL argument]**
- Queue a link until the window has loaded.
- Test deep links on packaged builds only.

## Find in page (v0.1.2)

Ctrl+F on Windows, or ⌘F on a Mac, opens a small find bar at the window's top-right corner. Chromium's find bar is browser UI, so Electron ships none. The shell's is a page of its own, `find-bar.html`, shown as a data: URL in a `WebContentsView` over the page. Electron 44.5.1 and Chromium 152 line numbers below are from those sources.

- **Why it is not in the page.** Blink's find counts `<input>` values (find_buffer.cc:66-86), so a bar inside do.dsul.app would match its own query. It would also need a bridge method to reach `findInPage`, which an XSS could call, and a web release with feature detection for 0.1.1 shells. The separate view needs none of that, and no web change: a 0.1.1 shell just doesn't have find.
- **Keys.** Find, Find Next and Find Previous are Edit-menu accelerators (`findMenu` in lib/find-bar.cjs), never `before-input-event`. Electron checks no accelerator before the page sees a key, and offers the menu only keys the renderer did not consume (electron_api_web_contents.cc:1659-1723; on a Mac, electron_api_web_contents_mac.mm:37-90 after render_widget_host_view_cocoa.mm:1344-1376). So the settings search (settings-shell.tsx) and the Organize filter (organize-console.tsx) keep their own Ctrl/⌘ F, exactly as in a browser, and Edit > Find still opens the bar there.
  - In the bar, Enter and Shift+Enter step through matches and Esc closes it (find-preload.cjs). Esc in the page stays the page's (its dialogs, Organize's escape ladder).
  - Ctrl/⌘ G and Shift+Ctrl/⌘ G step from the bar or the page; with the bar closed they open it on the last search. Ctrl/⌘ F with the bar open selects its text.
  - Windows also gets hidden F3 and Shift+F3 (a Mac's F3 is Mission Control). Electron registers a hidden item's accelerator with no visibility check (accelerator_util.cc:74-104).
  - A Mac also gets a hidden Control+F, because Kirby reaches for Ctrl, and the page's own Ctrl/⌘ F handlers (the settings search, the Organize filter) take either key; the shortcut dispatcher leaves macOS Control to the text system (lib/commands/keys.ts). In a text field Ctrl+F is Cocoa's move-forward, which the page handles first, so it should never open find there **[unverified]**.
  - Ctrl/⌘ +, − and 0 pressed in the bar zoom the page, not the bar, because the View zoom items act on `win.webContents` ("Page zoom" under Frame). The bar takes no zoom keys of its own.
  - The page gets the key first, so keys typed within the page's reply to Ctrl/⌘ F still reach it, as in Chrome. Under xvfb a key sent 10ms after Ctrl+F already went to the bar; one sent at once did not.
- **Made ahead of time.** The view is made hidden on the page's first `did-stop-loading` and kept, so the first Ctrl/⌘ F shows it at once. If the press beats it (a page still loading, or a bar whose renderer has gone, which reloads on the next press), the bar is shown and takes the keyboard before its page has loaded, so what is typed meanwhile is lost rather than reaching the page's one-key shortcuts (`n` opens Add, Backspace deletes the hovered item). One renderer process stays for the session.
- **A closed bar never keeps the keyboard.** Made as the window first comes to the front, the hidden bar was handed the focus in about half of the Linux launches, and nothing typed would have reached the page. `keepKeysOffClosedBar` hands it back, from the bar's `focus` and the window's, once the focus change has finished and only while the window has focus.
- **Closing.** Every close ends with `stopFindInPage('clearSelection')`, the person's Esc and × included. Chrome's Esc keeps the match selected, and if the match is in a field, button or link that element takes focus (find_in_page.cc:183-210, text_finder.cc:368-440): the next key typed would then replace a matched title in a field that autosaves. `activateSelection` would also click it, so neither is used, and a test pins that.
  - The shell closes the bar on a cross-document navigation (the offline page included), a page crash, a quick capture, and the window's close to the tray or Dock.
  - The close runs in the close handler, before `win.hide()` or the full-screen exit, while the window is still on screen and key. Never on `hide`, which on macOS fires whenever the window is merely out of sight. So ⌘H, minimize, another Space, a covering window or a screen lock leave the bar open with its match.
  - If the bar had the keyboard, the page takes it back before the bar is hidden (hiding a view moves the focus nowhere), and never in a hidden window, because focusing the page brings a Mac window forward. A quick capture focuses the page whether or not the bar had it, since a Mac window coming forward can hand the focus back to the bar.
  - The bar's own `render-process-gone` ignores a clean exit and moves the keyboard only if the bar was open.
- **Placement.** 360×44 DIPs, 16 in from the right and 8 below the top of the content area.
  - On macOS it sits below the 43px band (y 51). The page's band is the window's drag region and the page answers the non-client hit test before a child view does (electron_api_web_contents_view.cc:94-127; native_window.cc:747-779), so a bar inside the band would drag the window. Blink reads `env(titlebar-area-*)` as the overlay's rect over the zoom, rounded outward (local_frame.cc:3519-3540), so the band is ceil(43 / zoom) CSS px, under 43 + zoom DIPs (about 47.3 at the menu's 430%, under 48 at Chromium's 500% ceiling), and the 8 DIPs below it absorb that. In macOS full screen the band is gone, so the bar goes to y 8, and it is placed again on `enter-full-screen` and `leave-full-screen`, which pass the new state rather than trust `isFullScreen()` yet.
  - On Windows the content area starts under the native frame, so y 8. `bounds-changed` on the content view places it again on every resize, including the auto-hidden menu bar appearing **[unverified]**.
  - It steps aside for the active match by Chrome's rule (`avoidMatch`; find_bar_host.cc GetLocationForFindBarView): a match under the bar moves it to the match's left, 5 DIPs clear, unless that would take it off the left edge. found-in-page's `selectionArea` is in the bar's units: DIPs from the page's top-left with the page zoom in them, because Blink divides the root-frame rect by the device scale factor and nothing else (find_in_page.cc ReportFindInPageSelection), which is how Chrome's bar reads it. The xvfb run at scale 2 and 150% zoom matched the match's own rect. The rect can be from before Blink scrolls the match into view, which it does in a later animation-frame task (text_finder.cc), so the bar steps aside only for a match already on screen; one the find scrolls to lands centred where it can. A resize puts the bar back in its corner until the next step, as Chrome's does.
- **Look.** OS light or dark through nativeTheme, like offline.html, not dsul's own Theme setting. `--bg` in find-bar.html is `FIND_BAR_BG` in lib/find-bar.cjs, and main paints the view with it (and again on `nativeTheme` `updated`): change one, change both. Corners are `setBorderRadius(10)`. Role search, a labelled field, a count with role status and aria-live polite, labelled buttons.
- **Isolation.**
  - The bar runs no script (CSP `script-src 'none'`, `default-src 'none'`, so it loads nothing). find-preload.cjs is sandboxed, so it cannot require its own files, only `electron` and a few Node built-ins (`events`, `timers`, `url`: sandboxed_renderer/init.ts:26-39). It requires only `electron`, wires the bar from its isolated world and exposes nothing.
  - `harden()` covers its webContents, since `web-contents-created` fires for it. `guardNavigation` refuses every navigation from it first: without that an app URL would pass, and the offline-retry branch would load the app into the bar. The window-open handler opens nothing for it. `isFindBar` is asked at event time, because `harden` runs inside the view's constructor.
  - Its data: URL is never `isApp`, so every permission is denied. Its three IPC channels (`dsul-find:query`, `:step`, `:close`) answer only `fromFindBar`: the bar's own top frame at `FIND_URL`, as `fromApp` does for the page. The query is capped at 500 characters.
- **What the page sees.** Each find step clears the page's focused element (text_finder.cc, "Make sure no node is focused"), as in Chrome, so a field being edited blurs, and autosaves, when a search runs. Same-document route changes fire no `did-navigate`, so the bar stays open over a new route with a count that refreshes on the next keystroke or step, as in Chrome. Find sees only what is in the DOM: virtualized or collapsed content isn't found.

## Packaging and signing

Use electron-builder 26.15.x: not the 27 alpha, and not Forge, which has no NSIS maker. Use electron ^44.

- **Identity (permanent once shipped).** `appId: app.dsul.desktop`, `productName: dsul`. These become the macOS bundle id, the Windows AUMID and the NSIS GUID.
- **Layout.** `directories: { output: release, buildResources: build }`. `files`: main.cjs, preload.cjs, find-preload.cjs, lib/**, offline.html, find-bar.html, build/tray*. It is an allow-list: a file main.cjs loads but `files` leaves out works under `electron .` and fails only in the installed app, which is why electron-find-bar.test.ts checks every file main.cjs loads against it.
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
  - A launch at login usually beats the network, so the launch's check fails and the next one would be a day away (v0.1.2). When an app URL commits after the offline page, `did-navigate` checks again (at most one extra request per offline episode, and a failed or unchanged answer leaves the tray alone). It reads the offline count before `stopOfflineRetry` clears it.
  - Rebuild whenever Electron ships a security release for 44, and move to a newer major before 44 leaves support **[unverified: Electron's support window]**.
- **Later: a web banner.** Shown only in the desktop app, when `shellVersion` is below a minimum the site sets.
- **Later: `electron-updater`, only once builds are signed.** For unsigned builds, latest.yml's sha512 comes from the same release an attacker would publish, and `verifyUpdateCodeSignature` has no publisher name to check (out/options/winOptions.d.ts:33-39, :115-119). Before any updater ships:
  - keep `verifyUpdateCodeSignature: true`;
  - pin `win.publisherName`;
  - protect `v*` with a tag ruleset;
  - turn on GitHub immutable releases;
  - consider a separate releases repo that only the release workflow can write to.

## App icon

The Wave mark (Kirby's pick, 2026-10-01; the web icons switched in #349). `scripts/app-icon/build.mjs --native <dir>` renders the native files; a copy is in the project's shared folder at `app-logo/icons/`, with a README saying where each goes.
- **macOS:** `electron/build/icon.png` is `macos/AppIcon-dark.iconset/icon_512x512@2x.png`, the 1024px tile already drawn on Apple's grid (824px rounded tile with a shadow), so the Dock shows a proper squircle. electron-builder derives the .icns from it. A light/dark pair needs Icon Composer on a Mac (Later).
- **Windows:** `electron/build/icon.ico` is `windows/icon.ico` (16 to 256).
- **Tray:** `build/tray.png` and `tray@2x.png` are `public/icons/icon-16.png` and `icon-32.png` on Windows; macOS gets `trayTemplate.png` / `trayTemplate@2x.png`, the 3×3 dot grid in black on transparent, so the menu bar tints it.
- Don't touch public/icons.

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
- **`electron-window-state.test.ts`**, which imports `electron/lib/window-state.cjs` (zero imports):
  - `parseWindowState` round-trips `serializeWindowState` and refuses 23 corrupt or foreign texts and five non-strings;
  - `displayAreas` drops `detected: false`, ids -1 and -2, zero sizes and junk, and takes the primary only from what is left;
  - `fitBounds` leaves a fitting window alone (negative coordinates, half off an edge, Aero snap) and moves, shrinks or centres the rest, including the two-display, unplugged, 150%, tiny-size and small-work-area cases;
  - `placeWindow` keeps the maximized flag, and opens maximized from the default size a window that had to shrink to exactly the work area;
  - `windowStateToSave` skips full screen and minimized, picks the restore rect per platform, and saves what the window got as what it asked for, so five simulated 125% launches leave the file byte-identical;
  - a seeded walk of 3000 saved rects over six layouts: every placement is at least 900x600, grabbable, and the same at the next launch;
  - `BAND_PX` equals window-chrome's `TITLE_BAND_PX`;
  - its `main.cjs` describe block holds text locks on the main.cjs lines CI can't run (the test file is the list).
- **`electron-window-chrome.test.ts`**, which imports `electron/lib/window-chrome.cjs` (zero imports):
  - the macOS window options, and the page's numbers (the band, the wordmark's `- 35px`, the status line) held to the shell's;
  - `macLights(1)` is `MAC_LIGHTS`; pinned places at the common zooms and the menu's steps; y held below 67% while x keeps following; an unreadable zoom gives the 100% place;
  - over the whole zoom range: a 14-16pt button centred within 1pt on the zoomed row up to 127%, every button inside the 43pt overlay, the word and the status text 12-15 CSS px past the green button (11-16 below 67%), and clear of the expand zone;
  - its `main.cjs` describe block holds text locks on the main.cjs lines CI can't run (the test file is the list).
- **`electron-login-item.test.ts`**, which imports `electron/lib/login-item.cjs` (zero imports):
  - nothing is offered in a dev build, on Linux, or without a reading;
  - macOS ticks only for `status: 'enabled'` (never from `openAtLogin`), and outside Applications shows the true status greyed out with "Open dsul from Applications to use this";
  - Windows ticks from `executableWillLaunchAtLogin`, so a Task Manager disable reads unticked;
  - `loginItemQuery` quotes a Windows path with a space and asks nothing elsewhere; `loginItemRequest` is exactly `{ openAtLogin }` on macOS and `{ openAtLogin, name: APP_ID }` on Windows;
  - `showLoginItemsPane` is true only for a macOS tick that read back unticked;
  - its `main.cjs` describe block holds text locks on the main.cjs lines CI can't run (the test file is the list).

- **`electron-find-bar.test.ts`**, which imports `electron/lib/find-bar.cjs` (zero imports):
  - `barBounds` hangs the bar from the top-right corner below the band (or at the top, off the Mac and in full screen), never negative, with room for the band's outward rounding; `avoidMatch` follows Chrome's rule and ignores empty or junk rects; `countLabel`, `isCurrentReply` and `cleanQuery`;
  - `findMenu` per platform (the hidden Control+F on a Mac, hidden F3 elsewhere, no Escape anywhere) and `findMenuPlace` against Electron's own editMenu items for each platform;
  - find-bar.html runs no script and loads nothing, matches `FIND_BAR_BG` and labels every control;
  - find-preload.cjs, run against that markup with a stand-in ipcRenderer: it requires only electron, sends each edit, Enter, Shift+Enter, Esc and button, leaves a composing input method alone, and leaves Find's own keys and the zoom keys to the menu;
  - its `main.cjs` describe block holds text locks on the main.cjs lines CI can't run (the test file is the list).

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
- **Resilience.**
  - An offline launch shows the offline page and recovers.
  - Sleep and wake.
  - The push row shows the desktop copy.
  - Uninstalling removes `HKCU\Software\Classes\dsul`, and Open at login's Run value and its StartupApproved twin (v0.1.2).
- **Window size and place (v0.1.2).** On macOS the window closes with the red light (there is no ⌘W) and comes back with ⌘⇧Space, the Dock or the tray. On Windows it closes with X and comes back with Ctrl+Shift+Space or the tray.
  - Both, first launch: delete `window-state.json` (`%APPDATA%\dsul\`, `~/Library/Application Support/dsul/`). The window opens 1280x860, centred.
  - Both: move and resize, close to the tray, Quit from the tray, relaunch. Same place and size. Relaunch three more times without touching it: `window-state.json` must not change, byte for byte or in its timestamp.
  - Windows at 125% and again at 150%: relaunch five times untouched. The file stays byte-identical (the creep check).
  - Windows: maximize, Quit from the tray, relaunch. It opens maximized with no frame at the smaller size; note any reflow of the page. Un-maximize: it returns to where it was before maximizing.
  - Windows: maximize, close with X, Quit from the tray, relaunch. It opens maximized.
  - Windows: taskbar on top, then on the left. Maximize, Quit, relaunch, un-maximize: exactly the pre-maximize rect, and the file unchanged across a second relaunch.
  - Windows: snap left with Win+Left, Quit, relaunch. Same title-bar position and width as a normal window; the bottom edge may sit up to about 7px higher.
  - Windows: minimize a maximized window, Quit from the tray, relaunch. It opens maximized.
  - Windows: View > Toggle Full Screen, Quit from the tray, relaunch. It opens as it was before full screen.
  - Windows: move the window and close it with X within half a second. Quit, relaunch: the moved place (the close saves at once).
  - Windows, second monitor, ideally left of the primary and at a different scale: move the window there, Quit, relaunch. It opens there at the right size, not shrunk. Maximize it there, Quit, relaunch: maximized on that monitor.
  - Windows: Quit, disconnect that monitor, relaunch. It opens centred on the primary with its title bar grabbable, and maximized if it was larger than the primary's work area both ways.
  - Windows: raise the primary's scale to 150% or lower its resolution, relaunch. It fits the work area and nothing is under the taskbar.
  - Windows: with the window on the secondary, close it to the tray, disconnect that monitor, press Ctrl+Shift+Space. It appears on the remaining monitor and can be grabbed. Note whether Windows had already moved it, and whether it came back shrunk (if so, `setBounds` twice, electron#10862).
  - Windows: move the window, wait a moment, then sign out. The sign-out is not held up by dsul. Sign in and launch: the moved place, and `window-state.json` is valid JSON. The move was already saved 500ms after it ended, so this does not exercise the `session-end` write; the order inside that handler is held by the unit text lock. To exercise the write itself, run `timeout /t 5 && shutdown /l` in a terminal, then keep dragging the window until the sign-out lands. It should reopen roughly where the drag was.
  - Windows: corrupt the file (delete its last character), launch. It opens at the default, and after Quit the file is valid JSON again.
  - Windows dev build (`npm start` in electron/): it writes `%APPDATA%\dsul-dev\window-state.json` and never touches the installed app's file.
  - Mac: move and resize, ⌘Q, relaunch: same frame. Three more relaunches: no change.
  - Mac: Window > Zoom (or Option-click the green light), ⌘Q, relaunch. It opens zoomed with no frame at the smaller size; note any reflow. Window > Zoom again returns to the pre-zoom frame, not a stale or tiny one.
  - Mac: move or resize first, then zoom with the green light, ⌘Q, relaunch, unzoom. It returns to the moved frame.
  - Mac: zoom, close with the red light, Quit from the tray, relaunch. It opens zoomed. Repeat with a log-out while the window is closed to the tray.
  - Mac: full screen with the green light, ⌘Q while full screen, relaunch. A normal window at the pre-full-screen frame on the desktop Space, with no black Space.
  - Mac: full screen, red light (it leaves full screen and hides), Quit from the tray, relaunch. The pre-full-screen frame.
  - Mac with an external display: put the window there, ⌘Q, unplug, relaunch. It is on the built-in display with the lights and band below the menu bar. If the window had been bigger than the built-in display, it opens zoomed, and Window > Zoom twice must not collapse it.
  - Mac: zoom on the external display, ⌘Q, relaunch. It opens zoomed on the external display, not the built-in one.
  - Mac: arrange the external display above the MacBook (negative y), put the window there, relaunch. It opens there. Leave it partly off the right edge with the band visible, relaunch: exactly there.
  - Mac: close to the tray with the red light, unplug the external display it was on, reveal with ⌘⇧Space or the Dock. It appears on the built-in display. Repeat with the window zoomed and note where it appears (a zoomed window is not refitted).
  - Mac: move the window, log out with dsul running. The log-out is not held up. Log in and launch: the moved frame. The debounce saved it, not `before-quit`.
  - Mac: move the window and press ⌘Q within half a second, relaunch: the moved frame (the `before-quit` save).
  - Both, cold start with a maximized window saved: open through a magic link, through tray New task in the first second, with a second double-click of the shortcut (Windows) and with a Dock click (Mac). It opens maximized and never jumps from the smaller frame.
  - Both: the drag band still drags the window, and the traffic lights and caption buttons sit where they did.
- **Page zoom and the traffic lights (v0.1.2).** Run a dev shell against a LOCAL stack (`DSUL_URL=http://localhost:3000 npm start` in electron/ after `scripts/local-setup.sh dev`), or the packaged build. Read the overlay in DevTools with `navigator.windowControlsOverlay.getTitlebarAreaRect()`.
  - Mac, first and before any zoom: Classic layout, sidebar open, 100%. The buttons sit exactly where 0.1.1 put them, the rect's height is 43 and its x about 128-136 (74 plus the buttons' group width, 54-62), and each button answers a click. If not, stop: everything below rests on this geometry.
  - Mac: View > Zoom Out to about 91%, 83%, 76% and 69%, then Zoom In to about 110%, 120%, 131% and 158%. At each step the buttons move at once. Up to 120% their centre is on the wordmark row's midline; from 131% they sit just above it. The word always starts about 14px after the green button and never under it, and the rect's x is about (2 × round(37 × zoom) + group width) / zoom.
  - Mac at 131% and 158%: the bottom edge of each button is fully drawn and clickable. If it is cut off, the buttons are taller than 16pt and `LIGHTS_Y_MAX` must come down to 43 minus their height.
  - Mac keyboard: ⌘= (no Shift), ⌘⇧=, ⌘− and ⌘0 behave like the menu items. In a week view ⌘= scales the day columns and the buttons don't move.
  - Mac: trackpad pinch and Ctrl+scroll don't change the page zoom or move the buttons.
  - Mac: zoom to 120%, Quit from the tray, relaunch. On a normal network the window appears with the page at 120% and the buttons already in place, with no jump after it shows.
  - Mac: at 120%, turn Wi-Fi off and relaunch (a packaged build has no Reload). The offline page is at 100%, unless it was zoomed while offline, with the buttons at 100%'s place. Zoom the offline page once: the buttons move. Turn Wi-Fi on: the app comes back at 120% and the buttons move back.
  - Mac full screen at 120%: the buttons appear normally in the menu-bar strip. Zoom in or out while in full screen, then leave it: the buttons land at the new zoom's place with no flash or jump. Close with the red light while in full screen: the window leaves full screen and hides; reopen it from the tray and the buttons are right. Press ⌘= straight after clicking the green button, while full screen is still animating in, and note any jump.
  - Mac: click another app. The buttons grey out but don't move, and stay put when you come back. Resize the window and switch light and dark: they stay put.
  - Mac at about 63% (Zoom Out ×5, the first step where y holds at 11) and 144% (Zoom In ×4): click each button near its lower edge (close hides to the tray, minimize, the green zoom), hover for the glyphs, and drag the window by the top band. At 63%, click the top edge of the date capsule's calendar button, just below the band: it reaches the page.
  - Mac, sidebar collapsed: from 91% to 120% the buttons sit inside the canvas card's rounded top-left corner. At 67-83% the close button may touch the card's border, and at 158% and 207% the buttons cross the card's top edge; both are expected. Check that nothing in the card's top-left is covered there.
  - Mac, Console layout at 110%, 131% and 158%: the status text starts about 14px after the green button and sits a few points above the buttons' centre (expected until the status-line change in Later).
  - Mac: /settings, /ledger and an item page at 63% and 144% all start below the buttons. A 900pt-wide window at 131% (Zoom In ×3) shows the mobile shell, with the buttons in the top strip clear of its header.
  - Both: with find open and its field focused, ⌘/Ctrl+= zooms the page, and the find bar stays at 100% now and after a relaunch.
  - Mac, dev build only: with DevTools focused, ⌘= zooms the page, not DevTools.
  - Windows: press Alt to show the View menu. Actual Size is Ctrl+0, Zoom In is Ctrl+Plus, Zoom Out is Ctrl+−, and Ctrl+= zooms in without Shift. Each step is about 9.5%, as in 0.1.1. Ctrl+wheel still does nothing. In a week view Ctrl+= scales the columns only. The zoom survives a relaunch, the window frame is unchanged, and nothing errors (the macOS-only button calls are never made off the Mac).
- **Find in page (v0.1.2).** A packaged build, or a dev shell against a LOCAL stack. On macOS the window closes with the red light (there is no ⌘W) and comes back with ⌘⇧Space, the Dock or the tray.
  - Mac, planner: ⌘F opens the bar top-right, just below the title band and clear of the traffic-light row; typing shows "N of M"; Enter and ⇧Enter step. Every part of the bar (field, ‹ › and ×) answers a click, and the empty band to its left still drags the window. Repeat at 110% and 300% page zoom.
  - Mac: ⌘G and ⇧⌘G step from the bar and from the page; with the bar closed, ⌘G opens it on the last search. Edit shows Find › Find…, Find Next, Find Previous right after Select All, before Substitutions and Speech.
  - Mac: Ctrl+F outside a text field opens find. Ctrl+F in the omnibar moves the caret one character; note whether it ALSO opens find there.
  - Mac: in Settings, ⌘F and Ctrl+F focus the settings search and the bar does not open; Edit > Find > Find… still opens it there. In Organize, ⌘F focuses the pane filter; in a pane without one, ⌘F opens the bar.
  - Mac: Esc in the bar closes it, nothing stays highlighted or selected, and typing goes to the page. Repeat with the match inside the docked item panel's title: Esc, then type a letter; the title must be unchanged. Esc with the page focused (an open dialog) is the page's, and the bar stays.
  - Mac: with the bar open, ⌘H and back, minimize and back, switch Spaces and back, cover the window with another app's, and lock the screen and unlock: each time the bar is still open with its match. Close with the red light (also from full screen): reopen, and the bar is closed, nothing is highlighted and typing goes to the page.
  - Mac: ⌘Tab away and back with the bar focused, and note where the keyboard is.
  - Mac: open the bar, then enter and leave full screen with the green light: in full screen it sits 8pt from the top; out of it, back below the band.
  - Mac, right after launch: press ⌘F and type at once. Nothing happens in the page (no Add dialog from `n`). Then, at rest after launch, the keyboard is in the page: `n` opens Add.
  - Mac: with the bar focused, ⌘= and ⌘− zoom the page and the bar stays at 100% (also in "Page zoom" above). ⌘⇧Space quick capture closes the bar and the launcher gets the keyboard.
  - Mac: switch System Settings > Appearance; the bar recolours live. Force dsul's own Theme opposite to the OS: the bar follows the OS (known, Later).
  - Mac: VoiceOver reads "Find in page, search field", announces "3 of 12" and "No results", and names Previous, Next and Close. A Japanese IME composing in the bar: Enter commits without stepping, Esc cancels the composition without closing the bar.
  - Both: with the docked item panel open, search for a word in its title. The bar steps left of the match rather than covering it; note anything else of the panel's top rail it covers.
  - Windows: Ctrl+F opens the bar 8px under the frame at the top-right; Alt shows the menu bar and the bar stays 8px under it. Edit shows Find…, Find Next and Find Previous with Ctrl labels after Select All, and no F3 rows.
  - Windows: Ctrl+G, Shift+Ctrl+G, F3 and Shift+F3 step from the bar and from the page. In Settings Ctrl+F focuses the settings search; in Organize, the filter; elsewhere it opens find.
  - Windows: Esc and × close the bar and return the keyboard to the page; Ctrl+F with the bar open selects its text. With the bar focused, Alt+Tab away and back: note where the keyboard is (Electron leaves it in the bar), and Esc still closes it.
  - Windows: close to the tray with X while the bar is open, then reopen from the tray: no bar, nothing highlighted, typing goes to the page. Minimize and restore with the bar open: it is still open.
  - Windows: resize, maximize and Snap; the bar stays 16px from the right edge. Rounded corners and Segoe UI at 100% and 150% display scaling. Right-click in the field: Cut, Copy and Paste work. Narrator reads the field, the live count and the button names.
  - Both: after a page renderer crash and its reload, Ctrl/⌘ F works again. On the offline page Ctrl/⌘ F does nothing.
- **Open at login (v0.1.2).** Packaged builds; a dev run (`npm start`) shows no Open at login item on either platform and writes nothing.
  - Windows: install the NSIS build. Right-click the tray: New task, Open dsul, a separator, Open at login (unticked), a separator, Quit. Every item works, and a left click still brings the window forward.
  - Windows: tick it. In regedit, `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` has `app.dsul.desktop` = the installed dsul.exe's quoted path, no arguments. Task Manager > Startup apps lists dsul as Enabled, and Settings > Apps > Startup shows it On. Note any Windows notification about a new startup app.
  - Windows: while dsul runs, disable dsul in Task Manager > Startup apps, then point at the tray icon and right-click: unticked. Re-enable it there, point and right-click: ticked (this checks Electron's reading of the re-enabled StartupApproved value). Disable it again, then tick in dsul: Task Manager shows Enabled.
  - Windows: change it in Task Manager, then open the tray menu from the keyboard (Win+B, arrow to dsul, Shift+F10). Note whether the tick is stale; if it is, clicking it still does what the click asks (see "Keeping the tick current").
  - Windows, a path with a space: install with `dsul-setup.exe /D=C:\dsul test\dsul` (or copy `release\win-unpacked` to `C:\dsul test\`). Tick: the box stays ticked. Untick: it clears and the Run value is gone. Disable in Task Manager: it reads unticked.
  - Windows: with the box ticked, sign out and back in. dsul starts once and the window shows (an offline page that recovers by itself is fine), the tray is there, and the shortcut works. If a newer release exists, the tray offers it within a minute of the app coming back.
  - Windows: untick. The Run value and `StartupApproved\Run\app.dsul.desktop` are both gone, and Task Manager no longer lists dsul.
  - Windows: with the box ticked, run the next version's dsul-setup.exe over the install. The box is still ticked and the Run value unchanged.
  - Windows: with the box ticked, uninstall from Settings > Apps. Both values and `HKCU\Software\Classes\dsul` are gone, and Startup apps no longer lists dsul.
  - Windows: put a dsul shortcut in shell:startup with the box unticked. Note what the box shows (expected: unticked), then tick it too and count the windows after sign-in (expected: one; the second launch only brings it forward).
  - Mac: open dsul straight from the mounted DMG, and from a quarantined copy left in ~/Downloads. The tray shows Open at login greyed out, with "Open dsul from Applications to use this" under it. Repeat with a quarantined copy put into /Applications with `ditto`, and record what it shows.
  - Mac: launch from /Applications. The dsul app menu is unchanged (About, Services, Hide, Hide Others, Show All, Quit), and the tray shows the unticked box.
  - Mac: tick it in the tray. Record whether it stays ticked on the next open, whether macOS posts a notification, and whether System Settings > General > Login Items lists dsul under Open at Login. If it reads back unticked (held for approval, or refused because the build is ad hoc), System Settings should open on Login Items; after allowing or adding dsul there, pointing at the tray icon shows it ticked. If the pane opens on another page, record the macOS version.
  - Mac: remove dsul from Login Items while dsul runs. Point at the tray icon and click: unticked. Repeat, then right-click or Ctrl-click the icon: unticked. Repeat once with the pointer already resting on the icon while the change is made, and once with keyboard access (Ctrl-F8 to the menu extras); note any stale tick.
  - Mac: add dsul by hand with + under Open at Login. Record what the box shows.
  - Mac: with the box ticked, log out and in. dsul opens with its window and tray. Untick, log out and in: it does not open.
  - Mac: with the box ticked, replace /Applications/dsul.app with the next ad-hoc build. Is the box still ticked, and does dsul still open at the next login? Note any keychain prompt (the existing ad-hoc caveat).

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

Also in v1: the push-row copy, the Wave icons, the CLAUDE.md layout line and the eslint ignore.

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
- Start in the tray at login, rather than showing the window. Windows could pass a Run argument; macOS can't tell a login launch apart.
- Open at login in the macOS app menu, for when the menu bar icon is out of reach (behind the notch, or switched off in System Settings). A `role: 'appMenu'` given an explicit submenu keeps the role's label, but the role's nine items then have to be spelled out, and it needs its own refresh on `did-become-active`.
- Offering `app.moveToApplicationsFolder()` from the "Open dsul from Applications to use this" line.
- Find bar: follow dsul's in-app Theme setting, not just the OS. That needs a signal from the page or main reading the page's DOM.
- Find bar: Use Selection for Find (⌘E), and keeping the match selected (Chrome's keepSelection) behind an explicit gesture rather than as Esc's default, because a match in an autosaving field would take the next key typed.
- Find bar: step aside for a match the find has just scrolled to. found-in-page's rect can be from before Blink's scroll, and no event says when the scroll has happened.
- Refitting a maximized window parked in the tray on a display that has since gone. The reveal refit moves only a normal window; Windows re-targets `SW_SHOWMAXIMIZED` to the nearest monitor, but whether macOS moves an ordered-out zoomed window is unknown.
- A smaller default frame on a display no larger than 1280x860 (a 1280x800 Mac). There the default already fills the work area, so it counts as zoomed and the green button has no smaller frame to return to, as on 0.1.1's first launch.
- Mac buttons on the wordmark row's midline past 125%. This needs a taller overlay at construction, plus `min(43px, …)` on every page rule that reads `env(titlebar-area-height)` (the full-page routes, `pt-safe`, the settings rail: 9 places), which would otherwise pad the overlay's full height at 100%.
- Console's status line zooming with the page. Today its text sits 4-11pt above the buttons' centre between 110% and 150% (0.1.1 was within 1-5pt), because the line is sized off `env(titlebar-area-height)` and Classic's row isn't. One class in components/shell/status-line.tsx would change that: `min(43px,calc(env(titlebar-area-height,0px)*43))` in place of both `min(43px,env(titlebar-area-height,0px))`, so any overlay makes the line 43 CSS px at every zoom. It is not free, which is why it waits for the taller overlay or a shell-version gate:
  - on a 0.1.1 shell, whose buttons never move, it takes Console's text from within 1-5pt of the buttons' centre to 2-11pt below it at 110-144%, and 15-28pt below at 158-207%;
  - on 0.1.2 it helps only up to about 131%. From about 150% it is worse than leaving it: 8, 12 and 21pt below the buttons' centre at 158%, 173% and 207%, against 9, 7 and 1pt above without it.
- Placing the Mac buttons before a slow first commit: keep the last zoom factor in userData and set the position before the first show, so a launch past the 4s fallback doesn't show them move.
- Notebook in the Mac app: its desk padding is 20px, not 12, so even at 100% the buttons sit about 8px above its wordmark row and the word starts about 22px past them. **[unverified: read, not rendered]**
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
9. Window size and place (v0.1.2), read in Electron 44.5.1 and Chromium 152 source but not run on a Mac or Windows machine:
   - that `maximize()` on a never-shown window shows no frame at the smaller size: one `SW_SHOWMAXIMIZED` on Windows, a zoom before ordering in on macOS, and on the window's own display rather than the main one;
   - that the creep mapping holds: the constructor's DIP and pixel trips are over by the time `getBounds()` is read straight after it, and an untouched window keeps reporting that rect;
   - that Windows' restore rect for a maximized window converts back to the same DIP rect with the taskbar on top or on the left;
   - that Windows' snap borders overhang by 16 DIP or less at every scale, and that its caption buttons are 46px, behind `GRAB_PX` 200;
   - that `before-quit` runs on a macOS log-out (verified only by keeping the window moving while a timed log-out fires, e.g. `sleep 5; osascript -e 'tell application "loginwindow" to «event aevtrlgo»'`), and that `isFullScreen()` is true for the whole of the macOS enter transition;
   - whether the OS moves a hidden window off a display that was removed (if so, the reveal refit does nothing), and whether `setBounds` across monitors with different scales deflates the window;
   - multi-monitor behaviour in general: the Linux smoke run saw one display;
   - that Electron's built-in `windowStatePersistence` would deflate a window restored onto a monitor with another DPI, one of the reasons it was passed over (inferred from native_window_views.cc:276-284, not reproduced);
   - that a window AppKit itself orders in while it is parked (the Window menu, say) only pauses saving until the next close or reveal.
10. Page zoom and the traffic lights (v0.1.2), read in Electron 44.5.1 and Chromium 152 source and run only on Linux under xvfb, with the two macOS-only button calls stubbed:
   - the geometry 0.1.1 already rests on: that the overlay keeps its 43pt height (`useCustomHeight`, window_buttons_proxy.mm:94-98) and that a y other than macOS's default margin puts the button's top that far below the window's top (:207-212). Nothing in the repo records 0.1.1's title bar being measured on a Mac, which is why the first Mac check is a gate;
   - that `setWindowButtonPosition` moves the buttons live and pushes the new `env(titlebar-area-x)` to the page;
   - macOS 26's button height (14 or 16pt) and default margin, and that a button pushed below the overlay would be clipped (why y stops at 27);
   - that moving the buttons in full screen would make them jump in the menu-bar strip (inferred from Electron skipping its own redraw there), and what a zoom does while full screen is still animating in, before `isFullScreen()` reads true;
   - that the title-bar container takes no clicks between the zoomed-out band (43 × zoom) and 43pt;
   - that a macOS menu click, from the menu bar or a key with a view inside the window focused, passes dsul's window as the focused one (seen for keys on Linux).
11. Open at login (v0.1.2), read in Electron 44.5.1 source and run only on Linux under xvfb, where Electron offers no login item (the macOS and Windows readings were simulated):
   - whether SMAppService.mainApp `register()` succeeds for an ad-hoc signed dsul.app in /Applications, whether macOS posts a "Login Item Added" notification, whether the registration survives replacing the app with a new ad-hoc build, and whether the status reads `enabled` straight after a successful register;
   - whether `requires-approval` can happen for mainAppService at all (it may only apply to agents and daemons), and that the `x-apple.systempreferences:com.apple.LoginItems-Settings.extension` URL opens General > Login Items on macOS 13, 14, 15 and 26;
   - what Background Task Management records for a translocated or DMG-mounted copy (the box is greyed out there), whether `wasOpenedAtLogin` is true for an SMAppService launch (unused), and what the box shows for dsul added by hand with + in Login Items;
   - that a macOS menu reads its ticks in `menuNeedsUpdate:` before `menuWillOpen:`, and that a right-click or Ctrl-click on the status item is preceded by `mouse-enter`;
   - the cost of one SMAppService status read, which the 500ms skip assumes is small;
   - the byte Windows writes under StartupApproved\Run when an entry is re-enabled in Task Manager or Settings (Electron accepts only a first byte of 0x00 or 0x02);
   - that Windows' tray `mouse-enter` fires for an icon in the overflow flyout (it is detected from mouse moves over the icon's bounds);
   - the installer.nsh change, which was not compiled: there is no makensis here, so only the text lock and the manual uninstall check hold it.
12. Find in page (v0.1.2), read in Electron 44.5.1 and Chromium 152 source and run only on Linux under xvfb (the macOS branch with `IS_MAC` forced on, which proves the placement and the close order, not AppKit):
   - the macOS key path on a device: ⌘F, ⌘G and ⇧⌘G reaching Edit > Find only when the page leaves them unhandled, from the page and from the bar, and the Find submenu's rendering;
   - whether the hidden Control+F opens find from a Mac text field as well as moving the caret, which depends on Blink reporting Cocoa's move-forward as handled;
   - that the bar at y 51 takes every click and the band beside it still drags, and where the keyboard is after ⌘Tab back (macOS restores the page's stored first responder);
   - whether the hidden bar is ever handed the focus on macOS or Windows as it was under Linux (`keepKeysOffClosedBar` covers it either way, while the window has focus);
   - the Windows Win32 key path, including the hidden F3 items (the Linux views path, which shares that code, was run), the bar's place with the auto-hidden menu bar shown, `setBorderRadius` corners and 150% scaling;
   - VoiceOver and Narrator across the bar's separate webContents, and an IME on a device (only synthetic `isComposing` and keyCode 229 were tested);
   - the memory cost of the bar's renderer, and a packaged run (only `files` was checked).

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