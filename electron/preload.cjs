'use strict';

// window.dsulDesktop: everything the page can reach in the shell, and so everything an XSS on
// do.dsul.app could reach too. Keep it this small, and never expose a generic send or invoke.
// The preload is sandboxed, so it can require nothing but 'electron'; main checks every message
// against the sending frame (main.cjs fromApp), because this file also runs on offline.html.
// The shape is mirrored by lib/desktop.ts in the web app: change both or neither.

const { contextBridge, ipcRenderer } = require('electron');

// Main passes its version on the command line; a sandboxed preload can't ask app.getVersion().
const VERSION_ARG = '--dsul-shell-version=';
const versionArg = process.argv.find((a) => typeof a === 'string' && a.startsWith(VERSION_ARG));

const listeners = new Set();
// A press that arrives between an unsubscribe and the next subscribe goes to that subscriber
// rather than nowhere.
let held = false;

// One channel listener, calling the page's callbacks with no arguments, so the IpcRendererEvent
// (and its sender) never reaches the page.
ipcRenderer.on('dsul:quick-capture', () => {
  if (listeners.size === 0) {
    held = true;
    return;
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[dsul] quick capture listener failed', err);
    }
  }
});

// Reminder clicks and wakes, each to the page's callbacks with only the plain data main sent.
const notificationListeners = new Set();
const wakeListeners = new Set();
const pocketListeners = new Set();
ipcRenderer.on('dsul:notification', (_event, message) => {
  for (const listener of [...notificationListeners]) {
    try {
      listener(message);
    } catch (err) {
      console.error('[dsul] notification listener failed', err);
    }
  }
});
// A pocket button, as { action, id }: main has already checked the id is the one it shows.
ipcRenderer.on('dsul:pocket-action', (_event, message) => {
  const plain = { action: message && message.action, id: message && message.id };
  for (const listener of [...pocketListeners]) {
    try {
      listener(plain);
    } catch (err) {
      console.error('[dsul] pocket listener failed', err);
    }
  }
});
ipcRenderer.on('dsul:wake', () => {
  for (const listener of [...wakeListeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[dsul] wake listener failed', err);
    }
  }
});

contextBridge.exposeInMainWorld('dsulDesktop', {
  version: 1,
  shellVersion: versionArg ? versionArg.slice(VERSION_ARG.length) : '',
  electronVersion: process.versions.electron,
  platform: process.platform,
  // The providers openAuthUrl accepts: policy.OAUTH_PROVIDERS, which a sandboxed preload can't
  // require, so it is copied here and a test holds the two together. Added after version 1
  // shipped, so the page treats a missing list as Google only.
  authProviders: ['google', 'apple'],

  // Subscribes first and only then tells main this page is listening: main holds a press made
  // during a page load until it hears this.
  onQuickCapture(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = () => cb();
    listeners.add(listener);
    ipcRenderer.send('dsul:capture-ready');
    if (held) {
      held = false;
      setTimeout(() => {
        if (listeners.has(listener)) listener();
      }, 0);
    }
    return () => {
      listeners.delete(listener);
    };
  },

  // Main checks the URL (policy.checkAuthorizeUrl) before it opens anything. True means it went
  // to the system browser and a Google or Apple sign-in is armed.
  openAuthUrl(url) {
    return ipcRenderer
      .invoke('dsul:open-auth-url', typeof url === 'string' ? url : '')
      .then((ok) => ok === true);
  },

  // Call only after signInWithOtp resolves: that is when the verifier cookie exists to be flushed.
  armEmailSignIn() {
    return ipcRenderer.invoke('dsul:arm-email').then(() => undefined);
  },

  // True once after a dsul:// sign-in handoff, so the page can say whose account it opened.
  takeSignInNotice() {
    return ipcRenderer.invoke('dsul:take-sign-in-notice').then((v) => v === true);
  },

  // The Dock or taskbar icon's look (Settings → Look). Anything but 'lime' is Aurora. Added
  // after version 1 shipped, so the page checks it exists rather than bumping the version.
  setAppIcon(look) {
    return ipcRenderer
      .invoke('dsul:set-app-icon', look === 'lime' ? 'lime' : 'aurora')
      .then((ok) => ok === true);
  },

  // Reminders (memory/plans/reminders-platforms.md §5.2, PR-1c). Added after version 1 shipped,
  // like setAppIcon, so the page feature-detects each one. Main checks every notification
  // (lib/notify.cjs) and answers false for one it refused.
  notify(spec) {
    return ipcRenderer.invoke('dsul:notify', spec).then((ok) => ok === true);
  },
  closeNotification(tag) {
    return ipcRenderer.invoke('dsul:notify-close', typeof tag === 'string' ? tag : '').then((ok) => ok === true);
  },
  // Seconds since the last input anywhere on the computer, or null when main would not say.
  idleSeconds() {
    return ipcRenderer.invoke('dsul:idle-seconds').then((s) => (typeof s === 'number' ? s : null));
  },
  // 'ok', 'unsupported' or 'unsigned' (a Mac build whose notifications nobody would see).
  notifyProbe() {
    return ipcRenderer
      .invoke('dsul:notify-probe')
      .then((v) => (v === 'ok' || v === 'unsigned' ? v : 'unsupported'));
  },
  onNotification(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = (message) => cb(message);
    notificationListeners.add(listener);
    return () => {
      notificationListeners.delete(listener);
    };
  },

  // Do stuff's pocket (main.cjs "Pocket"). Added after version 1 shipped, like setAppIcon, so the
  // page feature-detects each one. setPocket(null) says nothing is current, which closes it.
  setPocket(state) {
    ipcRenderer.send('dsul:pocket-state', state && typeof state === 'object' ? state : null);
  },
  openPocket() {
    return ipcRenderer.invoke('dsul:pocket-open').then((ok) => ok === true);
  },
  onPocketAction(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = (message) => cb(message);
    pocketListeners.add(listener);
    return () => {
      pocketListeners.delete(listener);
    };
  },
  onWake(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = () => cb();
    wakeListeners.add(listener);
    return () => {
      wakeListeners.delete(listener);
    };
  },
});
