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
  MenuItem,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  screen,
  session,
  shell,
  WebContentsView,
} = require('electron');
const policy = require('./lib/policy.cjs');
const { TITLE_BAND_PX, windowChrome, macLights, nextZoomLevel } = require('./lib/window-chrome.cjs');
const findBar = require('./lib/find-bar.cjs');
const windowState = require('./lib/window-state.cjs');
const {
  LOGIN_ITEM_ID,
  NOT_OFFERED,
  loginItemQuery,
  loginItemView,
  loginItemRequest,
  showLoginItemsPane,
} = require('./lib/login-item.cjs');
const appIcons = require('./lib/app-icon.cjs');

// Also names the Windows Run value for Open at login, which build/installer.nsh deletes by this
// name (as ${APP_ID}) on uninstall.
const APP_ID = 'app.dsul.desktop';
const IS_MAC = process.platform === 'darwin';
const SHORTCUT = 'CommandOrControl+Shift+Space';
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
// The "Signed in as" toast is for the sign-in that just happened, not one the page never got
// round to asking about.
const NOTICE_MS = 5 * 60 * 1000;
// A drag or a resize reports every frame; the window's place is written once it has settled.
const STATE_SAVE_MS = 500;
// System Settings > General > Login Items, where macOS asks the user to allow a login item.
// SMAppService.openSystemSettingsLoginItems() opens it too, but Electron has no binding for it.
const LOGIN_ITEMS_PANE = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';
// Open at login is read again when its box may be about to show, but not more often than this:
// on macOS each read is a call into the system's login item service.
const LOGIN_REREAD_MS = 500;

// Where the window points. Only a dev build honours DSUL_URL, and a dev server on localhost
// talks to PRODUCTION Supabase until scripts/local-setup.sh dev has run.
const START_URL = resolveStartUrl();
const START_ORIGIN = new URL(START_URL).origin;
// Supabase hosts whose authorize URL may be opened for a sign-in. Dev adds the local stack.
const SUPABASE_ORIGINS = app.isPackaged
  ? [policy.SUPABASE_ORIGIN]
  : [policy.SUPABASE_ORIGIN, process.env.DSUL_SUPABASE_URL || 'http://127.0.0.1:54321'];
// The offline page and the find bar go in as data: URLs, not loadFile. With the
// grantFileProtocolExtraPrivileges fuse off, file:// can't read inside app.asar, so a packaged
// loadFile fails with ERR_FILE_NOT_FOUND; the fuse stays off.
const dataUrl = (file) =>
  `data:text/html;charset=utf-8;base64,${fs.readFileSync(path.join(__dirname, file)).toString('base64')}`;
const OFFLINE_URL = dataUrl('offline.html');
const FIND_URL = dataUrl('find-bar.html');

let win = null;
let tray = null;
let trayMenu = null;
let loginReadAt = 0;
let isQuitting = false;
let shortcutRegistered = false;
let update = null; // { version, url } once GitHub has a newer release
let pending = null; // { kind: 'google' | 'email', until } while a sign-in may come back
let signInNoticeUntil = 0;
let appIcon = appIcons.DEFAULT_LOOK; // the look the Dock or window shows (lib/app-icon.cjs)
const seenCodes = new Set();
const queuedLinks = [];

// The window's size and place (lib/window-state.cjs). lastState is the state last written or
// opened with, and savedText its text, so an unchanged window writes nothing. openedAs is what
// the window was created at and what it reported straight after, so the difference is never
// saved as a move. Nothing is saved until the window has first been shown, so the restore's own
// resize and maximize never count as the user's, and nothing while the shell has it hidden
// (parked): its place was written as it closed.
let shown = false;
let openMaximized = false;
let lastState = null;
let savedText = '';
let openedAs = null;
let stateTimer = null;
let parked = false;

