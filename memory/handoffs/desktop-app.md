# Desktop app: handoff

Written 2026-10-09 by the "Desktop app" thread, for a session elsewhere that picks up the work.

The full design lives in the repo, not here. Read these first:
- `memory/plans/desktop-app.md` covers the design, the guards, sign-in, packaging, the release workflow, Testing, the Mac and Windows manual checks, Kirby's checklist and the Later list.
- `electron/README.md`.
- In `CLAUDE.md`, the `electron/` paragraph and the "top 43px is a window-drag band" bullet.

This file only says where things stand and what comes next.

## What it is

The desktop app is an Electron shell (Electron 44.5.1, electron-builder 26.15) that loads the live https://do.dsul.app. It adds:
- sign-in through the system browser and `dsul://`;
- quick capture on Ctrl/Cmd+Shift+Space;
- a tray icon;
- an update notice;
- a few native touches.

It is built for macOS arm64 and Windows x64. The code is in `electron/`, a standalone npm project outside the pnpm workspace.

## Shipped

| PR | Merged | Version | What |
|---|---|---|---|
| #352 | 2026-10-01 | (web) | Open-redirect fix in /auth/callback; every /login sign-in lands through /auth/callback?next= |
| #353 | 2026-10-01 | 0.1.0 | The shell, the /auth/desktop bounce page, quick capture, the tray, the update notice, the release workflow |
| #359 | 2026-10-01 | 0.1.1 | A signed-out launch goes to /login; on macOS the window buttons sit in the page's 43px top band |
| #366 | 2026-10-02 | 0.1.2 | Settings → Look → App icon (Aurora or Lime) also sets the Dock or taskbar icon (`lib/app-icon.cjs`) |
| #372 | 2026-10-02 | 0.1.2 | See below |

#372 added four things:
- The window reopens where it was left, at the same size.
- Open at login, a checkbox in the tray menu.
- Find in page on Ctrl/Cmd+F.
- On a Mac, the window buttons follow page zoom.

### On main but in no build yet

These merged after the 0.1.2 build, which was made from 6960d41. A 0.1.3 release would carry them:
- **#405, Sign in with Apple.** The shell's `checkAuthorizeUrl` accepts `provider=apple` (`policy.OAUTH_PROVIDERS`), and the preload advertises the provider list as `authProviders`. A 0.1.2 shell has no such list, so its login page shows no Apple button.
- **#380 and #392.** New `build/icon.ico` and tray PNGs, to match the updated favicon.
- **#434.** A comment in `guardSubframe` only. The mod sandbox iframe already loads in every shell, because it is an app URL.

- **0.1.3's own change.** Both permission handlers refuse every subframe, so the mod sandbox frame can never hold `notifications`.

`electron/package.json` says 0.1.3 (the bump PR, 2026-10-09). No 0.1.3 build has been dispatched yet.

## Releases

All three drafts are unsigned and unpublished:
- **0.1.2** (built 2026-10-02, workflow run 36977820518): https://github.com/kjswalls/dsul/releases/tag/untagged-46b19297afcce5bd036c
- **0.1.1**: https://github.com/kjswalls/dsul/releases/tag/untagged-73a993c55f609df7bc10
- **0.1.0**: https://github.com/kjswalls/dsul/releases/tag/untagged-254520182f7e1b11c649

Only the newest matters. Once 0.1.2 or a later version is published, the older drafts can be deleted.

### Each release

1. Bump the version in `electron/package.json`, in a PR, and merge it.
2. If the shell depends on a web change, deploy the web change first.
3. Dispatch `.github/workflows/desktop-release.yml` from main. It makes a DRAFT release.
4. Kirby checks the draft and publishes it.

## Waiting on Kirby

