'use strict';

// The dsul desktop shell: one window on the live https://do.dsul.app, plus the few things a
// browser tab can't do (a tray, a global capture shortcut, dsul:// sign-in links). The plan is
// memory/plans/desktop-app.md; read it before changing anything that touches navigation, IPC or
// sign-in. Every URL decision is in lib/policy.cjs, which the root unit suite tests.

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  session,
  shell,
} = require('electron');
const policy = require('./lib/policy.cjs');
const { windowChrome } = require('./lib/window-chrome.cjs');

const APP_ID = 'app.dsul.desktop';
const IS_MAC = process.platform === 'darwin';
const SHORTCUT = 'CommandOrControl+Shift+Space';
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
// The "Signed in as" toast is for the sign-in that just happened, not one the page never got
// round to asking about.
const NOTICE_MS = 5 * 60 * 1000;

// Where the window points. Only a dev build honours DSUL_URL, and a dev server on localhost
// talks to PRODUCTION Supabase until scripts/local-setup.sh dev has run.
const START_URL = resolveStartUrl();
const START_ORIGIN = new URL(START_URL).origin;
// Supabase hosts whose authorize URL may be opened for a sign-in. Dev adds the local stack.
const SUPABASE_ORIGINS = app.isPackaged
  ? [policy.SUPABASE_ORIGIN]
  : [policy.SUPABASE_ORIGIN, process.env.DSUL_SUPABASE_URL || 'http://127.0.0.1:54321'];
// The offline page goes in as a data: URL, not loadFile. With the grantFileProtocolExtraPrivileges
// fuse off, file:// can't read inside app.asar, so a packaged loadFile fails with
// ERR_FILE_NOT_FOUND; the fuse stays off.
const OFFLINE_URL = `data:text/html;charset=utf-8;base64,${fs
  .readFileSync(path.join(__dirname, 'offline.html'))
  .toString('base64')}`;

let win = null;
let tray = null;
let isQuitting = false;
let shortcutRegistered = false;
let update = null; // { version, url } once GitHub has a newer release
let pending = null; // { kind: 'google' | 'email', until } while a sign-in may come back
let signInNoticeUntil = 0;
const seenCodes = new Set();
const queuedLinks = [];

// A capture press is held here until the page in the window says it is listening. Readiness
// belongs to one document, so it resets whenever the main frame commits a new one, and a press
// made while a navigation is in flight waits for whichever document survives it.
let pendingCapture = false;
let captureReady = false;
let inflight = 0;

// While the window shows the offline page, main keeps trying the app on this schedule, repeating
// the last step. The page's own retry is the `online` event, which never fires if the machine
// already counted as online when the load failed: after a wake from sleep while DNS or Wi-Fi is
// still settling, or while the site is briefly unreachable.
const OFFLINE_RETRY_MS = [5_000, 15_000, 30_000, 60_000];
let offlineTimer = null;
let offlineTries = 0;

function resolveStartUrl() {
  const override = process.env.DSUL_URL;
  if (app.isPackaged || !override) return `${policy.APP_ORIGIN}/`;
  try {
    const u = new URL(override);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    // Fall through to the warning.
  }
  console.warn('[dsul] DSUL_URL must be an http(s) URL; using do.dsul.app');
  return `${policy.APP_ORIGIN}/`;
}

const isApp = (url) => policy.isAppUrl(url, START_ORIGIN);

function load(contents, url) {
  // A failed load is handled by did-fail-load; the rejected promise has nothing to add.
  contents.loadURL(url).catch(() => {});
}

// ── Startup ──────────────────────────────────────────────────────────────────

// A dev `electron .` gets its own profile, so it neither shares the installed app's cookies nor
// loses the single-instance lock to it. This has to happen before the lock is taken.
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'dsul-dev'));

