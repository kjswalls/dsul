'use strict';

// The run-time app icon: which look the Dock (macOS) or the window and taskbar (Windows, Linux)
// shows. Pure, like window-chrome.cjs, so the root unit suite can hold the file names to what
// scripts/app-icon/build.mjs writes and electron-builder packs
// (tests/unit/electron-app-icon.test.ts).
//
// The page sends its Settings → Look choice over dsul:set-app-icon (preload.cjs setAppIcon), and
// main keeps it in userData/app-icon.json so the next launch starts on it. Every look is a 512px
// PNG on Apple's grid on every platform: nativeImage scales it for a Windows taskbar, and a
// runtime .ico would buy nothing. The bundle icons (build/icon.png, build/icon.ico) stay Aurora,
// so Finder, the installer and a pinned-while-closed icon always show Aurora.
const LOOKS = Object.freeze(['aurora', 'lime']);
const DEFAULT_LOOK = 'aurora';

/** The look, or null for anything that isn't one: the page is not trusted to send a path. */
function parseLook(value) {
  return typeof value === 'string' && LOOKS.includes(value) ? value : null;
}

/** The file under electron/build/ for a look. */
function iconFile(look) {
  return `app-icon-${look}.png`;
}

module.exports = { LOOKS, DEFAULT_LOOK, parseLook, iconFile };