// A capture press is held here until the page in the window says it is listening. Readiness
// belongs to one document, so it resets whenever the main frame commits a new one, and a press
// made while a navigation is in flight waits for whichever document survives it.
let pendingCapture = false;
let captureReady = false;
let inflight = 0;

// The find bar (see "Find in page"). It is made, hidden, once the page first stops loading, and
// kept after that.
let findView = null;
let findReady = false; // its page has loaded, so it can be shown and sent to
let findOpen = false;
let findText = '';
let findSession = 0; // the request id of the findInPage call that started the shown search
let findMatch = null; // the active match's selectionArea, which the bar steps aside for

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
    // The window still exists here; the quit closes it next.
    saveState();
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
  appIcon = readAppIcon();
  // The Dock bounces the bundle's Aurora at launch either way; this swaps it as early as it can.
  if (IS_MAC) applyAppIcon(appIcon);
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
  // Where it was last left, fitted to the displays connected now.
  const { maximized, ...bounds } = openingPlacement();
  openMaximized = maximized;
  win = new BrowserWindow({
    ...bounds,
    minWidth: windowState.MIN_SIZE.width,
    minHeight: windowState.MIN_SIZE.height,
    show: false,
    title: 'dsul',
    backgroundColor: backgroundColor(),
    autoHideMenuBar: process.platform === 'win32',
    // macOS: no title bar; the traffic lights sit in the page's own top band
    // (lib/window-chrome.cjs). Windows and Linux keep the native frame.
    ...windowChrome(process.platform),
    // Off the Mac the window's icon is the taskbar's, so a Lime user never sees Aurora there.
    ...(IS_MAC ? {} : { icon: iconImage(appIcon) }),
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
  if ('x' in bounds) openedAs = { asked: bounds, got: win.getBounds() };

  win.once('ready-to-show', firstShow);
  // A slow network can hold the first paint for a long time; an empty window in the theme's
  // colour beats no window at all.
  setTimeout(firstShow, 4000);

  // In full screen the buttons live in the menu-bar strip, where placeLights leaves them alone,
  // so they are placed again on the way out. This is registered before the close handler's own
  // once('leave-full-screen'), so they are placed before a closing window hides.
  win.on('leave-full-screen', () => placeLights(true));
  // The find bar keeps clear of the band, which full screen takes away. These pass the new state
  // rather than trust isFullScreen() to read it yet.
  win.on('enter-full-screen', () => placeFind(true));
  win.on('leave-full-screen', () => placeFind(false));
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    // Closed to the tray or Dock, the window comes back with nothing found and no find bar. This
    // runs while it is still on screen and key, so the page takes the keyboard back from the bar
    // first. Never on 'hide', which on macOS means only that the window is out of sight.
    closeFind();
    // macOS keeps a hidden fullscreen window's Space, empty and black, and the next reveal can
    // land in it. So the window leaves fullscreen first and hides once it has. It is parked from
    // the start, so a quit during the animation can't save a frame from the middle of it.
    if (IS_MAC && win.isFullScreen()) {
      parked = true;
      win.once('leave-full-screen', park);
      win.setFullScreen(false);
    } else {
      park();
    }
  });
  // Hiding instead of closing must not hold up a Windows shutdown or log-off. Electron ends the
  // process as soon as this returns, before any quit event, so the window's place is saved here.
  win.on('session-end', () => {
    isQuitting = true;
    saveState();
  });
  for (const name of ['resize', 'move', 'maximize', 'unmaximize']) win.on(name, saveStateSoon);
  win.contentView.on('bounds-changed', () => {
    // A resize reflows the page, so the match the bar stepped aside for has moved. As Chrome's
    // does, the bar goes back to its corner until the next step.
    findMatch = null;
    placeFind();
  });
  nativeTheme.on('updated', () => {
    if (!win.isDestroyed()) win.setBackgroundColor(backgroundColor());
    if (findContents()) findView.setBackgroundColor(findBackground());
  });
  // Coming back to dsul is a cheap moment to catch an Open at login change made in System
  // Settings or Task Manager, before the tray menu next opens.
  win.on('focus', () => refreshLoginItem());
  win.on('focus', keepKeysOffClosedBar);

  const contents = win.webContents;
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) inflight += 1;
  });
  contents.on('did-navigate', (_event, url) => {
    inflight = Math.max(0, inflight - 1);
    captureReady = false;
    // An error page never fires did-navigate, so an app URL here means the app is back.
    if (isApp(url)) {
      // A launch at login usually beats the network, so its update check fails and the next is a
      // day away: coming back from the offline page checks again. Before stopOfflineRetry, which
      // clears the count.
      if (offlineTries > 0) checkForUpdate();
      stopOfflineRetry();
    }
    // A new document, the offline page included, has nothing the bar was finding.
    closeFind();
    // Each document comes in at its own zoom: Chromium keeps one per host, saved across launches,
    // and the offline page has its own, normally 100%. Electron has applied it by the time this
    // fires. Last, so a throw here can't skip the bookkeeping above.
    placeLights();
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
  // The find bar is made, hidden, once the page has had its turn, so the first Ctrl/⌘ F shows it
  // at once rather than after a new renderer has started (ensureFindView).
  contents.once('did-stop-loading', ensureFindView);
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
    closeFind();
    const now = Date.now();
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
    crashes.push(now);
    // A page that crashes on load would otherwise reload forever. Past three a minute it waits
    // for Open dsul.
    if (crashes.length <= 3) contents.reload();
  });
  contents.on('context-menu', (_event, params) => showContextMenu(contents, params));
  contents.on('found-in-page', onFoundInPage);

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
  if (!shown) {
    // A deep link, a second launch or the shortcut can come before the first paint.
    firstShow();
  } else {
    const wasParked = parked;
    parked = false;
    if (win.isMinimized()) win.restore();
    // Only a window the shell hid is ever moved here; one the user can see stays where it is.
    if (wasParked) refitWindow();
    win.show();
  }
  win.focus();
  // A global shortcut fires while another app is frontmost; macOS won't hand over focus without
  // this.
  if (IS_MAC) app.focus({ steal: true });
}