// A packaged build refuses a launch that would let another process drive the window, read its
// traffic or switch off its checks (policy.BLOCKED_SWITCHES says which).
if (app.isPackaged && policy.blockedLaunch((s) => app.commandLine.hasSwitch(s), process.env)) {
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  registerProtocol();

  // macOS delivers dsul:// links as open-url, including the one that launched the app, which
  // arrives before `ready`; registering here is what catches that cold start.
  app.on('will-finish-launching', () => {
    app.on('open-url', (event, url) => {
      event.preventDefault();
      receiveLink(url);
    });
  });
  app.on('second-instance', (_event, argv) => {
    const link = policy.deepLinkFromArgv(argv);
    // A bare relaunch brings the window forward. A link only does so if it is accepted, so an
    // unsolicited one changes nothing.
    if (link) receiveLink(link);
    else reveal();
  });
  app.on('web-contents-created', (_event, contents) => harden(contents));
  // dsul never uses client certificates, and Electron's default would hand the first one in the
  // store to any host that asks (a remote image in a Beacon reply is enough), with no prompt.
  app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
    event.preventDefault();
    callback();
  });
  app.on('activate', reveal);
  app.on('before-quit', () => {
    isQuitting = true;
    session.defaultSession.cookies.flushStore().catch(() => {});
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  registerIpc();
  app.whenReady().then(ready);
}

function registerProtocol() {
  // Windows: the installer writes the dsul:// key (build/installer.nsh), and a packaged build
  // rewrites it in case it went missing. A dev build only registers when asked, because doing so
  // points the scheme at this checkout instead of the installed app.
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient('dsul');
  } else if (process.env.DSUL_DEV_PROTOCOL === '1') {
    app.setAsDefaultProtocolClient('dsul', process.execPath, [path.resolve(process.argv[1] || '.')]);
  }
}

function ready() {
  pending = readPending();
  configureSession(session.defaultSession);
  installMenu();
  createWindow();
  registerShortcut();
  createTray();

  // Windows and Linux hand a cold-start link over on the command line.
  const link = policy.deepLinkFromArgv(process.argv);
  if (link) receiveLink(link);
  while (queuedLinks.length) handleDeepLink(queuedLinks.shift());

  // A wake from sleep is when the network usually comes back, so the offline page's retries
  // start over from the shortest wait.
  powerMonitor.on('resume', () => {
    if (!win || win.isDestroyed() || !onOfflinePage(win.webContents)) return;
    offlineTries = 0;
    scheduleOfflineRetry();
  });

  checkForUpdate();
  setInterval(checkForUpdate, UPDATE_EVERY_MS);
}

// ── Window ───────────────────────────────────────────────────────────────────

function backgroundColor() {
  // The page's own ground (app/layout.tsx), so nothing flashes white before first paint.
  return nativeTheme.shouldUseDarkColors ? '#0e1014' : '#fbfaf9';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    // Below 768px the mobile shell renders and below 1180px the item panel overlays the page;
    // 900 keeps the desktop layout.
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'dsul',
    backgroundColor: backgroundColor(),
    autoHideMenuBar: process.platform === 'win32',
    // macOS: no title bar; the traffic lights sit in the page's own top band
    // (lib/window-chrome.cjs). Windows and Linux keep the native frame.
    ...windowChrome(process.platform),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      navigateOnDragDrop: false,
      spellcheck: true,
      additionalArguments: [`--dsul-shell-version=${app.getVersion()}`],
    },
  });

  let shown = false;
  const showOnce = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', showOnce);
  // A slow network can hold the first paint for a long time; an empty window in the theme's
  // colour beats no window at all.
  setTimeout(showOnce, 4000);

  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    // macOS keeps a hidden fullscreen window's Space, empty and black, and the next reveal can
    // land in it. So the window leaves fullscreen first and hides once it has.
    if (IS_MAC && win.isFullScreen()) {
      win.once('leave-full-screen', () => win.hide());
      win.setFullScreen(false);
    } else {
      win.hide();
    }
  });
  // Hiding instead of closing must not hold up a Windows shutdown or log-off.
  win.on('session-end', () => {
    isQuitting = true;
  });
  nativeTheme.on('updated', () => {
    if (!win.isDestroyed()) win.setBackgroundColor(backgroundColor());
  });

  const contents = win.webContents;
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) inflight += 1;
  });
  contents.on('did-navigate', (_event, url) => {
    inflight = Math.max(0, inflight - 1);
    captureReady = false;
    // An error page never fires did-navigate, so an app URL here means the app is back.
    if (isApp(url)) stopOfflineRetry();
  });
  contents.on('did-fail-provisional-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame) return;
    inflight = Math.max(0, inflight - 1);
    // ABORTED (-3: blocked, replaced, or a download) and a bodiless response (0) leave the old
    // page and its listener in place. Any other failure commits an error page over it.
    if (code !== -3 && code !== 0) captureReady = false;
    deliverCapture();
  });
  contents.on('did-stop-loading', () => {
    // Nothing is in flight once loading stops, whatever the count says.
    inflight = 0;
    deliverCapture();
  });
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || url.startsWith('data:')) return;
    captureReady = false;
    // Serwist has no navigation fallback, so without this an offline launch is a blank window.
    load(contents, OFFLINE_URL);
    // A retry that fails lands back here, so each one waits longer than the last.
    scheduleOfflineRetry();
  });
  const crashes = [];
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    captureReady = false;
    const now = Date.now();
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
    crashes.push(now);
    // A page that crashes on load would otherwise reload forever. Past three a minute it waits
    // for Open dsul.
    if (crashes.length <= 3) contents.reload();
  });
  contents.on('context-menu', (_event, params) => showContextMenu(contents, params));

  load(contents, START_URL);
}

