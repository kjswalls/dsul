# dsul desktop

The Electron shell for macOS and Windows. Its one window loads the live https://do.dsul.app, so
web changes reach it through Vercel with no desktop release. The shell adds a tray, a global
quick-capture shortcut (Ctrl/⌘+Shift+Space), find in page (Ctrl/⌘ F) and the `dsul://` sign-in
handoff. The design, and the reasons behind each guard, are in
[memory/plans/desktop-app.md](../memory/plans/desktop-app.md).

**npm only. Never run pnpm in here.** This folder is not part of the pnpm workspace, and `pnpm
install` in a folder the workspace doesn't list silently installs the ROOT workspace instead.
Never add electron to the root `package.json` either.

| File | What it is |
| --- | --- |
| `main.cjs` | Lifecycle, window, navigation guards, menu (with Find), find bar, tray, shortcut, deep links, update notice |
| `preload.cjs` | `window.dsulDesktop`, the only bridge the page gets (mirrored by `lib/desktop.ts`) |
| `find-bar.html` | The find bar's page. No script; shown as a data: URL in a view over the window's top-right corner |
| `find-preload.cjs` | Wires the find bar from its isolated world. Exposes nothing |
| `lib/policy.cjs` | Every URL decision, pure, tested by `tests/unit/electron-policy.test.ts` at the root |
| `lib/window-chrome.cjs` | The macOS title bar: the band the traffic lights share with the page, and where they sit at each page zoom (main moves them as the zoom changes). Pure, tested by `tests/unit/electron-window-chrome.test.ts` |
| `lib/window-state.cjs` | Where the window reopens: parses `window-state.json`, fits it to the displays connected now and decides what to save. Pure, tested by `tests/unit/electron-window-state.test.ts` |
| `lib/login-item.cjs` | What the tray's Open at login box shows on each platform (what dsul registered, read back) and the exact requests main sends. Pure, tested by `tests/unit/electron-login-item.test.ts` |
| `lib/find-bar.cjs` | The find bar's place (and stepping aside for a match), count label and Edit-menu items. Pure, tested by `tests/unit/electron-find-bar.test.ts` |
| `offline.html` | Shown when the app can't be reached; it retries when the computer comes back online, and main retries on a backoff |
| `electron-builder.config.cjs` | Packaging, fuses and signing |
| `build/` | Icons, the macOS entitlements and the NSIS include that registers `dsul://` on Windows, and on uninstall (not update) removes it and Open at login's Run value |

## Run it in dev

```bash
cd electron
npm ci
npm start                                  # loads https://do.dsul.app
DSUL_URL=http://localhost:3000 npm start   # loads a local `pnpm dev` instead
```

- A dev run keeps its own profile (`<appData>/dsul-dev`), so it doesn't share the installed app's
  cookies, its saved window place (`window-state.json`) or the single-instance lock.
- `DSUL_URL` is honoured only by a dev run. A local `pnpm dev` talks to PRODUCTION Supabase until
  `./scripts/local-setup.sh dev` has run (see the root CLAUDE.md).
- With a local Supabase stack, the desktop Google and Apple sign-ins also accept that stack's
  authorize URL: `http://127.0.0.1:54321` by default, or `DSUL_SUPABASE_URL`. The stack's redirect
  list needs `http://localhost:3000/auth/desktop` added (`additional_redirect_urls` in its
  config.toml).
- `DSUL_DEV_PROTOCOL=1 npm start` registers `dsul://` to this checkout so a sign-in link comes
  back here. That overwrites the installed app's registration, so relaunch the installed app
  afterwards to take it back. Test deep links on packaged builds; dev registration is for poking
  at them, not for proving them.
- DevTools and Reload are in the View menu in dev only.
- Open at login doesn't appear in a dev run: registering would start the bare Electron binary at
  login. Test it on a packaged build (memory/plans/desktop-app.md, "Open at login").

## Build it

```bash
npm run dist:mac    # dmg + zip, arm64, on a Mac
npm run dist:win    # NSIS installer, x64, on Windows
```

Output lands in `release/`. Without `CSC_LINK` the Mac build is signed ad hoc, because an unsealed
bundle is reported as "damaged" on Apple Silicon with no Open Anyway button (not yet checked on a
device). Real release builds come only from the GitHub runners.

## Cutting a release

Releases are built by [.github/workflows/desktop-release.yml](../.github/workflows/desktop-release.yml),
dispatched by hand from `main`.

Signing reads five secrets from the `desktop-release` Environment, by exactly these names. Any
other spelling reaches nothing, and the Mac build goes out unsigned.

| Secret | What it holds |
| --- | --- |
| `DESKTOP_CSC_LINK` | The Developer ID Application .p12, base64-encoded |
| `DESKTOP_CSC_KEY_PASSWORD` | That .p12's password |
| `DESKTOP_APPLE_API_KEY_P8` | The App Store Connect API key: the .p8 file's contents, not a path |
| `DESKTOP_APPLE_API_KEY_ID` | That key's id |
| `DESKTOP_APPLE_API_ISSUER` | Its issuer id |

With none of them the Mac build is ad-hoc signed and not notarized. With the Apple ones but no
`DESKTOP_CSC_LINK` the Mac leg fails rather than publish an unsigned build.

1. Bump `version` in `electron/package.json` in a PR, and merge it.
2. Dispatch the workflow from `main` (Actions → the desktop release workflow → Run workflow).
3. Approve the `desktop-release` Environment when it asks.
4. Check the draft release it made for `v<version>`: a dmg, a zip and `dsul-setup.exe`.
5. Publish it. Installed apps notice within a day (tray → Update available) and link to it.

`https://github.com/kjswalls/dsul/releases/latest/download/dsul-setup.exe` always points at the
newest Windows installer.

## Things not to change

- `appId` (`app.dsul.desktop`) and `productName` are permanent once shipped.
- The cookie-encryption fuse is one-way: turning it off would make every user's cookie store
  unreadable.
- `CSC_IDENTITY_AUTO_DISCOVERY=false` stops a supplied certificate from ever being used, so don't
  set it.