// The window's first appearance, from ready-to-show, the 4s fallback or an early bringForward,
// whichever comes first.
function firstShow() {
  if (shown || !win || win.isDestroyed()) return;
  parked = false;
  // A hidden window that is maximized appears already maximized, so no frame at its smaller size
  // shows first: one SW_SHOWMAXIMIZED on Windows, and on macOS a zoom before it is ordered in.
  // show() then focuses it; on macOS maximize() orders it in without focus, and on Windows it
  // already activates it.
  if (openMaximized) win.maximize();
  win.show();
  // Set after the show, so the restore's own maximize and resize are never saved as the user's.
  shown = true;
}

// Saves the window's place while it is still on screen, then hides it to the tray or Dock.
// Nothing more is saved until it is shown again: macOS answers for a hidden window from AppKit's
// idea of it, and its 'hide' event also fires whenever the window is merely covered, so neither
// is a time to read it. The full-screen close parks early, so the save here unparks first.
function park() {
  parked = false;
  saveState();
  parked = true;
  win.hide();
}

// ── Page zoom and the traffic lights ─────────────────────────────────────────

// macOS: the traffic lights follow page zoom (lib/window-chrome.cjs macLights). Electron keeps
// their position through its own redraws (focus, resize, theme), so this runs only where the zoom
// can have changed: a new document, a View menu zoom, and leaving full screen. Every other zoom
// source must come through zoomPage or call this, or the buttons wait for the next navigation.
function placeLights(leavingFullScreen = false) {
  if (!IS_MAC || !win || win.isDestroyed()) return;
  // In full screen the buttons are in the menu-bar strip, and moving them there makes them jump.
  // Leaving full screen skips the check rather than trust isFullScreen() to read false yet;
  // Electron redraws the buttons at that moment itself, so moving them then is no riskier.
  if (!leavingFullScreen && win.isFullScreen()) return;
  const want = macLights(win.webContents.getZoomFactor());
  const now = win.getWindowButtonPosition();
  if (now && now.x === want.x && now.y === want.y) return;
  win.setWindowButtonPosition(want);
}