function reveal() {
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (contents.isCrashed()) contents.reload();
  // Someone asked for the window (a press, a relaunch, the tray, the Dock), so the offline page
  // tries the app now rather than at its next timer.
  else if (onOfflinePage(contents)) load(contents, START_URL);
  bringForward();
}

// reveal without the reload or the retry, for handleDeepLink: it has just started a load of its
// own, and either of those would cancel it.
function bringForward() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // A global shortcut fires while another app is frontmost; macOS won't hand over focus without
  // this.
  if (IS_MAC) app.focus({ steal: true });
}

// The offline page is the only data: URL the window ever shows.
function onOfflinePage(contents) {
  return contents.getURL().startsWith('data:');
}

function scheduleOfflineRetry() {
  clearTimeout(offlineTimer);
  const delay = OFFLINE_RETRY_MS[Math.min(offlineTries, OFFLINE_RETRY_MS.length - 1)];
  offlineTries += 1;
  offlineTimer = setTimeout(() => {
    // Always the start URL: a failed load may have been the sign-in callback, and a code is
    // never loaded twice.
    if (!win || win.isDestroyed() || !onOfflinePage(win.webContents)) return;
    load(win.webContents, START_URL);
  }, delay);
}

function stopOfflineRetry() {
  clearTimeout(offlineTimer);
  offlineTimer = null;
  offlineTries = 0;
}

function showContextMenu(contents, params) {
  // The app's own Radix menus cancel the DOM event, so they never get here.
  const items = [];
  if (params.isEditable) {
    if (params.misspelledWord) {
      for (const word of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: word, click: () => contents.replaceMisspelling(word) });
      }
      if (items.length) items.push({ type: 'separator' });
    }
    const f = params.editFlags;
    items.push(
      { role: 'cut', enabled: f.canCut },
      { role: 'copy', enabled: f.canCopy },
      { role: 'paste', enabled: f.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: f.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: 'copy' });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

function installMenu() {
  const view = {
    label: 'View',
    submenu: [
      // The app hands Ctrl/⌘ +, − and 0 back to the browser outside the week views, so these
      // are what zoom the page there.
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      // zoomIn's own accelerator is Plus, which needs Shift on most keyboards.
      { role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false, acceleratorWorksWhenHidden: true },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
    ],
  };
  // macOS needs the Edit roles, or ⌘C/V/X/A stop working in text fields.
  const template = IS_MAC
    ? [{ role: 'appMenu' }, { role: 'editMenu' }, view, { role: 'windowMenu' }]
    : [{ role: 'fileMenu' }, { role: 'editMenu' }, view];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Guards ───────────────────────────────────────────────────────────────────

function harden(contents) {
  contents.on('will-navigate', (event) => guardNavigation(event, contents));
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame) guardNavigation(event, contents);
    else guardSubframe(event);
  });
  // will-frame-navigate fires for the main frame too; will-navigate already has that.
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) guardSubframe(event);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // A same-origin new window (⌘-click, middle-click) does nothing in v1: a load in the main
    // window would tear down the store and the undo stack.
    if (!isApp(url)) openOutside(url);
    return { action: 'deny' };
  });
}

