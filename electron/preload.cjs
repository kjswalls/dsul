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

contextBridge.exposeInMainWorld('dsulDesktop', {
  version: 1,
  shellVersion: versionArg ? versionArg.slice(VERSION_ARG.length) : '',
  electronVersion: process.versions.electron,
  platform: process.platform,

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
  // to the system browser and a Google sign-in is armed.
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
});