// The View menu's zoom items. They zoom the window's own page and nothing else, and only while
// that window has focus: a view inside it can hold the keyboard focus (the find bar), and a zoom
// that went there would be saved under that view's URL and never reach the page. The roles these
// replace zoomed whatever had focus, without main hearing of it.
function zoomPage(focusedWindow, action) {
  if (!win || win.isDestroyed() || focusedWindow !== win) return;
  const contents = win.webContents;
  contents.zoomLevel = nextZoomLevel(contents.zoomLevel, action);
  placeLights();
}

// ── Window size and place ────────────────────────────────────────────────────

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const displayAreas = () =>
  windowState.displayAreas(screen.getAllDisplays(), screen.getPrimaryDisplay());

// Where the window opens. The screen module only answers after `ready`, which is when
// createWindow runs.
function openingPlacement() {
  let saved = null;
  try {
    saved = windowState.parseWindowState(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    // No file yet: the first launch, or a new profile.
  }
  const { workAreas, primary } = displayAreas();
  const placement = windowState.placeWindow(saved, workAreas, primary);
  const { maximized, ...bounds } = placement;
  // Without a display to measure, the placement has no position and there is nothing to keep.
  if ('x' in bounds) {
    lastState = { bounds, maximized };
    const text = windowState.serializeWindowState(lastState);
    // A window that opens where it was saved rewrites nothing until it moves.
    if (saved && windowState.serializeWindowState(saved) === text) savedText = text;
  }
  return placement;
}

function saveStateSoon() {
  if (!shown || parked) return;
  clearTimeout(stateTimer);
  stateTimer = setTimeout(saveState, STATE_SAVE_MS);
}

function saveState() {
  clearTimeout(stateTimer);
  stateTimer = null;
  if (!shown || parked || !win || win.isDestroyed()) return;
  const next = windowState.windowStateToSave(
    {
      bounds: win.getBounds(),
      normalBounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      minimized: win.isMinimized(),
      fullScreen: win.isFullScreen(),
    },
    lastState,
    process.platform,
    openedAs,
  );
  if (!next) return;
  lastState = next;
  const text = windowState.serializeWindowState(next);
  if (text === savedText) return;
  // Synchronous, because a Windows log-off ends the process the moment its handler returns. A
  // write cut short by a crash leaves a file parseWindowState refuses, which costs one launch its
  // place.
  try {
    fs.writeFileSync(stateFile(), text);
    savedText = text;
  } catch {
    // A full or read-only disk costs the next launch its place, nothing more.
  }
}

// A window can sit hidden in the tray for days, and the display it was on can go meanwhile. One
// whose top band is out of reach on every display now is placed again by the launch rule; any
// other is left exactly where it is. A maximized window is left to the OS.
function refitWindow() {
  if (!win.isNormal()) return;
  const { workAreas, primary } = displayAreas();
  const now = win.getBounds();
  if (windowState.grabbable(now, workAreas)) return;
  const { maximized, ...bounds } = windowState.placeWindow(
    { bounds: now, maximized: false },
    workAreas,
    primary,
  );
  if (!('x' in bounds)) return;
  win.setBounds(bounds);
  if (maximized) win.maximize();
}

// The offline page is the only data: URL the window's page ever shows. (The find bar is one too,
// in a webContents of its own.)
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
  // A menu click passes the window that had focus; zoomPage acts only when that is dsul's own.
  const zoom = (action) => (_item, focusedWindow) => zoomPage(focusedWindow, action);
  const view = {
    label: 'View',
    submenu: [
      // The app hands Ctrl/⌘ +, − and 0 back to the browser outside the week views, so these
      // are what zoom the page there. Not the zoom roles: a role zooms without main hearing of it,
      // and on a Mac the traffic lights follow the zoom (zoomPage). The labels, accelerators and
      // step are the roles' own.
      { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: zoom('reset') },
      { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: zoom('in') },
      // Zoom In's own accelerator is Plus, which needs Shift on most keyboards.
      {
        label: 'Zoom In',
        accelerator: 'CommandOrControl+=',
        visible: false,
        acceleratorWorksWhenHidden: true,
        click: zoom('in'),
      },
      { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: zoom('out') },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
    ],
  };
  // macOS needs the Edit roles, or ⌘C/V/X/A stop working in text fields. Find goes right after
  // Select All, where AppKit puts it: the role builds its usual items, and Find is added to them
  // rather than the whole menu being spelled out.
  const edit = new MenuItem({ role: 'editMenu' });
  const actions = { open: openFind, next: () => stepFind(true), previous: () => stepFind(false) };
  const find = findBar
    .findMenu(process.platform)
    .map(({ action, ...item }) => new MenuItem({ ...item, click: () => actions[action]() }));
  const place = findBar.findMenuPlace(edit.submenu.items);
  let at = place.at;
  if (place.separator) edit.submenu.insert(at++, new MenuItem({ type: 'separator' }));
  if (IS_MAC) edit.submenu.insert(at, new MenuItem({ label: 'Find', submenu: find }));
  else for (const item of find) edit.submenu.insert(at++, item);
  const template = IS_MAC
    ? [{ role: 'appMenu' }, edit, view, { role: 'windowMenu' }]
    : [{ role: 'fileMenu' }, edit, view];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Find in page ─────────────────────────────────────────────────────────────

// Chromium's find bar is browser UI, so Electron has none. dsul's is a small page of its own
// (find-bar.html) in a view over the window's top-right corner, never part of do.dsul.app:
// Chromium's find counts the text in <input> values, so a bar in the page would find its own
// query, and it would need the bridge to reach findInPage. It opens from the Edit menu (Ctrl/⌘ F):
// a menu accelerator fires only for a key the page left alone, on macOS and Windows alike, so the
// settings search and the Organize filter keep their own Ctrl/⌘ F. Never before-input-event,
// which comes before the page.

function findContents() {
  return findView && !findView.webContents.isDestroyed() ? findView.webContents : null;
}

// harden() runs while the view is being constructed, before findView is set, so its guards ask
// this when an event comes rather than at creation.
function isFindBar(contents) {
  return !!findView && contents === findView.webContents;
}

function findBackground() {
  return nativeTheme.shouldUseDarkColors ? findBar.FIND_BAR_BG.dark : findBar.FIND_BAR_BG.light;
}

// Makes the bar, hidden, or reloads one whose renderer has gone. Its page is a data: URL, so the
// load is quick, but it is a new renderer: findReady says when it can be shown and sent to.
function ensureFindView() {
  if (!win || win.isDestroyed()) return;
  const existing = findContents();
  if (existing) {
    // A bar whose renderer has gone loads again on the next Ctrl/⌘ F, not on its own. Not
    // isCrashed(), which is false after a clean exit.
    if (!findReady && !existing.isLoading()) load(existing, FIND_URL);
    return;
  }
  findView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'find-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  findView.setBackgroundColor(findBackground());
  findView.setBorderRadius(findBar.FIND_BAR.radius);
  findView.setVisible(false);
  const contents = findView.webContents;
  contents.on('focus', keepKeysOffClosedBar);
  contents.on('did-finish-load', () => {
    findReady = true;
    // Asked for while it loaded: shown already (openFind), and now filled and searched.
    if (findOpen) showFind(true);
  });
  contents.on('render-process-gone', (_event, details) => {
    findReady = false;
    if (details.reason === 'clean-exit') return;
    // A dead bar can't say it had the keyboard, so an open one hands it to the page if the
    // window has it. A hidden one moves nothing: focusing the page brings a Mac window forward.
    const wasOpen = findOpen;
    closeFind();
    if (wasOpen && win && !win.isDestroyed() && win.isFocused()) win.webContents.focus();
  });
  contents.on('context-menu', (_event, params) => showContextMenu(contents, params));
  win.contentView.addChildView(findView);
  load(contents, FIND_URL);
}

// A closed bar never keeps the keyboard. Made as the window first comes to the front, the hidden
// bar can be handed the focus (about one launch in two under Linux), and then nothing typed would
// reach the page until a click. Off Mac the focus also stays in a child view when the window comes
// back, so the window's own focus asks too. Checked once the focus change has finished, which a
// call from inside it doesn't undo, and only while the window has focus: focusing the page would
// bring a window that hasn't to the front.
function keepKeysOffClosedBar() {
  setTimeout(() => {
    const bar = findContents();
    if (findOpen || !bar || !bar.isFocused() || !win || win.isDestroyed() || !win.isFocused()) return;
    win.webContents.focus();
  }, 0);
}

// The bar hangs from the top-right corner, below the macOS band unless the window is full screen,
// and steps aside for the active match. `fullScreen` comes from the full-screen events; everyone
// else asks the window.
function placeFind(fullScreen) {
  if (!findView || !win || win.isDestroyed()) return;
  const full = typeof fullScreen === 'boolean' ? fullScreen : win.isFullScreen();
  const bounds = findBar.barBounds(win.contentView.getBounds(), IS_MAC && !full ? TITLE_BAND_PX : 0);
  findView.setBounds(findBar.avoidMatch(bounds, findMatch));
}

// Edit > Find. Asked for again while open, it selects the bar's text.
function openFind() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const contents = win.webContents;
  // Nothing to search on the offline page or in a crashed renderer.
  if (onOfflinePage(contents) || contents.isCrashed()) return;
  const opening = !findOpen;
  findOpen = true;
  ensureFindView();
  if (findReady) {
    showFind(opening);
    return;
  }
  // Its page is still loading (the first press beat it, or its renderer had gone). The bar takes
  // the keyboard now anyway, so what is typed meanwhile is lost rather than reaching the page's
  // own one-key shortcuts (n opens Add, Backspace deletes the hovered item). did-finish-load
  // fills it.
  placeFind();
  findView.setVisible(true);
  findView.webContents.focus();
}