function guardNavigation(event, contents) {
  const url = event.url;
  if (isApp(url) && !policy.carriesAuthCode(url)) return;
  event.preventDefault();
  if (policy.isAuthorizeEndpoint(url, SUPABASE_ORIGINS)) {
    // An in-window Google sign-in (an old login page, or anything else that tries one) can't
    // finish here, and opening it outside would fail too: its redirect_to is /auth/callback,
    // and the system browser has no verifier. Back to the login page.
    load(contents, `${START_ORIGIN}/login`);
    return;
  }
  // An app URL carrying a code is dropped: only main's own loadURL may bring one in.
  if (isApp(url)) return;
  // offline.html only knows production. A dev build pointed elsewhere retries its own start URL.
  if (contents.getURL().startsWith('data:') && url === `${policy.APP_ORIGIN}/`) {
    load(contents, START_URL);
    return;
  }
  openOutside(url);
}

function guardSubframe(event) {
  // The app has no frames. One that appears (an embed in rendered markdown) may show the app
  // and nothing else, and never opens a browser tab on its own.
  if (isApp(event.url) && !policy.carriesAuthCode(event.url)) return;
  event.preventDefault();
}

function openOutside(url) {
  if (!policy.externalAllowed(url) || policy.isAuthorizeEndpoint(url, SUPABASE_ORIGINS)) return;
  // The parsed form, so the OS sees exactly the URL that was checked.
  shell.openExternal(new URL(url).href).catch(() => {});
}

function configureSession(ses) {
  const allowed = new Set(['clipboard-sanitized-write', 'notifications']);
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowed.has(permission) && isApp(details.requestingUrl || contents.getURL()));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    return allowed.has(permission) && isApp(details.requestingUrl || requestingOrigin);
  });
}

// ── IPC ──────────────────────────────────────────────────────────────────────

// The bridge answers only the app's own top-level page. The preload also runs on offline.html,
// and would in any frame; none of those may arm a sign-in or take the notice.
function fromApp(event) {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
  const frame = event.senderFrame;
  const main = event.sender.mainFrame;
  return (
    !!frame &&
    frame.processId === main.processId &&
    frame.routingId === main.routingId &&
    isApp(frame.url)
  );
}

function registerIpc() {
  ipcMain.on('dsul:capture-ready', (event) => {
    if (!fromApp(event)) return;
    captureReady = true;
    deliverCapture();
  });

  ipcMain.handle('dsul:open-auth-url', async (event, url) => {
    if (!fromApp(event)) return false;
    const ok = policy.checkAuthorizeUrl(url, {
      appOrigin: START_ORIGIN,
      supabaseOrigins: SUPABASE_ORIGINS,
    });
    if (!ok) return false;
    await armPending('google');
    try {
      await shell.openExternal(new URL(url).href);
      return true;
    } catch {
      clearPending();
      return false;
    }
  });

  ipcMain.handle('dsul:arm-email', async (event) => {
    if (fromApp(event)) await armPending('email');
  });

  ipcMain.handle('dsul:take-sign-in-notice', (event) => {
    if (!fromApp(event)) return false;
    const live = Date.now() < signInNoticeUntil;
    signInNoticeUntil = 0;
    return live;
  });
}

// ── Sign-in handoff ──────────────────────────────────────────────────────────

const pendingFile = () => path.join(app.getPath('userData'), 'auth-pending.json');

function readPending() {
  try {
    return policy.livePending(JSON.parse(fs.readFileSync(pendingFile(), 'utf8')), Date.now());
  } catch {
    return null;
  }
}