1. **Try the 0.1.2 draft and publish it.** Run it on the Mac, and on Windows if possible; Windows has never been run. Work through the manual checks in the plan. None of 0.1.2's checks have been run yet.
2. **Vercel: check `NEXT_PUBLIC_DISABLE_AUTH` in Production.** It is suspected of being `true`, which would let a signed-out request past the server gate. This is unverified. Since #359 the browser covers for it, so it no longer strands the app.
3. **Supabase Auth URL settings** (the plan's "Step 0"):
   - Site URL `https://do.dsul.app`;
   - redirects covering `https://do.dsul.app/**`.

   This is still unconfirmed, and the iPhone's sign-in needs it too.
4. **Mac signing.** Kirby's Apple Developer Program membership is paid (confirmed 2026-10-05), so nothing blocks this now. The steps are in "Kirby's checklist" in the plan:
   - create the `desktop-release` GitHub Environment, with main as its deployment branch and Kirby as required reviewer;
   - add a `v*` tag ruleset;
   - create a Developer ID Application certificate (only the Account Holder can);
   - create an App Store Connect API key;
   - add the five `DESKTOP_*` secrets, spelled exactly as the plan lists them.
5. **Apple sign-in on the desktop** needs two things: Supabase's Apple provider switched on (see `memory/plans/sign-in-with-apple.md`), and a 0.1.3 release.

## Suggested next steps

1. **Release 0.1.3** with the post-0.1.2 changes above. A small shell fix could ride along: the Later list's "refuse every permission to a subframe". With the mod sandbox frame now on the page, that keeps `notifications` limited to the main frame.
2. **Once the signing secrets exist,** dispatch a release and check that the Mac build is signed and notarized.
3. **Then electron-updater**, which works only with signed builds and replaces the update notice.
4. **The rest of the Later list** in the plan, for example:
   - Windows signing;
   - native reminders with Done and Snooze (web push does not work in Electron);
   - an Intel Mac build;
   - Open at login in the macOS app menu;
   - a 6-digit email code for signing in on another device.

## Rules that bite

- **Never run pnpm in `electron/`.** Use `npm ci` there.
- **Keep pure logic testable.** It lives in `electron/lib/*.cjs` with no requires, and the root vitest suite tests it (`npx vitest run tests/unit/electron-`). CI cannot run Electron, so text-lock tests over `main.cjs` hold the load-bearing lines.
- **Smoke-test against a local page, never the live site.** For example, serve a page with `python3 -m http.server`, then run `DSUL_URL=http://127.0.0.1:<port>/ xvfb-run -a ./node_modules/.bin/electron . --no-sandbox` from `electron/`. Linux runs the code but tells you nothing about Mac or Windows behaviour.
- **Never hang work on BrowserWindow `hide` on macOS.** It fires whenever the window is covered, on a Space switch or screen lock, or when minimized. Close-to-tray work goes in the close handler's non-quitting branch.
- **List every file `main.cjs` loads in `electron-builder.config.cjs` `files`.** Under `electron .` a missing file still works; the installed app breaks. `tests/unit/electron-find-bar.test.ts` checks this.
- **Mac top band.** On a Mac the top 43px of the page drags the window, so anything clickable there needs `titlebar-hole`. `MAC_LIGHTS.x` in `electron/lib/window-chrome.cjs` is tied to the sidebar wordmark's `-35px`; change one and you must change the other. The zoom items are click handlers, not roles.
- **New bridge methods.** Add each new `window.dsulDesktop` method as optional, and have the page check that it exists, because old shells stay installed.
- **If the review bot never runs on a PR, check for a merge conflict.** A conflicted PR runs no `pull_request` workflows: no review bot and no PR CI.

## Key files

- `electron/main.cjs`: lifecycle, the window, the guards, the menu, the tray, the shortcut, deep links, the find bar, open at login and the app icon.
- `electron/preload.cjs` is the `window.dsulDesktop` bridge. `electron/find-preload.cjs` and `electron/find-bar.html` are the find bar.
- `electron/lib/`:
  - `policy.cjs`: URLs, sign-in and deep links;
  - `window-chrome.cjs`: the Mac title bar and zoom;
  - `window-state.cjs`;
  - `login-item.cjs`;
  - `find-bar.cjs`;
  - `app-icon.cjs`.
- `electron/electron-builder.config.cjs` and `electron/build/` (icons, `entitlements.mac.plist`, `installer.nsh`).
- `.github/workflows/desktop-release.yml`.
- Web side:
  - `app/auth/desktop/`;
  - `lib/desktop.ts`;
  - `components/providers/desktop-bridge.tsx`;
  - the `.titlebar-drag` rule in `app/globals.css`.
- Tests: `tests/unit/electron-*.test.ts` and `tests/unit/helpers/electron-main.ts`.

## History

- The "Desktop app" thread in the dsul project.
- The team memory note `desktop-app-2026-10`.
- The PRs listed above.

The scratch design files behind 0.1.2 lived in a session scratchpad and are gone. Everything that mattered went into the plan's sections, its Later list and its Open assumptions.