// `search`: newly opened, so it searches again for what it shows, as Chrome's does. Already
// open, the current match stays where it is.
function showFind(search) {
  placeFind();
  findView.setVisible(true);
  findView.webContents.focus();
  findView.webContents.send('dsul-find:show', findText);
  if (search) startFind(findText);
}

function startFind(text) {
  findText = text;
  const contents = win.webContents;
  if (!text) {
    findSession = 0;
    findMatch = null;
    contents.stopFindInPage('clearSelection');
    placeFind();
    sendFindCount({ text: '', none: false });
    return;
  }
  // Electron's findNext: true is Chromium's new_session: a new search, not the next match.
  findSession = contents.findInPage(text, { findNext: true });
}

// Find Next and Previous: Ctrl/⌘ G and Shift, F3 on Windows, Enter and Shift+Enter in the bar.
// With the bar closed, they open it on the last search.
function stepFind(forward) {
  if (!findOpen) {
    openFind();
    return;
  }
  if (!findText || !win || win.isDestroyed()) return;
  win.webContents.findInPage(findText, { forward, findNext: false });
}

// Every close, the person's Esc and × included, ends with nothing selected. keepSelection (Chrome's
// Esc) would select the match, or focus the field, button or link it is in, and then the next key
// typed would replace a matched title in a field that autosaves. activateSelection would also
// click it. If the bar had the keyboard, the page takes it back first, while the bar still holds
// it: hiding a view doesn't move the focus anywhere. Never in a hidden window, because focusing
// the page brings a Mac window forward.
function closeFind() {
  if (!findOpen) return;
  findOpen = false;
  findSession = 0;
  findMatch = null;
  const bar = findContents();
  const hadFocus = !!bar && bar.isFocused();
  if (win && !win.isDestroyed()) {
    if (!win.webContents.isCrashed()) win.webContents.stopFindInPage('clearSelection');
    if (hadFocus && win.isVisible()) win.webContents.focus();
  }
  if (bar) findView.setVisible(false);
}