// The window is kept on disk so a magic link that cold-starts the app is still honoured, and
// every write flushes the cookie store, which holds the PKCE verifier the page just wrote.
async function writePending() {
  try {
    if (pending) fs.writeFileSync(pendingFile(), JSON.stringify(pending), { mode: 0o600 });
    else fs.rmSync(pendingFile(), { force: true });
  } catch {
    // Memory still has it; only a cold start would miss it.
  }
  await session.defaultSession.cookies.flushStore().catch(() => {});
}

function armPending(kind) {
  const span = kind === 'google' ? policy.GOOGLE_PENDING_MS : policy.EMAIL_PENDING_MS;
  // One slot: a second attempt replaces the verifier, so the first attempt's code is dead anyway.
  pending = { kind, until: Date.now() + span };
  return writePending();
}

function clearPending() {
  pending = null;
  return writePending();
}

function pendingNow() {
  if (pending && !policy.livePending(pending, Date.now())) clearPending();
  return pending;
}

function receiveLink(url) {
  if (!win) queuedLinks.push(url);
  else handleDeepLink(url);
}

/**
 * The gate for dsul:// links. Outside a sign-in the app started, every link is dropped silently,
 * error links included: a failed exchange deletes the verifier, so a stray link must never reach
 * one. Only a code crosses into the app, and the exchange runs in the window's own cookie jar.
 */
function handleDeepLink(raw) {
  const link = policy.parseDeepLink(raw);
  if (!link || !pendingNow() || !win || win.isDestroyed()) return;
  if (link.type === 'code') {
    // argv, second-instance and open-url can each deliver the same link.
    if (seenCodes.has(link.code)) return;
    seenCodes.add(link.code);
    clearPending();
    signInNoticeUntil = Date.now() + NOTICE_MS;
    load(win.webContents, `${START_ORIGIN}/auth/callback?code=${encodeURIComponent(link.code)}`);
  } else {
    clearPending();
    load(win.webContents, `${START_ORIGIN}/login?error=${link.error}`);
  }
  bringForward();
}

// ── Quick capture and tray ───────────────────────────────────────────────────

function capture() {
  pendingCapture = true;
  reveal();
  deliverCapture();
}

function deliverCapture() {
  if (!pendingCapture || !captureReady || inflight > 0 || !win || win.isDestroyed()) return;
  pendingCapture = false;
  win.webContents.send('dsul:quick-capture');
}

function registerShortcut() {
  try {
    shortcutRegistered = globalShortcut.register(SHORTCUT, capture);
  } catch {
    shortcutRegistered = false;
  }
  refreshTrayMenu();
}

function createTray() {
  // macOS tints a template image to suit the menu bar; Windows gets the coloured mark.
  // nativeImage picks up the @2x file beside each one on its own.
  const icon = nativeImage.createFromPath(
    path.join(__dirname, 'build', IS_MAC ? 'trayTemplate.png' : 'tray.png'),
  );
  if (IS_MAC) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('dsul');
  // On Windows a left click is the usual way back to a tray app; the menu is on right click.
  if (!IS_MAC) tray.on('click', reveal);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const items = [
    shortcutRegistered
      ? { label: 'New task', accelerator: SHORTCUT, registerAccelerator: false, click: capture }
      : { label: 'New task', click: capture },
  ];
  if (!shortcutRegistered) items.push({ label: 'Shortcut unavailable', enabled: false });
  items.push({ label: 'Open dsul', click: reveal });
  if (update) {
    const { url } = update;
    items.push(
      { type: 'separator' },
      { label: `Update available (${update.version})`, click: () => openOutside(url) },
    );
  }
  items.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ── Updates ──────────────────────────────────────────────────────────────────

// v1 only says a new installer exists. The site updates itself through Vercel, but the bundled
// Chromium only moves with a new installer. Any failure is silent: this is a nicety, not a gate.
async function checkForUpdate() {
  try {
    const res = await net.fetch(policy.RELEASES_API, {
      headers: { accept: 'application/vnd.github+json' },
      credentials: 'omit',
    });
    if (!res.ok) return;
    const found = policy.newerRelease(await res.json(), app.getVersion());
    if ((found && found.version) !== (update && update.version)) {
      update = found;
      refreshTrayMenu();
    }
  } catch {
    // Offline, rate-limited or no releases yet.
  }
}