function onFoundInPage(_event, result) {
  if (!findOpen || !findBar.isCurrentReply(result, findSession)) return;
  findMatch = result.selectionArea || null;
  placeFind();
  sendFindCount(findBar.countLabel(result));
}

function sendFindCount(label) {
  const contents = findContents();
  if (contents && findReady) contents.send('dsul-find:count', label);
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
  // The app never moves or resizes its own window. A page that did (window.moveTo, resizeTo)
  // would have its doing saved and brought back at every launch.
  contents.on('content-bounds-updated', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // A same-origin new window (⌘-click, middle-click) does nothing in v1: a load in the main
    // window would tear down the store and the undo stack. The find bar has no links; whatever
    // asks from there opens nothing.
    if (!isApp(url) && !isFindBar(contents)) openOutside(url);
    return { action: 'deny' };
  });
}

function guardNavigation(event, contents) {
  // The find bar never navigates. Without this an app URL would pass below, and the offline
  // retry would load the app into the bar.
  if (isFindBar(contents)) {
    event.preventDefault();
    return;
  }
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

  // The find bar's three messages (find-preload.cjs).
  ipcMain.on('dsul-find:query', (event, text) => {
    if (fromFindBar(event) && findOpen) startFind(findBar.cleanQuery(text));
  });
  ipcMain.on('dsul-find:step', (event, forward) => {
    if (fromFindBar(event) && findOpen) stepFind(forward !== false);
  });
  ipcMain.on('dsul-find:close', (event) => {
    if (fromFindBar(event)) closeFind();
  });

  // The page's Settings → Look choice. A repeat (every sign-in sends one) touches nothing.
  ipcMain.handle('dsul:set-app-icon', (event, look) => {
    if (!fromApp(event)) return false;
    const next = appIcons.parseLook(look);
    if (!next) return false;
    if (next !== appIcon) {
      appIcon = next;
      writeAppIcon();
      applyAppIcon(next);
    }
    return true;
  });
}

// The find bar's channels answer only the bar's own page, as fromApp keeps the bridge to the app's.
function fromFindBar(event) {
  if (!findView || event.sender !== findView.webContents) return false;
  const frame = event.senderFrame;
  const main = event.sender.mainFrame;
  return (
    !!frame &&
    frame.processId === main.processId &&
    frame.routingId === main.routingId &&
    frame.url === FIND_URL
  );
}

// ── App icon ─────────────────────────────────────────────────────────────────

// The look is kept on disk so the next launch starts on it. It is not secret, so no 0o600.
const appIconFile = () => path.join(app.getPath('userData'), 'app-icon.json');

function readAppIcon() {
  try {
    return appIcons.parseLook(JSON.parse(fs.readFileSync(appIconFile(), 'utf8')).look) || appIcons.DEFAULT_LOOK;
  } catch {
    return appIcons.DEFAULT_LOOK;
  }
}

function writeAppIcon() {
  try {
    fs.writeFileSync(appIconFile(), JSON.stringify({ look: appIcon }));
  } catch {
    // This run still shows it; the next launch starts on the previous look.
  }
}

// build/app-icon-*.png is packed for this (electron-builder.config.cjs files).
function iconImage(look) {
  return nativeImage.createFromPath(path.join(__dirname, 'build', appIcons.iconFile(look)));
}

// macOS: the Dock and ⌘-Tab, for as long as the app runs. Elsewhere: the window and its taskbar
// button. A missing file is an empty image, which changes nothing rather than blanking the icon.
function applyAppIcon(look) {
  const img = iconImage(look);
  if (img.isEmpty()) return;
  if (IS_MAC) app.dock?.setIcon(img);
  else if (win && !win.isDestroyed()) win.setIcon(img);
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
  // The launcher opens in the page, so the page takes the keyboard, wherever it was: a Mac
  // window coming forward can hand it back to the bar. reveal is bringing the window forward
  // already, so this can't pull a hidden one into view.
  closeFind();
  if (win && !win.isDestroyed()) win.webContents.focus();
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
  // Both OSes read the menu's ticks as it opens, and the pointer reaches the icon before any
  // click that opens it, so this is when Open at login is read again. Electron emits it on macOS
  // and Windows (on Windows ahead of the click, which is queued behind it).
  tray.on('mouse-enter', () => refreshLoginItem());
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
  // With nothing to offer (a dev build, Linux), the two separators fold into one.
  items.push(
    { type: 'separator' },
    ...loginMenuItems(readLoginItem()),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );
  trayMenu = Menu.buildFromTemplate(items);
  tray.setContextMenu(trayMenu);
}

// ── Open at login ────────────────────────────────────────────────────────────

// lib/login-item.cjs says what each platform's reading means, and why it is read back rather than
// remembered. Any throw means no box, never a tray menu that fails to build.
function readLoginItem() {
  loginReadAt = Date.now();
  try {
    const settings = app.getLoginItemSettings(loginItemQuery(process.platform, process.execPath));
    return loginItemView(process.platform, settings, {
      packaged: app.isPackaged,
      // A macOS-only call, so IS_MAC must stay ahead of it.
      inApplications: IS_MAC && app.isInApplicationsFolder(),
    });
  } catch {
    return NOT_OFFERED;
  }
}

// The tray's Open at login entry. syncLoginItem finds the box by its id.
function loginMenuItems(view) {
  if (!view.offered) return [];
  const items = [
    {
      id: LOGIN_ITEM_ID,
      label: 'Open at login',
      type: 'checkbox',
      checked: view.checked,
      enabled: view.enabled,
      // Electron flips a checkbox before calling its click, so item.checked is the opposite of
      // what the box showed: what the user asked for, even if the tick had gone stale.
      click: (item) => setLoginItem(item.checked),
    },
  ];
  if (view.note) items.push({ label: view.note, enabled: false });
  return items;
}

// Reads the setting again when the box may be about to show, unless it was read moments ago.
function refreshLoginItem() {
  if (Date.now() - loginReadAt < LOGIN_REREAD_MS) return;
  syncLoginItem(readLoginItem());
}

// A menu reads its items' ticks as it opens, so changing the existing box is enough. The menu is
// never rebuilt for this: on macOS that could pull an open menu out from under the user. A
// reading that failed keeps the last good tick rather than clearing it.
function syncLoginItem(view) {
  if (!view.offered || !trayMenu) return;
  const box = trayMenu.getMenuItemById(LOGIN_ITEM_ID);
  if (box) box.checked = view.checked;
}

function setLoginItem(open) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings(loginItemRequest(process.platform, open, APP_ID));
  } catch {
    // Read back below either way.
  }
  // Electron reports no failure, so the box shows what the OS reads back, not what was asked.
  const view = readLoginItem();
  syncLoginItem(view);
  if (showLoginItemsPane(process.platform, open, view)) openLoginItemsPane();
}

function openLoginItemsPane() {
  // A fixed URL, never one from a page, so it skips openOutside's scheme check.
  shell.openExternal(LOGIN_ITEMS_PANE).catch(() => {});
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
